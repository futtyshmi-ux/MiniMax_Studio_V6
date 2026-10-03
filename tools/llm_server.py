"""
llm_server.py — local LLM bridge for MiniMax H3 Studio (правка 24).

Runs INSIDE the ComfyUI embedded python (llama-cpp-python is already
installed there — CPU + CUDA backends). Standard library only besides
llama_cpp itself: no FastAPI/uvicorn dependency.

Endpoints (127.0.0.1 only):
  GET  /health    -> {"ok": true, "model": ..., "gpu_layers": N}
  POST /chat      -> SSE stream of {"delta": "..."} chunks, ends with {"done": true}
                     body: {"messages": [{"role","content"}], "max_tokens"?, "temperature"?,
                             "stop"?: [str], "stream"?: bool}
                     stream:false -> plain JSON {"ok": true, "text": "...", "finish_reason": ...}
                     (используется для аудио-проб надёжности — см. src/lib/llm-audio-guard.ts)
  POST /abort     -> stop the current generation (best effort)
  POST /shutdown  -> graceful shutdown (releases VRAM, then exits)

Auto-exits after --idle-sec without requests (frees RAM/VRAM).
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── args ──
ap = argparse.ArgumentParser()
ap.add_argument('--model', required=True)
ap.add_argument('--mmproj', default=None, help='Path to multimodal projector (mmproj/MTP) for vision')
ap.add_argument('--port', type=int, default=8090)
ap.add_argument('--gpu-layers', type=int, default=0, help='0 = CPU only, -1 = auto (VRAM-capped)')
ap.add_argument('--max-vram-percent', type=int, default=90,
               help='Max %% of total VRAM to use (default 90, правка 60: back to the original 90%)')
ap.add_argument('--ctx', type=int, default=4096)
# (правка 109) KV cache quantization: off (fp16, default) | q8_0 | q5_1 | q4_0
ap.add_argument('--kv-cache', default='off', choices=['off', 'q8_0', 'q5_1', 'q4_0'],
               help='KV cache quantization (off=fp16, default)')
ap.add_argument('--threads', type=int, default=6)
ap.add_argument('--idle-sec', type=int, default=600)
args = ap.parse_args()

# (правка 109) KV cache quantization -> int enum type из закреплённой сборки
# llama-cpp-python 0.3.46 (_ggml.py): off -> None (fp16), q8_0 -> 8, q5_1 -> 7,
# q4_0 -> 2. Применяется одинаково к K и V (type_k = type_v).
KV_TYPE_MAP = {'off': None, 'q8_0': 8, 'q5_1': 7, 'q4_0': 2}
kv_type = KV_TYPE_MAP[args.kv_cache]

# ── Ensure CUDA runtime DLLs are findable ──────────────────────────────
# llama-cpp-python's ggml-cuda.dll needs cublas/cudart/cufft/cublasLt at
# load time. PyTorch ships them in torch/lib/. We copy the required DLLs
# into llama_cpp/lib/ so the Windows loader finds them automatically
# (no PATH manipulation needed, fully portable).
import os, sys, shutil
if sys.platform == 'win32':
    try:
        import torch, llama_cpp
        _torch_lib = os.path.join(os.path.dirname(torch.__file__), 'lib')
        _llama_lib = os.path.join(os.path.dirname(llama_cpp.__file__), 'lib')
        _cuda_dlls = ['cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll', 'cufft64_12.dll']
        for _dll in _cuda_dlls:
            _src = os.path.join(_torch_lib, _dll)
            _dst = os.path.join(_llama_lib, _dll)
            if os.path.isfile(_src) and not os.path.isfile(_dst):
                shutil.copy2(_src, _dst)
                print(f'[llm] copied {_dll} to llama_cpp/lib/', flush=True)
    except ImportError:
        pass  # torch or llama_cpp not available — fall back to CPU

print(f'[llm] loading model: {args.model} (gpu_layers={args.gpu_layers}, ctx={args.ctx}, kv_cache={args.kv_cache}, mmproj={args.mmproj or "none"})', flush=True)

from llama_cpp import Llama  # noqa: E402

# GGUF value-type maps (vtype -> size in bytes; 'S' = string, 'A' = array).
# IMPORTANT: v3 renumbered the enum vs v2 (verified against real files):
#   v2: 4=I16, 6=I32, 7=F32, 8=U64, 9=I64, 10=STRING, 11=ARRAY, 12=F16, 13=F64
#   v3: 4=I32, 5=U32, 6=F32, 7=U8,      8=STRING, 9=ARRAY,    12=F16, 13=F64
#   (v3 types 10/11 = 64-bit ints — not observed in the wild yet, sized safely)
_GGUF_V2_SIZES = {0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4,
                  8: 8, 9: 8, 10: 'S', 11: 'A', 12: 2, 13: 8}
_GGUF_V3_SIZES = {0: 1, 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1,
                  8: 'S', 9: 'A', 10: 8, 11: 8, 12: 2, 13: 8}
_GGUF_MAX_STR = 200_000_000   # sanity cap: a single string can't be 200MB
_GGUF_MAX_ARR = 10_000_000    # sanity cap: array elements


def _read_gguf_meta(model_path):
    """Read architecture metadata from a GGUF file header (v2 and v3).

    Returns dict: block_count, embedding_length, head_count, head_count_kv.
    head_count_kv is a scalar (max element when the file stores it as a
    per-layer array — Gemma-4 style hybrid attention). Missing -> None.

    Arrays (both versions): uint32 element-type + uint64 count + inline
    elements; strings: uint64 length + bytes. Recursion-safe.
    """
    import struct

    result = {
        'block_count': None,
        'embedding_length': None,
        'head_count': None,
        'head_count_kv': None,
    }

    def _skip_value(f, vtype, sizes, depth):
        if depth > 4:
            raise ValueError('array nesting too deep')
        spec = sizes.get(vtype)
        if spec is None:
            raise ValueError(f'unknown vtype {vtype}')
        if spec == 'S':
            str_len = struct.unpack('<Q', f.read(8))[0]
            if str_len > _GGUF_MAX_STR:
                raise ValueError('string too long')
            f.read(str_len)
            return None
        if spec == 'A':
            etype = struct.unpack('<I', f.read(4))[0]
            count = struct.unpack('<Q', f.read(8))[0]
            if count > _GGUF_MAX_ARR:
                raise ValueError('array too long')
            vals = []
            for _ in range(count):
                vals.append(_skip_value(f, etype, sizes, depth + 1))
            return vals
        f.read(spec)
        return None

    def _read_int(f, vtype, sizes):
        """Read a scalar integer value (any int vtype). Returns int or None."""
        spec = sizes.get(vtype)
        if spec in (1, 2, 4, 8):
            raw = f.read(spec)
            return int.from_bytes(raw, 'little', signed=False)
        return None

    try:
        with open(model_path, 'rb') as f:
            if f.read(4) != b'GGUF':
                return result
            version = struct.unpack('<I', f.read(4))[0]
            f.read(8)  # tensor count (not needed)
            kv_count = struct.unpack('<Q', f.read(8))[0]
            if kv_count > 100_000:
                return result
            sizes = _GGUF_V3_SIZES if version >= 3 else _GGUF_V2_SIZES

            for _ in range(kv_count):
                key_len = struct.unpack('<Q', f.read(8))[0]
                if key_len > 1024:
                    break
                key = f.read(key_len).decode('utf-8', errors='replace')
                vtype = struct.unpack('<I', f.read(4))[0]

                target = None
                if result['block_count'] is None and key.endswith('.block_count'):
                    target = 'block_count'
                elif result['embedding_length'] is None and key.endswith('.embedding_length'):
                    target = 'embedding_length'
                elif result['head_count'] is None and key.endswith('.attention.head_count'):
                    target = 'head_count'
                elif result['head_count_kv'] is None and key.endswith('.attention.head_count_kv'):
                    target = 'head_count_kv'

                if target is not None:
                    spec = sizes.get(vtype)
                    if spec in (1, 2, 4, 8):
                        result[target] = _read_int(f, vtype, sizes)
                    elif spec == 'A':
                        # per-layer array (v3 hybrid models) — take the max
                        # element (conservative for VRAM estimates)
                        etype = struct.unpack('<I', f.read(4))[0]
                        count = struct.unpack('<Q', f.read(8))[0]
                        if count > _GGUF_MAX_ARR:
                            break
                        vals = []
                        for _e in range(count):
                            esp = sizes.get(etype)
                            if esp in (1, 2, 4, 8):
                                vals.append(_read_int(f, etype, sizes))
                            else:
                                _skip_value(f, etype, sizes, 1)
                        vals = [v for v in vals if v is not None]
                        if vals:
                            result[target] = max(vals)
                    else:
                        _skip_value(f, vtype, sizes, 0)
                    continue

                _skip_value(f, vtype, sizes, 0)
    except Exception:
        pass

    return result


def _calc_max_gpu_layers():
    """Calculate max GPU layers that fit in --max-vram-percent of total VRAM
    (правка 49 introduced the cap; правка 60: default 90% — the user-visible
    hard cap; rest of the layers stay on CPU).

    Also fixed here (правка 49): the GGUF header parser was written for v2
    and silently misread v3 files (gemma-4-12b Q4_K_M) — all metadata came
    back None, so the cap fell back to a loose 40-layer heuristic with zero
    KV estimate and over-filled VRAM (>94%) -> lag. Now v2+v3 are both
    parsed correctly (v3 renumbered vtypes: 8=STRING, 9=ARRAY, ...).

    Accounts for:
      - Weight memory: n_layers_gpu × per_layer_weight
      - KV cache memory: n_layers_gpu × per_layer_kv (scales with GPU layer count!)
      - CUDA context + cuBLAS workspaces + llama.cpp buffers (~768MB)

    Estimates are intentionally slightly conservative (KV safety margin),
    because under-reserving VRAM causes heavy lag (the original complaint).

    Returns the number of layers, -1 if everything fits (all on GPU),
    or None if calculation is impossible.
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return 0
        total_vram = torch.cuda.get_device_properties(0).total_memory
    except Exception:
        return None

    budget = int(total_vram * args.max_vram_percent / 100)

    try:
        model_size = os.path.getsize(args.model)
    except Exception:
        return None

    # Read GGUF metadata for accurate per-layer KV cache estimation
    meta = _read_gguf_meta(args.model)
    n_layers = meta['block_count']
    if n_layers is None or n_layers <= 0:
        n_layers = 40  # heuristic fallback

    # Per-layer weight size
    per_layer_weight = model_size / n_layers

    # Per-layer KV cache size:
    #   KV per layer = 2 (K+V) × n_ctx × n_kv_heads × head_dim × 2 (fp16)
    #   head_dim = n_embd / n_heads
    n_embd = meta['embedding_length']
    n_heads = meta['head_count']
    n_kv_heads = meta['head_count_kv']

    per_layer_kv = 0
    if n_embd and n_heads and n_heads > 0:
        if n_kv_heads is None:
            n_kv_heads = n_heads  # MHA (no GQA)
        head_dim = n_embd // n_heads
        # 2 (K+V) × n_ctx × kv_heads × head_dim × 2 bytes (fp16)
        per_layer_kv = 2 * args.ctx * n_kv_heads * head_dim * 2

    # Safety margin: Gemma-3/4 use an extended head_dim (e.g. 256) that is
    # larger than n_embd/n_heads (240), plus KV-cache alignment/padding in
    # llama.cpp. 1.25 keeps the estimate on the safe side (under-reserving
    # VRAM = lag, the bug we are fixing).
    KV_SAFETY = 1.25
    per_layer_kv = int(per_layer_kv * KV_SAFETY)

    # (правка 109) Квантизация KV-кэша уменьшает размер кэша на слой:
    # q8_0 ~0.55, q5_1 ~0.45, q4_0 ~0.30 от fp16. Коэффициенты консервативны
    # (завышены) -> меньше слоёв на GPU -> безопаснее по VRAM.
    KV_QUANT_FACTOR = {'off': 1.0, 'q8_0': 0.55, 'q5_1': 0.45, 'q4_0': 0.30}
    per_layer_kv = int(per_layer_kv * KV_QUANT_FACTOR.get(args.kv_cache, 1.0))

    # CUDA context + cuBLAS workspaces + llama.cpp internal buffers
    OVERHEAD = 768 * 1024 * 1024  # ~768MB

    # Per-layer total = weight + kv_cache (both scale with GPU layer count)
    per_layer_total = per_layer_weight + per_layer_kv

    available = budget - OVERHEAD
    if available <= 0:
        return 0

    max_layers = max(0, int(available / per_layer_total))

    # If all layers fit, signal "all on GPU"
    if max_layers >= n_layers:
        max_layers = -1

    # Log detailed breakdown
    kv_detail = (f'kv/layer={per_layer_kv // (1024**2)}MB '
                 f'(kv_heads={n_kv_heads}, embd={n_embd}, heads={n_heads}) ')
    print(
        f'[llm] VRAM cap: total={total_vram / (1024**3):.1f}GB '
        f'budget({args.max_vram_percent}%)={budget / (1024**3):.1f}GB '
        f'overhead={OVERHEAD // (1024**2)}MB '
        f'model={model_size // (1024**2)}MB/{n_layers}L '
        f'w/layer={per_layer_weight // (1024**2)}MB '
        f'{kv_detail}'
        f'-> max_gpu_layers={max_layers}',
        flush=True,
    )
    return max_layers


def _build_llm(n_gpu_layers):
    kwargs = dict(
        model_path=args.model,
        n_gpu_layers=n_gpu_layers,
        n_ctx=args.ctx,
        n_threads=args.threads,
        verbose=False,
    )
    # (правка 109) KV cache quantization: type_k = type_v = выбранный тип
    if kv_type is not None:
        kwargs['type_k'] = kv_type
        kwargs['type_v'] = kv_type
    if args.mmproj:
        kwargs['mmproj_path'] = args.mmproj
    return Llama(**kwargs)


def _load_with_fallback():
    """Load the model with VRAM-aware GPU layer selection.

    When --gpu-layers is -1 (auto), we calculate the maximum number of GPU
    layers that fit within --max-vram-percent of total VRAM (default 90%,
    правка 60). This prevents the system from using >90% VRAM and lagging;
    the rest of the layers automatically stay on CPU.
    Falls back to fewer layers on load failure.
    """
    requested = args.gpu_layers
    if requested < 0:
        # VRAM-capped auto: calculate max layers that fit in 90% VRAM (правка 60)
        calculated = _calc_max_gpu_layers()
        if calculated is None:
            candidates = [-1, 32, 16, 8, 0]
        elif calculated == -1:
            candidates = [-1, 0]  # all fits
        else:
            candidates = [calculated, calculated // 2, 0]
    elif requested > 0:
        candidates = [requested, 0]
    else:
        candidates = [0]
    last_err = None
    for cand in candidates:
        try:
            model = _build_llm(cand)
            print(
                f'[llm] model loaded (requested gpu_layers={requested}, used={cand})',
                flush=True,
            )
            return model
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(
                f'[llm] gpu_layers={cand} load failed ({e}); retrying with fewer...',
                flush=True,
            )
    raise last_err


# ── state ──
last_activity = time.time()
gen_lock = threading.Lock()
abort_flag = threading.Event()
shutdown_requested = threading.Event()


def touch():
    global last_activity
    last_activity = time.time()


def _graceful_exit():
    """Release model resources and shut down the server cleanly."""
    global llm
    print('[llm] graceful shutdown - releasing model...', flush=True)
    # Флаг ДО всего: параллельный поток генерации увидит его в цикле чанков
    # и прервётся, вместо использования объекта, который мы сейчас освободим.
    shutdown_requested.set()
    # Освобождаем модель ТОЛЬКО если генерация не активна: del llm посреди
    # чужого create_chat_completion — риск access violation. Если лок занят —
    # пропускаем del (os._exit ниже всё равно освободит память процесса).
    if gen_lock.acquire(timeout=2.0):
        try:
            del llm
        except Exception:
            pass
        gen_lock.release()
    import gc
    gc.collect()
    print('[llm] model released, shutting down server', flush=True)
    threading.Thread(target=lambda: (server.shutdown(), server.server_close()), daemon=True).start()
    import os
    time.sleep(0.5)
    os._exit(0)


# ── (правка 62) системные инструкции не обрезаются при переполнении контекста ──
# llama-cpp-python при переполнении контекста (Llama.eval) шифтует KV-кэш и
# сохраняет только ПЕРВЫЕ n_keep токенов (по умолчанию n_keep=256, см. llama.py:
# "self.n_keep = n_keep if n_keep > 0 else 256"). Наш системный промпт — тысячи
# токенов, поэтому при шифте он вылетал, и модель теряла инструкции.
# Фикс: подгоняем llm.n_keep под размер отрендеренного первого блока
# (сообщение system + обёртка chat-шаблона), чтобы при любом шифте он
# гарантированно оставался в начале контекста. n_keep — простое поле объекта,
# читаемое в момент шифта, поэтому изменение в рантайме корректно.
_n_keep_cache = {}  # hash(system content) -> n_keep


def _apply_system_n_keep(messages):
    """(правка 62) Пиним системные инструкции: при переполнении контекста
    llama.cpp отбрасывает токи, но первые n_keep токенов (системный промпт)
    сохраняет. Увеличиваем n_keep до размера блока system + запас на
    служебные токены шаблона (im_start/system/им_end/BOS)."""
    try:
        if not messages:
            return
        first = messages[0]
        if not isinstance(first, dict) or first.get('role') != 'system':
            return
        content = first.get('content') or ''
        if not isinstance(content, str) or not content:
            return
        key = hash(content)
        n_keep = _n_keep_cache.get(key)
        if n_keep is None:
            # special=True: спец-токены внутри текста считаются отдельно —
            # оценка только завышается, запас остаётся безопасным.
            n_tokens = len(llm.tokenize(content.encode('utf-8'), add_bos=True, special=True))
            n_keep = n_tokens + 64  # 64 — запас на обёртку шаблона и BOS
            _n_keep_cache[key] = n_keep
            if len(_n_keep_cache) > 8:
                _n_keep_cache.clear()
                _n_keep_cache[key] = n_keep
        current = getattr(llm, 'n_keep', 256)
        if n_keep > current:
            llm.n_keep = n_keep
            print(
                f'[llm] (правка 62) n_keep={n_keep} '
                f'(system ≈ {n_tokens} токенов) — инструкции будут сохранены '
                f'при переполнении контекста',
                flush=True,
            )
    except Exception as e:  # noqa: BLE001
        # Не критично: без n_keep поведение как раньше (default 256).
        print(f'[llm] (правка 62) n_keep не установлен: {e}', flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):  # silence default logging
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        touch()
        if self.path == '/health':
            self._json(200, {'ok': True, 'model': args.model, 'gpu_layers': args.gpu_layers})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)

        # /shutdown — graceful exit (no body needed)
        if self.path == '/shutdown':
            self._json(200, {'ok': True, 'msg': 'shutting down'})
            threading.Timer(0.2, _graceful_exit).start()
            return

        touch()
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            return self._json(400, {'error': 'bad json'})

        if self.path == '/abort':
            abort_flag.set()
            return self._json(200, {'ok': True})

        if self.path != '/chat':
            return self._json(404, {'error': 'not found'})

        # abort-флаг чистим ТОЛЬКО после захвата gen_lock: раньше второй
        # параллельный запрос сбрасывал флаг до очереди, и «Стоп» для
        # первого стрима убивал вместо него уже ждущий второй (и наоборот:
        # сброшенный чужим запросом флаг не останавливал целевой стрим).
        messages = body.get('messages') or []
        # (правка 62) фиксируем системные инструкции ДО генерации: при
        # переполнении контекста сохранятся первые n_keep токенов.
        _apply_system_n_keep(messages)
        max_tokens = int(body.get('max_tokens') or 4096)
        temperature = float(body.get('temperature') or 0.7)
        # (правка 135) тонкая настройка сэмплинга: route.ts передаёт набор,
        # подобранный под семейство активной модели (Gemma / Qwen3.5).
        # Если ключей нет — llama-cpp-python использует свои дефолты
        # (top_k=40, top_p=0.95, min_p=0.05), что хуже под наши модели.
        def _f(key, default):
            v = body.get(key)
            return float(v) if v is not None else default
        def _i(key, default):
            v = body.get(key)
            return int(v) if v is not None else default
        sampling = {
            'temperature': temperature,
            'top_p': _f('top_p', 0.95),
            'top_k': _i('top_k', 40),
            'min_p': _f('min_p', 0.05),
            'presence_penalty': _f('presence_penalty', 0.0),
            'frequency_penalty': _f('frequency_penalty', 0.0),
            'repeat_penalty': _f('repeat_penalty', 1.0),
        }
        # (правка 140) llama-cpp-python MULTIMODAL (mmproj) не принимает
        # presence_penalty / frequency_penalty / repeat_penalty — эти параметры
        # существуют только в базовой Llama.create_chat_completion. При
        # загрузке модели с --mmproj (видео/изображения) их передачу нужно
        # отключать, иначе падает с:
        #   Llama.create_chat_completion() got an unexpected keyword argument
        #   'presence_penalty'
        # Определяем multimodal по args.mmproj (строка 316-317: если задан —
        # kwargs['mmproj_path'] = args.mmproj, модель загружается с vision).
        if args.mmproj:
            for _k in ('presence_penalty', 'frequency_penalty', 'repeat_penalty'):
                sampling.pop(_k, None)
        stop = body.get('stop')
        if stop is not None and not isinstance(stop, list):
            stop = [stop]
        stream = bool(body.get('stream', True))

        # ── Non-streaming mode: plain JSON (audio-probe path) ──
        if not stream:
            with gen_lock:
                try:
                    res = llm.create_chat_completion(
                        messages=messages,
                        max_tokens=max_tokens,
                        stop=stop,
                        stream=False,
                        **sampling,
                    )
                    choice = (res.get('choices') or [{}])[0]
                    text = ((choice.get('message') or {}).get('content')) or ''
                    return self._json(200, {
                        'ok': True,
                        'text': text,
                        'finish_reason': choice.get('finish_reason'),
                    })
                except Exception as e:  # noqa: BLE001
                    return self._json(500, {'ok': False, 'error': str(e)})

        # ЛОК ПЕРЕД заголовками: раньше SSE-заголовки отправлялись до захвата
        # gen_lock — второй конкурентный /chat получал «стрим» из нуля байт и
        # молча висел на локе всё время первой генерации (хедер-таймаут Node
        # уже был удовлетворён, idle-watchdog убивал запрос лишь через 5 мин).
        # Теперь занятый сервер сразу отвечает 409 JSON-ом.
        if not gen_lock.acquire(timeout=5.0):
            return self._json(409, {
                'ok': False,
                'error': 'LLM уже генерирует другой ответ — дождитесь завершения',
            })

        # SSE response headers (chunked by http.server framing)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()

        def emit(obj):
            try:
                # Каждый чанк — активность: иначе idle-watchdog убивал
                # сервер посреди длинной CPU-генерации (> --idle-sec).
                touch()
                self.wfile.write(f'data: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode('utf-8'))
                self.wfile.flush()
                return True
            except (BrokenPipeError, ConnectionResetError, OSError):
                return False

        try:
            abort_flag.clear()
            # touch ДО старта: мультимодальный prefill (ленивое декодирование
            # видео) выполняется внутри create_chat_completion ДО первого
            # чанка — без этого idle-watchdog мог убить сервер посреди
            # префила, если он длиннее --idle-sec.
            touch()
            try:
                stream = llm.create_chat_completion(
                    messages=messages,
                    max_tokens=max_tokens,
                    stop=stop,
                    stream=True,
                    **sampling,
                )
                for chunk in stream:
                    if abort_flag.is_set() or shutdown_requested.is_set():
                        break
                    delta = (chunk.get('choices') or [{}])[0].get('delta') or {}
                    text = delta.get('content')
                    if text:
                        if not emit({'delta': text}):
                            break
                emit({'done': True})
            except Exception as e:  # noqa: BLE001
                try:
                    emit({'error': str(e), 'done': True})
                except Exception:
                    pass
        finally:
            gen_lock.release()


def idle_watchdog():
    while True:
        time.sleep(10)
        if time.time() - last_activity > args.idle_sec:
            print('[llm] idle timeout - exiting', flush=True)
            _graceful_exit()


if __name__ == '__main__':
    # Load model only when run as a program (keeps the module importable for
    # tests of the GGUF parser / VRAM calculation).
    llm = _load_with_fallback()

    # Report GPU status
    try:
        import ctypes
        from llama_cpp._ggml import libggml
        libggml.ggml_backend_reg_count.argtypes = []
        libggml.ggml_backend_reg_count.restype = ctypes.c_size_t
        n_backends = libggml.ggml_backend_reg_count()
        device_str = 'GPU (CUDA)' if n_backends >= 2 else 'CPU'
        print(f'[llm] model loaded on {device_str} (backends: {n_backends})', flush=True)
    except Exception as e:
        print(f'[llm] model loaded (GPU check: {e})', flush=True)

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    threading.Thread(target=idle_watchdog, daemon=True).start()
    print(f'[llm] listening on 127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
