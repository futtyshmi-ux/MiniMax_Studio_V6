# MiniMax H3 Studio

Локальный веб-интерфейс для генерации кинематографичных видео со звуком на базе модели **MiniMax H3**. Работает полностью offline — нужен только NVIDIA GPU.

## Возможности

- **Генерация видео + аудио** — двухпроходная (low-res → latent upscale → high-res)
- **Референсы** — изображения (до 9), видео (до 3), аудио (до 3)
- **LLM-ассистент** — Gemma 4 12B (GGUF, Q3/Q4/Q5) или более лёгкая Qwen3.5 9B (Q4) для слабых видеокарт — помощь с промптами, видение референсов
- **Кастомные LoRAs** — добавление, удаление, триггер-ворды
- **Свободное разрешение** — от 0.2 до 3.0 МП, любой aspect ratio
- **Очередь генераций** — параллельные задачи, авто-очистка
- **Видеоплеер** — встроенный, с метаданными
- **Звуковой сигнал** — уведомление при завершении генерации
- **Голосовой ввод** — дикт (whisper, CPU): поле промпта, чат ассистента, редактор промптов (модели в `stt/models`, настройки — вкладка «Голос»)
- **Upscale (DLSS 5)** — встроенный DLSS 5 Visual Enhancer: Neural Rendering (шум/тон/структура), RTX VSR (апскейл 1–4×, опц. HDR) — нативная вкладка, без Gradio/iframe
- **Портативность** — один bat-файл, никаких установок

## Структура проекта

```
Minimax_Studio/
├── start.bat                    ← запуск (единственная точка входа)
├── README.md                    ← этот файл
├── server.js                    ← Next.js production server
├── package.json                 ← зависимости
├── next.config.ts               ← конфигурация Next.js
├── tsconfig.json                ← TypeScript
├── postcss.config.mjs           ← Tailwind CSS
├── .env                         ← переменные окружения (COMFY_URL)
│
├── config/
│   ├── config.ini               ← настройки приложения (VRAM, LLM, звук)
│   └── components.json          ← shadcn/ui
├── data/
│   └── loras.json               ← список кастомных LoRA
├── docs/
│   └── Minimax_Studio_Workflow.json  ← workflow для обычного ComfyUI
├── scripts/
│   └── start_comfy.bat          ← запуск ComfyUI backend
├── upscale/                     ← DLSS 5 Visual Enhancer (вкладка «Upscale»)
│   ├── bridge.py                ← headless JSON-мост (stdlib, embedded Python)
│   ├── src/                     ← пайплайны: NR / VSR
│   └── bin/                     ← embedded Python 3.13 (amd64)
├── stt/                         ← встроенный whisper STT (вкладка «Голос») — рантайм
│
├── src/                         ← исходный код (Next.js App Router)
├── public/                      ← статические файлы
├── .next/                       ← production build
├── runtime/
│   └── node.exe                 ← bundled Node.js (если нет в PATH)
├── node_modules/                ← npm зависимости
└── ComfyUI-Easy-Install/        ← portable ComfyUI + модели
```

## Требования

| Компонент | Версия                                         |
| --------- | ---------------------------------------------- |
| ОС        | Windows 10/11 x64                              |
| GPU       | NVIDIA, 12+ ГБ VRAM (рекомендуется), мин. 8 ГБ |
| Драйвер   | CUDA 12.x                                      |
| Node.js   | 18+ LTS (или bundled `runtime\node.exe`)       |
| ComfyUI   | Portable, папка `ComfyUI-Easy-Install`         |

## Запуск

```
start.bat
```

Скрипт автоматически:

1. Находит Node.js (PATH → `runtime\node.exe` → ошибка)
2. Проверяет наличие `ComfyUI-Easy-Install/`
3. Устанавливает `node_modules` если нет
4. Собирает `.next` если нет
5. Запускает ComfyUI (порт 8188)
6. Ждёт readiness
7. Запускает Web UI (порт 3000)
8. Открывает браузер

**Стоп:** закрыть окно консоли.

## Настройки

Все настройки — в Web UI (иконка шестерёнки) и в `config/config.ini`:

| Параметр                | Описание                                        |
| ----------------------- | ----------------------------------------------- |
| `reserve_gb`            | VRAM, зарезервированная для системы (ГБ)        |
| `dynamic_vram`          | Динамическое управление VRAM ComfyUI            |
| `llm.device`            | `auto` / `gpu` / `cpu` — где считается LLM      |
| `llm.context_size`      | Контекстное окно LLM (токены)                   |
| `llm.max_output_tokens` | Макс. длина ответа LLM                          |
| `llm.model`             | Квантизация LLM (пусто = Q4_K_M)                |
| `comfy.diffusion_model` | Альтернативная базовая модель (пусто = default) |
| `ui.sound_on`           | Звук при завершении генерации (1/0)             |
| `stt.enabled`           | Голосовой ввод вкл/выкл (1/0)                   |
| `stt.model`              | Модель STT (пусто = авто, первая найденная)     |
| `stt.language`           | Язык распознавания: `ru` / `en` / `auto`        |
| `stt.threads`            | Потоки CPU (0 = авто)                           |
| `upscale.enabled`         | Вкладка Upscale вкл/выкл (1/0)                  |
| `upscale.port`            | Порт DLSS-моста (по умолчанию 7890)             |

## Модели

Ожидаемые файлы (в `ComfyUI-Easy-Install/ComfyUI/models/`):

| Тип             | Файл                                                                                         | Размер   |
| --------------- | -------------------------------------------------------------------------------------------- | -------- |
| Diffusion       | `diffusion_models/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors` | ~21 GB   |
| Text Encoder    | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`                                 | ~15.7 GB |
| VAE (video)     | `vae/minimax_h3_video_vae_fp16.safetensors`                                                  | ~4.9 GB  |
| VAE (audio)     | `vae/minimax_h3_audio_vae_fp32.safetensors`                                                  | ~0.6 GB  |
| Turbo LoRA      | `loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`                           | ~1.5 GB  |
| Latent Upscaler | `latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16.safetensors`                       | ~2 GB    |
| TAE Preview     | `vae_approx/taeh3.safetensors`                                                               | ~10 MB   |
| LLM (Q4)        | `llm/gemma-4-12b-it-Q4_K_M.gguf`                                                             | ~7.1 GB  |
| LLM mmproj      | `llm/mmproj-BF16.gguf`                                                                       | ~175 MB  |
| LLM (Qwen3.5, альтернатива) | `llm/qwen3.5-9b/Qwen3.5-9B-Q4_K_M.gguf`                                                    | ~5.7 GB  |
| LLM (Qwen3.5 mmproj) | `llm/qwen3.5-9b/mmproj-F16.gguf`                                                             | ~920 MB  |

Скачивание моделей — в Web UI → Настройки → Общие → Модели.

## Вкладка Upscale (DLSS 5)

Встроенный **DLSS 5 Visual Enhancer** (папка `upscale/`, полный портативный рантайм: embedded Python + DLL-рантаймы). Нативная вкладка программы — **не Gradio, не iframe**: форма, прогресс-бар и результат — внутри UI.

Layout повторяет вкладку «Генерация»: слева — панель параметров (сервис, GPU, параметры режима, кодирование) и закреплённый блок статуса job; справа — выбор режима + загрузка видео + кнопка запуска; внизу — **общая галерея видео** (та же, что в «Генерация» и «Галерея»): результаты апскейла пишутся в общую папку output ComfyUI, поэтому видятся во всех местах и чистятся кнопкой «Удалить контент».

Работаем **только с видео** (подрежимы картинок в UI не выводятся).

### Возможности

| Фича | Что делает |
| ---- | ---------- |
| **Neural Rendering** | Подавление шума и артефактов: пресеты, стиль (Natural/Cinematic), интенсивность, локальный тон/структура, DLSS-модель (J/K/L/M), коэффициент 1×–3×, опц. «сохранить HDR» |
| **RTX VSR** | Нейро-апскейл 1×–4× (Low→Ultra), произвольный размер, **опциональный HDR-режим** (контраст/насыщенность/пиковая яркость) |

Для каждого режима: выбор GPU (AI-пайплайн и видео-пайплайн отдельно), кодек (H.264/H.265/AV1/ProRes, CPU или NVENC), качество кодирования, контейнер (MP4/MKV/MOV).

### Как пользоваться

1. Откройте вкладку **Upscale** — сервис поднимется автоматически (первый старт до 2–3 минут: подготовка DLL, детект GPU).
2. Выберите режим: **Neural Rendering** или **RTX VSR**.
3. Перетащите видео или выберите его — программа загрузит его в `data/upscale-input/` и покажет метаданные (разрешение, FPS, длительность, кодек, HDR).
   Видео можно взять прямо из галереи: перетащите превьюшку в поле загрузки (работает из любой вкладки, где есть галерея) либо нажмите кнопку **✨** на карточке видео — программа сама переключится на Upscale и подхватит файл.
4. Настройте параметры в левой панели → **Запустить**. Прогресс виден в реальном времени, отмена — кнопкой **Отменить**.
5. Готовый файл появится в общей галерее ниже (и во вкладке «Галерея»). Скачать — кнопка ⬇ на карточке видео (появляется при наведении).

### Требования

- Windows 10/11 x64
- NVIDIA RTX (20/30/40/50) с актуальным драйвером — без RTX вкладка честно сообщает, что рантайм не готов
- Live-режим (real-time/HLS) из исходного проекта **не интегрирован** — это отдельный инструмент, а не обработка файла

## Архитектура

```
Браузер (:3000)
  │
  ├─ Next.js App Router (React 19, Tailwind, shadcn/ui)
  │
  ├─ /api/comfy/*  ── прокси ──►  ComfyUI (:8188)
  │                                │
  │                                └─ Workflow: MiniMax H3 Ref2VA
  │                                   Two-Pass Latent Upscaler
  │
  ├─ /api/llm/chat  ──►  llama.cpp (Gemma 4 12B / Qwen3.5 9B GGUF)
  │
  ├─ /api/upscale/* ─►  bridge.py (DLSS 5, embedded Python, порт 7890)
  │                     └─ пайплайны: Neural Rendering / RTX VSR
  │
  └─ Файлы: ComfyUI/output/ (видео), ComfyUI/input/ (референсы)
```

**Workflow (Two-Pass):**

1. **Pass 1** — low-res (default 0.2 MP, макс. 2 MP; 2–30 шагов, default 4; сэмплер и планировщик на выбор, default `euler` / `simple`)
2. **Latent Upscale** — `MinimaxH3LatentUpscaler3D` → целевое разрешение (`enable_chunking: true`)
3. **Pass 2** — high-res refinement (3–7 шагов, сэмплер на выбор (default `euler`), ManualSigmas)
4. **Decode** — VAEDecode (video) + VAEDecodeAudio (audio)
5. **Output** — H.264 MP4, 24 fps

Все параметры проходов (сэмплеры, планировщик, разрешение pass 1) + влияние турбо-лоры (default 1.0) настраиваются в «Дополнительных параметрах».

**Оптимизация VRAM:**

- `MiniMaxLowVRAMAttention` — head-chunked attention
- `MiniMaxChunkFeedForward` — chunked FFN для длинных последовательностей

## Кастомные ноды ComfyUI

| Нода                                          | Назначение                     |
| --------------------------------------------- | ------------------------------ |
| `MiniMaxH3ReferenceToVideo`                   | Основной H3 узел               |
| `MiniMaxH3SigmaShift`                         | Сдвиг сигма-распределения      |
| `MiniMaxLowVRAMAttention`                     | Экономия VRAM (attention)      |
| `MiniMaxChunkFeedForward`                     | Экономия VRAM (FFN)            |
| `MinimaxH3LatentUpscaler3D`                   | Апскейл латента                |
| `LTXVSeparateAVLatent` / `LTXVConcatAVLatent` | Разделение AV латентов         |
| `ModelPreviewOverrideKJ`                      | Живое превью шагов             |
| `ComfyMathExpression`                         | Математические выражения       |
| `VHS_VideoCombine`                            | Выход видео (VideoHelperSuite) |

## Команды (разработка)

```bash
npm install          # зависимости
npm run dev          # dev server (:3000)
npm run build        # production build (автоматически поднимает хип Node до 8 ГБ)
npm run build:default  # production build с хипом по умолчанию (без обёртки)
npm run typecheck    # TypeScript проверка
```

> **Сборка и память.** `npm run build` запускает `next build --webpack` через
> обёртку [scripts/build.mjs](scripts/build.mjs), которая задаёт хип Node 8 ГБ
> (`--max-old-space-size=8192`) — иначе сборка падает с
> `JavaScript heap out of memory`. Размер хипа можно переопределить:
> `NEXT_BUILD_HEAP_MB=12288 npm run build`. Lint-скрипт удалён: eslint в проекте
> не используется (проверка типов — `npm run typecheck`).
