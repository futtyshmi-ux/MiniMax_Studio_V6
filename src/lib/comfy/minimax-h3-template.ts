/**
 * MiniMax H3 Reference-to-Video — Two-Pass Latent Upscaler workflow.
 *
 * Architecture:
 *   Pass 1: Low-res generation (0.2 MP, 8 total steps → SplitSigmas → 4 effective)
 *   Upscale: MinimaxH3LatentUpscaler3D to target resolution (default 0.7 MP)
 *   Pass 2: High-res refinement (3 steps via ManualSigmas)
 *   Decode: Separate VAEDecode (video) + VAEDecodeAudio (audio)
 *
 * Model chain: UNET → [LowVRAM] → [ChunkFF] → LoRA → SigmaShift → AttentionBackend → Preview
 * (LowVRAM Attention and Chunk FeedForward are optional, default ON;
 *  SageAttn and SLA patches were removed in favour of --use-ck-attention)
 *
 * Defaults (overridable via MiniMaxH3Params):
 *   - LoRA: minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors, strength 1.0 (правка 70)
 *   - Pass 1: сэмплер + планировщик на выбор (default euler / simple, правки 67, 70)
 *     BasicScheduler (steps) → SplitSigmas
 *   - Pass 2: сэмплер на выбор (default euler, правки 68–69) / ManualSigmas
 *   - Latent Upscaler: «target dimensions» (правка 124), enable_chunking: true (правка 68)
 *   - Pass 2: ManualSigmas (0.9035, 0.6316, 0.3158, 0.0000)
 *   - Low-res: 0.2 MP (default), диапазон 0.2–2 MP (правка 70)
 *   - Optimization nodes SigmaShift + Attention
 *
 *   (правка 124) Разрешение: генерация кратной 32, чуть больше номинала
 *   (16:9 1080p → 1920×1088), в конце — кроп чётко под номинал (1920×1080).
 */

/** (правки 69–70) Валидные к-сэмплеры для обоих проходов — подмножество
 *  KSAMPLER_NAMES установленной сборки ComfyUI (comfy/samplers.py).
 *  Default: euler. */
export const VALID_KSAMPLERS = [
  'er_sde',
  'euler',
  'dpmpp_2m',
  'dpmpp_3m_sde',
  'heun',
  'lcm',
  'res_multistep',
] as const

export const DEFAULT_PASS2_SAMPLER = 'euler'
export const DEFAULT_PASS1_SAMPLER = 'euler'
/** (правка 70) Валидные планировщики pass 1 — SCHEDULER_HANDLERS
 *  установленной сборки ComfyUI (comfy/samplers.py). Default: simple. */
export const PASS1_SCHEDULERS = [
  'sgm_uniform',
  'simple',
  'karras',
  'exponential',
  'ddim_uniform',
  'normal',
  'beta',
  'linear_quadratic',
  'kl_optimal',
] as const

export const DEFAULT_PASS1_SCHEDULER = 'simple'

export interface MiniMaxH3Params {
  prompt: string
  /** Uploaded image filenames in ComfyUI input/ (max 9). */
  refImages: string[]
  /** (правка 146) Режим генерации:
   *  • 'ref' — референсы (как раньше, default): refImages/refVideos/refAudios
   *    через MiniMaxH3ReferenceToVideo;
   *  • 't2v' — только текст: MiniMaxH3ImageToVideo без кадров;
   *  • 'flf' — первый/последний кадр: MiniMaxH3ImageToVideo + firstFrame/lastFrame.
   *  В t2v/flf аудио-референсы подаются через цепочку MiniMaxH3AddGuide
   *  (у самой ноды аудио-входов нет). */
  mode?: 'ref' | 't2v' | 'flf'
  /** (правка 146) flf: имя файла первого кадра в ComfyUI input/. */
  firstFrame?: string
  /** (правка 146) flf: имя файла последнего кадра в ComfyUI input/ (опционально). */
  lastFrame?: string
  /** (правка 152) flf: ширина первого кадра в пикселях (для aspect ratio, чтобы не растягивать). */
  firstFrameWidth?: number
  /** (правка 152) flf: высота первого кадра в пикселях. */
  firstFrameHeight?: number
  /** Aspect ratio string for ResolutionSelector (e.g., "16:9", "21:9 (Ultrawide)"). */
  aspectRatio: string
  /** Duration in seconds */
  duration: number
  /** Seed (-1 = random) */
  seed: number
  /** Target megapixels for the latent upscaler output (default 0.7 ≈ 720p).
   *  (правка 124) Используется только в режиме свободного разрешения —
   *  при заданных targetDimensions приоритет у точных размеров. */
  finalResolution?: number
  /** (правка 124) Точные номинальные (финальные) размеры видео, напр.
   *  1920×1080 для 16:9 1080p. Ставятся для пресетов качества: апскейлер
   *  работает в режиме «target dimensions» (gen = ceil32(nominal)), итог —
   *  центрированный кроп до nominalW×nominalH. */
  targetDimensions?: { width: number; height: number }
  /** Low-res pass 1 resolution in MP (default 0.2, диапазон 0.2–2, правка 70). */
  lowResMP?: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 4, max 30). */
  firstSamplerSteps?: number
  /** Pass 2 sigma variant: '3step' | '4step' | '5step' | '6step' | '7step'. Default '3step'. */
  sigmaVariant?: string
  /** (правка 69) Pass 2 sampler (default 'euler'). Must be one of VALID_KSAMPLERS. */
  pass2Sampler?: string
  /** (правка 70) Pass 1 sampler (default 'euler'). Must be one of VALID_KSAMPLERS. */
  pass1Sampler?: string
  /** (правка 70) Pass 1 scheduler (default 'simple'). Must be one of PASS1_SCHEDULERS. */
  pass1Scheduler?: string
  /** (правка 70) Turbo LoRA strength (default 1.0; 0 = отключена). */
  turboLoraStrength?: number
  /** (правка 90) Turbo LoRA filename in models/loras/ (default: built-in ref2v turbo). */
  turboLoraName?: string
  /** (правка 90) Chain the turbo LoRA at all (default true). */
  turboLoraEnabled?: boolean
  /** Enable MiniMaxLowVRAMAttention (head-chunked attention, saves VRAM). Default true. */
  lowVramAttention?: boolean
  /** Enable MiniMaxChunkFeedForward (chunked FFN, saves VRAM on long sequences). Default true. */
  chunkFeedForward?: boolean
  /** ChunkFF: number of feed-forward chunks (default 2). */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold above which chunking kicks in (default 4096). */
  chunkFFThreshold?: number

  /* ── Video references (max 3) ── */
  /** Video filenames in ComfyUI input/. Each produces IMAGE frames for ref_video_N. */
  refVideos?: Array<{ path: string; includeAudio?: boolean }>
  /* ── Standalone audio references (max 3) ── */
  /** Audio filenames in ComfyUI input/. Each maps to ref_audio_N. */
  refAudios?: string[]
  /* ── Custom LoRAs (chained after turbo LoRA) ── */
  /** Custom LoRAs to apply after the built-in turbo LoRA. */
  customLoras?: Array<{ name: string; strength: number }>
  /** Diffusion model filename (default: minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors). */
  diffusionModel?: string
  /** (правка 91) Подпапка вывода (папка проекта галереи; '' = общая).
   *  Уходит в filename_prefix ноды VHS_VideoCombine как «folder/Minimax_Studio». */
  outputSubfolder?: string
  /** (правка 58) Reference image sizing mode (node input ref_image_size):
   *  'match' — shrink refs to the generation pixel area (default, faster);
   *  'max' — 2048px short edge for best identity fidelity (slower). */
  refImageSize?: 'match' | 'max'
}

/** Node IDs for reference images (up to 9). */
const REF_IMAGE_NODE_IDS = ['101', '399', '401', '403', '405', '407', '409', '411', '413'] as const

/** Node IDs for reference videos (up to 3) — VHS_LoadVideo nodes. */
const REF_VIDEO_NODE_IDS = ['501', '502', '503'] as const

/** Node IDs for standalone audio references (up to 3) — LoadAudio nodes. */
const REF_AUDIO_NODE_IDS = ['510', '511', '512'] as const

/** (правка 146) flf: LoadImage-ноды первого/последнего кадра. */
const FIRST_FRAME_NODE_ID = '105'
const LAST_FRAME_NODE_ID = '107'

/** (правка 146) t2v/flf: цепочка MiniMaxH3AddGuide для аудио-референсов (до 3). */
const AUDIO_GUIDE_NODE_IDS = ['46:50', '46:51', '46:52'] as const

/**
 * Parse an aspect-ratio string "A:B" (decimals allowed, e.g. "2.35:1",
 * decorations like "(Ultrawide)" ignored) → [rw, rh].
 */
function parseAspect(s: string): [number, number] {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/)
  if (!m) return [16, 9]
  return [parseFloat(m[1]), parseFloat(m[2])]
}

/**
 * EXACT math of ComfyUI's ResolutionSelector node (comfy_extras/
 * nodes_resolution.py): megapixels are BINARY (MP × 1024 × 1024), results
 * aligned to `multiple`. Doing it here (instead of wiring the node) allows
 * ANY aspect ratio — including "2.35:1", which the node's combo does not
 * offer (it silently collapsed to 21:9 before).
 */
export function selectResolution(
  aspect: string,
  megapixels: number,
  multiple = 32,
): { w: number; h: number } {
  const [rw, rh] = parseAspect(aspect)
  const total = megapixels * 1024 * 1024
  const scale = Math.sqrt(total / (rw * rh))
  const w = Math.round((rw * scale) / multiple) * multiple
  const h = Math.round((rh * scale) / multiple) * multiple
  return { w: Math.max(multiple, w), h: Math.max(multiple, h) }
}

/* ─── (правка 124) Точные соотношения сторон + ТОЧНОЕ итоговое разрешение ───
 *
 * Логика по запросу юзера (правка 124): сначала — разрешение генерации,
 * кратное 32 и чуть больше номинала; потом — генерация; в конце — точная
 * подгонка под выбранное соотношение + качество:
 *   1) номинал = ТОЧНО выбранное соотношение + качество
 *      (16:9 + 1080p → 1920×1080; короткая сторона = число «p»);
 *   2) gen-разрешение = номинал, поднятый по каждой оси до кратного 32
 *      (1920×1080 → 1920×1088) — анти-бандинг/VAE сохраняются;
 *   3) апскейлер работает в режиме «target dimensions» — выдаёт ровно
 *      genW×genH независимо от пропорции pass 1 (megapixels-mode держал
 *      пропорцию pass 1 и округлял оси независимо — из-за этого 16:9
 *      давало 1952×1098 и т.п.);
 *   4) в конце центрированный кроп ImageCrop genW×genH → номинал
 *      (1920×1088 → 1920×1080). Итог: видео ЧЁТКО 16:9 1080p.
 *
 * Свободное разрешение (MP) идёт вторым путём (finalDimsFromMegapixels):
 * генерация — по бинарным MP узла (MP×1024×1024), итог — максимальный
 * вписанный прямоугольник с точным соотношением (чётные стороны, yuv420p).
 *
 * computeFinalDimensions / finalDimsFromMegapixels — ЕДИНЫЙ источник
 * истины: workflow (target dimensions + ImageCrop), метаданные
 * (pending-meta, use-video-gen) и UI-бейджи — везде один и тот же результат.
 */

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { const t = a % b; a = b; b = t }
  return a || 1
}

/** Приводит дробное соотношение ("2.35:1") к несократимой целочисленной
 *  паре (47:20) — нужно для точного расчёта кропа. (правка 121) */
export function aspectToInts(aspect: string): [number, number] {
  const [rw, rh] = parseAspect(aspect)
  const dec = (v: number) => {
    const s = String(v)
    const i = s.indexOf('.')
    return i < 0 ? 0 : Math.min(6, s.length - i - 1)
  }
  const f = Math.pow(10, Math.max(dec(rw), dec(rh)))
  const w = Math.round(rw * f)
  const h = Math.round(rh * f)
  const g = gcd(w, h)
  return [w / g, h / g]
}

/** Python round() = half-to-even (узел апскейлера на Python). (правка 121) */
function pyRound(x: number): number {
  const f = Math.floor(x)
  const frac = x - f
  if (frac > 0.5) return f + 1
  if (frac < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** Округление к чётному (yuv420p). (правка 124) */
function roundToEven(n: number): number {
  const r = Math.round(n)
  return r % 2 === 0 ? r : r + 1
}

/**
 * (правка 124) Номинальные (финальные) размеры: короткая сторона = shortSide,
 * длинная = короткая × (rw/rh), округлённая до чётной (yuv420p).
 * 16:9 + 1080 → 1920×1080; 21:9 + 480 → 1120×480. Соотношение ТОЧНОЕ.
 */
export function nominalDimensions(aspect: string, shortSide: number): { w: number; h: number } {
  const [rw, rh] = parseAspect(aspect)
  const ratio = rw / rh
  if (ratio >= 1) {
    return { w: roundToEven(shortSide * ratio), h: roundToEven(shortSide) }
  }
  return { w: roundToEven(shortSide), h: roundToEven(shortSide / ratio) }
}

/**
 * (правка 157) flf-номинал: короткая сторона = заданный p (480/720/1080),
 * длинная = p × (fw/fh) — ТОЧНАЯ пропорция первого кадра (без квантования
 * к стандартным 16:9/9:16/…). Короткая сторона округляется до чётной
 * (yuv420p), чтобы итог всегда был кратно 2.
 *
 * В отличие от nominalDimensions() (которая квантует к ближайшему
 * стандартному соотношению), здесь пропорция берётся напрямую из размеров
 * кадра — горизонтальный кадр всегда даёт горизонтальное видео и т.д.
 */
export function flfNominalDimensions(
  shortSide: number,
  frameW: number,
  frameH: number,
): { w: number; h: number } {
  if (frameW >= frameH) {
    const h = roundToEven(shortSide)
    return { w: roundToEven(shortSide * (frameW / frameH)), h }
  }
  const w = roundToEven(shortSide)
  return { w, h: roundToEven(shortSide * (frameH / frameW)) }
}

export interface FinalDimensions {
  /** Размеры, которые реально выдаст апскейлер (кратные 32, ≥ номинала). */
  genW: number
  genH: number
  /** Смещение центрального кропа (0 — кроп не нужен). */
  cropX: number
  cropY: number
  /** Итоговые размеры видео ПОСЛЕ кропа — точный номинал. */
  outW: number
  outH: number
}

/**
 * (правка 124) ЕДИНЫЙ источник истины для итоговых размеров видео.
 * Генерация = номинал, поднятый по каждой оси до кратного 32 (чуть больше
 * номинала, кратность 32 сохранена); итог = номинал через центрированный
 * кроп (ImageCrop). Используется workflow (upscaler «target dimensions» +
 * ImageCrop), метаданными (pending-meta, use-video-gen) и UI-бейджами —
 * везде один и тот же результат.
 */
export function computeFinalDimensions(
  nominalW: number,
  nominalH: number,
  multiple: number = 32,
): FinalDimensions {
  const genW = Math.max(multiple, Math.ceil(nominalW / multiple) * multiple)
  const genH = Math.max(multiple, Math.ceil(nominalH / multiple) * multiple)
  const outW = Math.min(Math.max(2, nominalW), genW)
  const outH = Math.min(Math.max(2, nominalH), genH)
  return {
    genW,
    genH,
    cropX: Math.floor((genW - outW) / 2),
    cropY: Math.floor((genH - outH) / 2),
    outW,
    outH,
  }
}

/**
 * (правка 124) Путь свободного разрешения (MP): размеры генерации —
 * та же формула, что у узла MinimaxH3LatentUpscaler3D (режим MEGAPIXELS:
 * бинарные MP × 1024×1024, Python round до кратного 32); итог —
 * максимальный вписанный прямоугольник с ТОЧНЫМ соотношением и чётными
 * сторонами (yuv420p). Узел получает эти gen-размеры в режиме
 * «target dimensions», поэтому его выход совпадает с расчётом 1:1.
 *
 * (правки 121, 124) Floor 0.2 MP: pass 1 фиксирован на 0.2 MP, а узел
 * апскейлера запрещает уменьшение (effective_scale < 1.0 и выход < вход
 * → ValueError). 0.2 MP — нижняя граница ползунка «Свободное разрешение»;
 * при floor = 0.2 gen всегда ≥ pass 1 (равенство → узел проходит early-return,
 * кроп всё равно даёт точное соотношение). Было Math.max(1, mp) — молча
 * поднимало любое <1 MP до 1 MP (бейдж «0.70 MP» генерил 1 MP — не так).
 */
export function finalDimsFromMegapixels(
  aspect: string,
  megapixels: number,
  multiple: number = 32,
): FinalDimensions {
  const [rw, rh] = parseAspect(aspect)
  const ratio = rw / rh
  const targetPixels = Math.max(0.2, megapixels) * 1024 * 1024
  const hT = Math.sqrt(targetPixels / ratio)
  const wT = hT * ratio
  const genW = Math.max(multiple, pyRound(wT / multiple) * multiple)
  const genH = Math.max(multiple, pyRound(hT / multiple) * multiple)
  const [aw, ah] = aspectToInts(aspect)
  let k = Math.min(Math.floor(genW / aw), Math.floor(genH / ah))
  if (aw % 2 !== 0 || ah % 2 !== 0) k = Math.floor(k / 2) * 2 // обе стороны чётные
  if (k < 1) k = 1
  const outW = aw * k
  const outH = ah * k
  return {
    genW,
    genH,
    cropX: Math.floor((genW - outW) / 2),
    cropY: Math.floor((genH - outH) / 2),
    outW,
    outH,
  }
}

/**
 * Replicate ComfyUI's frame-count calculation (workflow node 46:19) exactly:
 *   max(5, round(seconds*fps)) snapped UP to the 17n+5 grid.
 * Single source of truth for metadata, shared by the client (use-video-gen)
 * and the server (pending-meta), so .video_length matches the ACTUAL frames
 * the server produces (правка 55). JS-safe Python-style modulo via
 * ((x % m) + m) % m.
 */
export function framesForDuration(seconds: number, fps = 24): number {
  const frames = Math.max(5, Math.round(seconds * fps))
  return frames + (((5 - frames) % 17) + 17) % 17
}

/* ─── Custom LoRA chain helpers (правка 44) ─── */

function loraNodeId(index: number): string {
  return `46:36_${index + 1}`
}

function buildCustomLoraNodes(
  loras: Array<{ name: string; strength: number }> | undefined,
  source: [string, number],
): Record<string, unknown> {
  if (!loras || loras.length === 0) return {}
  const nodes: Record<string, unknown> = {}
  let modelSrc = source
  for (let i = 0; i < loras.length; i++) {
    const id = loraNodeId(i)
    nodes[id] = {
      inputs: {
        lora_name: loras[i].name,
        strength_model: loras[i].strength,
        model: modelSrc,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Custom LoRA ${i + 1}: ${loras[i].name}` },
    }
    modelSrc = [id, 0]
  }
  return nodes
}

function getLastLoraOutput(
  loras: Array<{ name: string; strength: number }> | undefined,
  fallback: [string, number],
): [string, number] {
  if (!loras || loras.length === 0) return fallback
  return [loraNodeId(loras.length - 1), 0]
}

/**
 * Build the ComfyUI API-format workflow JSON for MiniMax H3 Two-Pass Latent Upscaler.
 */
/** (правка 127) Pass 1 (low-res) не может быть больше min(0.5, finalRes).
 *  Единая функция для workflow И метаданных — иначе сайдкар (и «Повторить»
 *  из него) нёс бы незаклёмпленный слайдер, разойдясь с реальным рендером. */
export function clampLowResMP(lowResMP: number, finalRes: number): number {
  return Math.min(lowResMP, Math.min(0.5, finalRes))
}

export function buildMiniMaxH3Workflow(p: MiniMaxH3Params): Record<string, unknown> {
  const seed = p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const finalRes = p.finalResolution ?? 0.7
  const lowResMP = clampLowResMP(p.lowResMP ?? 0.2, finalRes)
  const firstSteps = p.firstSamplerSteps ?? 4

  // (правка 127) Жёсткое ограничение: pass 1 (low-res) максимум min(0.5, finalResolution).
  // Это черновик — не должен быть больше финального разрешения.
  // Кламп вынесен в clampLowResMP — метаданные используют ТО ЖЕ значение.
  // Sigma variants for pass 2
  const SIGMA_VARIANTS: Record<string, string> = {
    '3step': '0.9035, 0.6316, 0.3158, 0.0000',
    '4step': '0.9035, 0.8000, 0.6316, 0.3158, 0.0000',
    '5step': '0.9231, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
    '6step': '0.9412, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
    '7step': '0.9500, 0.9280, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  }
  const sigmaVariant = SIGMA_VARIANTS[p.sigmaVariant || '3step'] || SIGMA_VARIANTS['3step']
  // (правка 69) Pass 2 sampler — из доп. настроек, валидация по белому списку
  const pass2Sampler = (VALID_KSAMPLERS as readonly string[]).includes(p.pass2Sampler || '')
    ? (p.pass2Sampler as string)
    : DEFAULT_PASS2_SAMPLER
  // (правка 70) Pass 1: сэмплер + планировщик из доп. настроек
  const pass1Sampler = (VALID_KSAMPLERS as readonly string[]).includes(p.pass1Sampler || '')
    ? (p.pass1Sampler as string)
    : DEFAULT_PASS1_SAMPLER
  const pass1Scheduler = (PASS1_SCHEDULERS as readonly string[]).includes(p.pass1Scheduler || '')
    ? (p.pass1Scheduler as string)
    : DEFAULT_PASS1_SCHEDULER
  // (правка 70) Влияние турбо-лоры (0–2, default 1.0)
  const turboStrength =
    typeof p.turboLoraStrength === 'number' && Number.isFinite(p.turboLoraStrength)
      ? Math.min(2, Math.max(0, p.turboLoraStrength))
      : 1.0
  // (правка 90) Турбо-лора включена? (default true)
  const turboLoraOn = p.turboLoraEnabled !== false

  // ─── (правка 146) Режим генерации ───
  const mode: 'ref' | 't2v' | 'flf' = p.mode === 't2v' || p.mode === 'flf' ? p.mode : 'ref'

  // ─── Reference images (max 9) — только в режиме 'ref' ───
  const refCount = mode === 'ref' ? Math.min(p.refImages.length, 9) : 0
  const refImageNodes: Record<string, unknown> = {}
  const refImageLinks: Record<string, unknown> = {}

  for (let i = 0; i < refCount; i++) {
    const loadId = REF_IMAGE_NODE_IDS[i]
    refImageNodes[loadId] = {
      inputs: { image: p.refImages[i] },
      class_type: 'LoadImage',
      _meta: { title: `Reference ${i + 1}` },
    }
    refImageLinks[`ref_images.ref_image_${i}`] = [loadId, 0]
  }

  // ─── Reference videos (max 3) — VHS_LoadVideo → IMAGE frames + optional AUDIO — только 'ref' ───
  const refVideoCount = mode === 'ref' ? Math.min(p.refVideos?.length ?? 0, 3) : 0
  const refVideoNodes: Record<string, unknown> = {}
  const refVideoLinks: Record<string, unknown> = {}

  for (let i = 0; i < refVideoCount; i++) {
    const vid = p.refVideos![i]
    const nodeId = REF_VIDEO_NODE_IDS[i]
    refVideoNodes[nodeId] = {
      inputs: { video: vid.path, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 },
      class_type: 'VHS_LoadVideo',
      _meta: { title: `Video Ref ${i + 1}` },
    }
    // output[0] = IMAGE (frames) → ref_video_N
    refVideoLinks[`ref_videos.ref_video_${i}`] = [nodeId, 0]
    // If includeAudio, wire output[2] = AUDIO → ref_video_audio_N
    if (vid.includeAudio !== false) {
      refVideoLinks[`ref_video_audios.ref_video_audio_${i}`] = [nodeId, 2]
    }
  }

  // ─── Standalone audio references (max 3) — LoadAudio → AUDIO ───
  // (правка 146) в режимах ref они идут в ref_audio_N основной ноды,
  // в t2v/flf — в цепочку MiniMaxH3AddGuide (см. ниже).
  const refAudioCount = Math.min(p.refAudios?.length ?? 0, 3)
  const refAudioNodes: Record<string, unknown> = {}
  const refAudioLinks: Record<string, unknown> = {}

  for (let i = 0; i < refAudioCount; i++) {
    const nodeId = REF_AUDIO_NODE_IDS[i]
    refAudioNodes[nodeId] = {
      inputs: { audio: p.refAudios![i] },
      class_type: 'LoadAudio',
      _meta: { title: `Audio Ref ${i + 1}` },
    }
    if (mode === 'ref') {
      refAudioLinks[`ref_audios.ref_audio_${i}`] = [nodeId, 0]
    }
  }

  // ─── H3 node inputs ───
  // Resolution: pass 1 всегда lowResMP (кроме flf — там finalRes, правка 153)
  // (правка 152) В режиме flf с известными размерами кадра — используем их пропорцию
  let aspect = p.aspectRatio || '16:9 (Widescreen)'
  // (правка 152) Если есть размеры первого кадра — пересчитываем aspect ratio из них
  if (mode === 'flf' && p.firstFrameWidth && p.firstFrameHeight) {
    const ratio = p.firstFrameWidth / p.firstFrameHeight
    // Находим ближайший стандартный aspect ratio
    if (Math.abs(ratio - 21/9) < 0.2) aspect = '21:9 (Ultrawide)'
    else if (Math.abs(ratio - 16/9) < 0.15) aspect = '16:9 (Widescreen)'
    else if (Math.abs(ratio - 9/16) < 0.15) aspect = '9:16 (Portrait Widescreen)'
    else if (Math.abs(ratio - 1) < 0.1) aspect = '1:1 (Square)'
    else if (Math.abs(ratio - 4/3) < 0.15) aspect = '4:3 (Standard)'
    else if (Math.abs(ratio - 3/4) < 0.15) aspect = '3:4 (Portrait Standard)'
    else if (Math.abs(ratio - 3/2) < 0.15) aspect = '3:2 (Photo)'
    else if (Math.abs(ratio - 2/3) < 0.15) aspect = '2:3 (Portrait Photo)'
    else aspect = '16:9 (Widescreen)'
  }
  // (правка 153) В режиме flf pass 1 генерируется в ТОМ ЖЕ разрешении, что и pass 2.
  // Причина: keyframe кодируется ОДИН раз (vae.encode) под разрешение pass 1.
  // Если pass 1 ≠ pass 2, апскейлер масштабирует latent, но keyframe latent
  // остаётся "старым" (low-res) → фикс 149 перекодирует его под pass 2, но
  // vae.encode() под разными разрешениями даёт РАЗНЫЕ latent'ы → модель видит
  // "два разных кадра" → ghosting/двоение.
  //
  // Решение: в flf pass 1 = pass 2 разрешение. Тогда:
  //   1. Keyframe кодируется один раз под это разрешение
  //   2. Pass 1 работает в этом разрешении — keyframe latent совпадает
  //   3. Upscaler делает early-return (w_out == w_in && h_out == h_in)
  //   4. Pass 2 работает в том же разрешении — keyframe latent ИДЕНТИЧЕН pass 1
  //
  // Это устраняет "задвоение" в режиме кадров.
  //
  // ВАЖНО: selectResolution() и finalDimsFromMegapixels() используют РАЗНЫЕ
  // формулы (Math.round vs pyRound, разные расчёты scale), поэтому даже при
  // одном MP могут дать разные размеры. Чтобы гарантировать early-return
  // апскейлера, в flf мы: (а) считаем lowRes через selectResolution или из
  // targetDimensions, (б) передаём его как final — тогда final = computeFinalDimensions
  // даст genW = lowRes.w, genH = lowRes.h (ceil32 уже сделан).
  // (правка 155) В flf с пресетом (480p/720p/1080p) targetDimensions = номинал,
  // чтобы 480p и 720p давали разные разрешения (480×854 vs 720×1280 для 9:16).
  // Без пресета — finalRes MP (по умолчанию 0.7).
  const flfSinglePass = mode === 'flf'
  // (правка 156) В режиме flf single-pass: pass 1 должен генерироваться в ТОМ ЖЕ
  // разрешении, что и pass 2. Если есть targetDimensions — используем их для lowRes,
  // иначе finalRes MP. Это гарантирует, что lowRes == final и апскейлер делает
  // early-return (нет масштабирования → нет изменения пропорций).
  // ВАЖНО: ComfyUI требует кратность 32 для latent-размеров. targetDimensions из
  // пресетов (480×854, 720×1280) не кратны 32 — округляем до кратного 32 (ceil32).
  const h3ResMP = flfSinglePass ? finalRes : lowResMP
  const lowRes = flfSinglePass && p.targetDimensions
    ? {
        w: Math.max(32, Math.ceil(p.targetDimensions.width / 32) * 32),
        h: Math.max(32, Math.ceil(p.targetDimensions.height / 32) * 32),
      }
    : selectResolution(aspect, h3ResMP)
  // (правка 124) Точное соотношение сторон + ТОЧНОЕ итоговое разрешение:
  //   • пресеты качества — номинальные размеры (targetDimensions),
  //     gen = ceil32(nominal), апскейлер «target dimensions», итог —
  //     кроп ровно до номинала (16:9 1080p → 1920×1088 → 1920×1080);
  //   • свободное разрешение — бинарные MP узла + вписанный кроп
  //     (finalDimsFromMegapixels).
  // (правка 153) В flf single-pass: final = computeFinalDimensions(nominal)
  // — апскейлер делает early-return, keyframe latent остаётся идентичным.
  // (правка 155) В flf с targetDimensions — используем номинал (480p/720p/1080p),
  // без — lowRes (из finalRes MP).
  // computeFinalDimensions / finalDimsFromMegapixels — единый источник
  // истины для workflow (target dimensions + ImageCrop), метаданных
  // (pending-meta, use-video-gen) и UI-бейджей — везде один результат.
  // (правка 156) В режиме flf final = lowRes (ceil32) — апскейлер делает
  // early-return (w_out == w_in && h_out == h_in), нет масштабирования.
  // В других режимах — targetDimensions (номинал) или finalRes MP.
  const final = flfSinglePass
    ? computeFinalDimensions(lowRes.w, lowRes.h)
    : p.targetDimensions
      ? computeFinalDimensions(p.targetDimensions.width, p.targetDimensions.height)
      : finalDimsFromMegapixels(aspect, finalRes)
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH
  // (правка 146) Главный H3-узел зависит от режима: референсы →
  // MiniMaxH3ReferenceToVideo (как раньше), t2v/flf → MiniMaxH3ImageToVideo
  // (+ LoadImage ноды кадров для flf). Выходы у обеих одинаковые
  // (conditioning + latent) — весь последующий конвейер не меняется.
  const flfNodes: Record<string, unknown> = {}
  let h3Class = 'MiniMaxH3ReferenceToVideo'
  let h3Title = 'MiniMax H3 Reference to Video'
  let h3Inputs: Record<string, unknown>
  if (mode === 'ref') {
    h3Inputs = {
      prompt: p.prompt,
      width: lowRes.w,
      height: lowRes.h,
      length: ['46:19', 1],
      ref_image_size: p.refImageSize || 'match', // (правка 58) match | max — из доп. настроек
      clip: ['46:15', 0],
      vae: ['46:3', 0],
      audio_vae: ['46:4', 0],
      ...refImageLinks,
      ...refVideoLinks,
      ...refAudioLinks,
    }
  } else {
    h3Class = 'MiniMaxH3ImageToVideo'
    h3Title = mode === 'flf'
      ? 'MiniMax H3 First/Last Frame to Video'
      : 'MiniMax H3 Text to Video'
    h3Inputs = {
      prompt: p.prompt,
      width: lowRes.w,
      height: lowRes.h,
      length: ['46:19', 1],
      clip: ['46:15', 0],
      vae: ['46:3', 0],
    }
    if (mode === 'flf') {
      if (!p.firstFrame) {
        throw new Error('Режим «первый/последний кадр»: не задан первый кадр')
      }
      flfNodes[FIRST_FRAME_NODE_ID] = {
        inputs: { image: p.firstFrame },
        class_type: 'LoadImage',
        _meta: { title: 'First frame' },
      }
      h3Inputs.first_frame = [FIRST_FRAME_NODE_ID, 0]
      if (p.lastFrame) {
        flfNodes[LAST_FRAME_NODE_ID] = {
          inputs: { image: p.lastFrame },
          class_type: 'LoadImage',
          _meta: { title: 'Last frame' },
        }
        h3Inputs.last_frame = [LAST_FRAME_NODE_ID, 0]
      }
    }
  }

  // (правка 146) t2v/flf: аудио-референсы подаются цепочкой MiniMaxH3AddGuide —
  // у MiniMaxH3ImageToVideo аудио-входов нет. Каждый гайд якорит свой аудио на
  // кадр 0 (озвучка всего клипа); conditioning следующих узлов идёт с хвоста
  // цепочки.
  const audioGuideNodes: Record<string, unknown> = {}
  let condSrc: [string, number] = ['46:11', 0]
  if (mode !== 'ref' && refAudioCount > 0) {
    for (let i = 0; i < refAudioCount; i++) {
      const gid = AUDIO_GUIDE_NODE_IDS[i]
      audioGuideNodes[gid] = {
        inputs: {
          positive: condSrc,
          latent: ['46:11', 1],
          frame_idx: 0,
          audio: [REF_AUDIO_NODE_IDS[i], 0],
          audio_vae: ['46:4', 0],
        },
        class_type: 'MiniMaxH3AddGuide',
        _meta: { title: `Audio Guide ${i + 1}` },
      }
      condSrc = [gid, 0]
    }
  }

  // ─── Model optimization chain (optional nodes) ───
  // UNET → [LowVRAM] → [ChunkFF] → (LoRA input). `modelSrc` walks down
  // the chain as nodes get enabled, so the LoRA always receives the
  // last patch in the chain (or the raw UNET when both are off).
  const lowVram = p.lowVramAttention !== false
  const chunkFF = p.chunkFeedForward !== false
  const modelNodes: Record<string, unknown> = {}
  let modelSrc: [string, number] = ['46:30', 0]
  if (lowVram) {
    modelNodes['46:43'] = {
      inputs: { head_chunks: 4, model: modelSrc },
      class_type: 'MiniMaxLowVRAMAttention',
      _meta: { title: 'Low VRAM Attention' },
    }
    modelSrc = ['46:43', 0]
  }
  if (chunkFF) {
    modelNodes['46:40'] = {
      inputs: {
        chunks: Math.max(1, Math.round(p.chunkFFChunks ?? 2)),
        seq_threshold: Math.max(0, Math.round(p.chunkFFThreshold ?? 4096)),
        model: modelSrc,
      },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  const workflow: Record<string, unknown> = {
    // ═══════════════════════════════════════════════
    //  INPUTS
    // ═══════════════════════════════════════════════

    // Duration → Frames calculation
    '17': {
      inputs: { value: p.duration },
      class_type: 'PrimitiveFloat',
      _meta: { title: 'Duration (seconds)' },
    },
    '46:19': {
      inputs: {
        expression: 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17',
        'values.a': ['17', 0],
      },
      class_type: 'ComfyMathExpression',
      _meta: { title: 'Frames Calculation' },
    },

    // Low-res resolution is computed server-side (selectResolution) and fed
    // to the H3 node as plain ints — no ResolutionSelector node needed
    // (it cannot express e.g. 2.35:1).

    // (правка 124) Нода '23' (PrimitiveFloat final MP) удалена: апскейлер
    // получает точные размеры напрямую (mode.width / mode.height).

    // ═══════════════════════════════════════════════
    //  MODEL LOADING
    // ═══════════════════════════════════════════════

    '46:30': {
      inputs: {
        // (правка 148) Дефолт — FastVideo VSA DataFree 1300-step 4-step int8 convrot
        unet_name: p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Загрузить модель диффузии' },
    },
    '46:15': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'Загрузить CLIP' },
    },
    '46:3': {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (video)' },
    },
    '46:4': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },

    // ═══════════════════════════════════════════════
    //  MODEL OPTIMIZATION CHAIN (optional nodes)
    //  UNET → [LowVRAM] → [ChunkFF] → LoRA → SigmaShift → Attention → Preview
    // ═══════════════════════════════════════════════

    ...modelNodes,

    // LoRA (default: ref2v turbo v0.1 @ 1.0; правка 90 — заменяемая и
    // отключаемая из настроек). При отключении узел не попадает в workflow,
    // и цепочка кастомных LoRA начинается прямо с конца цепочки оптимизации.
    ...(turboLoraOn && {
      '46:36': {
        inputs: {
          lora_name: p.turboLoraName || 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
          strength_model: turboStrength, // (правка 70) влияние из доп. настроек, default 1.0
          model: modelSrc,
        },
        class_type: 'LoraLoaderModelOnly',
        _meta: { title: 'Загрузчик LoRA (Turbo)' },
      },
    }),
    // Custom LoRAs chained after turbo (правка 44)
    ...buildCustomLoraNodes(p.customLoras, turboLoraOn ? ['46:36', 0] : modelSrc),
    // Sigma Shift (receives last node in the LoRA chain)
    '46:38': {
      inputs: {
        shift_video: 12,
        shift_audio: 3,
        model: getLastLoraOutput(p.customLoras, turboLoraOn ? ['46:36', 0] : modelSrc),
      },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },
    // Attention Backend
    '46:37': {
      inputs: {
        attention: 'comfy kitchen attention',
        model: ['46:38', 0],
      },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },
    // Live Preview (attached to pass 1 only)
    '12': {
      inputs: {
        model: ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        preview_frames: ['46:19', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },

    // ═══════════════════════════════════════════════
    //  MAIN H3 NODE (Reference to Video)
    // ═══════════════════════════════════════════════

    '46:11': {
      inputs: h3Inputs,
      class_type: h3Class,
      _meta: { title: h3Title },
    },

    // (правка 146) flf: LoadImage первого/последнего кадра
    ...flfNodes,
    // (правка 146) t2v/flf: цепочка аудио-гайдов
    ...audioGuideNodes,

    // ═══════════════════════════════════════════════
    //  SAMPLING COMMON
    // ═══════════════════════════════════════════════

    // (правки 67, 70) Pass 1: сэмплер + планировщик на выбор (default euler / simple).
    // (правки 68–69) Pass 2: сэмплер на выбор (default euler) —
    // сигмы остаются ManualSigmas.
    '46:18a': {
      inputs: { sampler_name: pass1Sampler },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler Pass 1 (${pass1Sampler})` },
    },
    '46:18': {
      inputs: { sampler_name: pass2Sampler },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler Pass 2 (${pass2Sampler})` },
    },
    '46:31': {
      inputs: { noise_seed: seed },
      class_type: 'RandomNoise',
      _meta: { title: 'Случайный шум' },
    },

    // ═══════════════════════════════════════════════
    //  PASS 1: Low-res (0.2 MP, 4 total steps → split to 2)
    // ═══════════════════════════════════════════════

    // BasicScheduler: firstSteps*2 total, планировщик на выбор (правки 67, 70; было simple)
    '46:24': {
      inputs: {
        scheduler: pass1Scheduler,
        steps: firstSteps * 2,
        denoise: 1,
        model: ['46:30', 0],
      },
      class_type: 'BasicScheduler',
      _meta: { title: `Pass 1 Scheduler (${firstSteps * 2} steps, ${pass1Scheduler})` },
    },
    // SplitSigmas: take first firstSteps of the total
    '46:13': {
      inputs: {
        step: firstSteps,
        sigmas: ['46:24', 0],
      },
      class_type: 'SplitSigmas',
      _meta: { title: `Split Sigmas (take ${firstSteps})` },
    },
    // BasicGuider (pass 1 — uses Preview model)
    '46:29': {
      inputs: {
        model: ['12', 0],
        conditioning: condSrc, // (правка 146) хвост цепочки аудио-гайдов в t2v/flf
      },
      class_type: 'BasicGuider',
      _meta: { title: 'Pass 1 Guider' },
    },
    // SamplerCustomAdvanced (pass 1) — split-сигмы (firstSteps из total) — черновой low-res проход
    '46:21': {
      inputs: {
        noise: ['46:31', 0],
        guider: ['46:29', 0],
        sampler: ['46:18a', 0],
        sigmas: ['46:13', 0],
        latent_image: ['46:11', 1],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Pass 1 Sampler (low-res, split sigmas)' },
    },

    // ═══════════════════════════════════════════════
    //  LATENT UPSAMPLE
    // ═══════════════════════════════════════════════

    // Separate AV latent from pass 1
    '46:35': {
      inputs: { av_latent: ['46:21', 1] },
      class_type: 'LTXVSeparateAVLatent',
      _meta: { title: 'Separate AV Latent' },
    },
    // Upscale video latent to target resolution
    // (правка 124) Режим «target dimensions»: узел выдаёт ровно genW×genH,
    // независимо от пропорции pass 1 (megapixels-mode держал пропорцию
    // входа и округлял оси — из-за этого 16:9 не получалось точным).
    '46:26': {
      inputs: {
        model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
        mode: 'target dimensions',
        'mode.width': final.genW,
        'mode.height': final.genH,
        align: 32,
        enable_chunking: true, // (правка 68) было false — по запросу юзера
        device: 'cuda',
        precision: 'fp16',
        latent: ['46:35', 0],
      },
      class_type: 'MinimaxH3LatentUpscaler3D',
      _meta: { title: `Latent Upscaler (3D) → ${final.genW}×${final.genH}` },
    },
    // Re-combine upscaled video + audio latent
    '46:10': {
      inputs: {
        video_latent: ['46:26', 0],
        audio_latent: ['46:35', 1],
      },
      class_type: 'LTXVConcatAVLatent',
      _meta: { title: 'Concat AV Latent' },
    },

    // ═══════════════════════════════════════════════
    //  PASS 2: High-res refinement (3 steps)
    // ═══════════════════════════════════════════════

    // ManualSigmas for pass 2 (configurable variant)
    '46:33': {
      inputs: {
        sigmas: sigmaVariant,
      },
      class_type: 'ManualSigmas',
      _meta: { title: `Pass 2 Sigmas (${(p.sigmaVariant || '3step')})` },
    },
    // Live Preview (attached to pass 2)
    '13': {
      inputs: {
        model: ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        preview_frames: ['46:19', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override (Pass 2)' },
    },
    // BasicGuider (pass 2 — uses Preview model)
    '46:32': {
      inputs: {
        model: ['13', 0],
        conditioning: condSrc, // (правка 146) хвост цепочки аудио-гайдов в t2v/flf
      },
      class_type: 'BasicGuider',
      _meta: { title: 'Pass 2 Guider' },
    },
    // SamplerCustomAdvanced (pass 2)
    '46:16': {
      inputs: {
        noise: ['46:31', 0],
        guider: ['46:32', 0],
        sampler: ['46:18', 0],
        sigmas: ['46:33', 0],
        latent_image: ['46:10', 0],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Pass 2 Sampler (high-res)' },
    },

    // ═══════════════════════════════════════════════
    //  DECODE (separate video + audio)
    // ═══════════════════════════════════════════════

    '46:25': {
      inputs: {
        samples: ['46:16', 0],
        vae: ['46:3', 0],
      },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode Video' },
    },

    // (правка 124) Кроп gen-разрешения (кратное 32, чуть больше номинала)
    // до ТОЧНОГО номинала (например 16:9 1080p: 1920×1088 → 1920×1080).
    // Нода ставится только когда gen ≠ номинал — иначе цепочка без изменений.
    ...(needsCrop && {
      '46:48': {
        inputs: {
          image: ['46:25', 0],
          width: final.outW,
          height: final.outH,
          x: final.cropX,
          y: final.cropY,
        },
        class_type: 'ImageCrop',
        _meta: { title: `Точный кроп → ${final.outW}×${final.outH}` },
      },
    }),
    '46:14': {
      inputs: {
        samples: ['46:16', 0],
        vae: ['46:4', 0],
      },
      class_type: 'VAEDecodeAudio',
      _meta: { title: 'Decode Audio' },
    },

    // ═══════════════════════════════════════════════
    //  OUTPUT
    // ═══════════════════════════════════════════════

    '45': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        // (правка 91) Подпапка = папка проекта: VHS пишет в output/<folder>/.
        // Имя уже санитизировано на сервере (generate-роут, один сегмент).
        filename_prefix: p.outputSubfolder ? `${p.outputSubfolder}/Minimax_Studio` : 'Minimax_Studio',
        format: 'video/h264-mp4',
        pix_fmt: 'yuv420p',
        crf: 12,
        save_metadata: false,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
        // (правка 121) через кроп-ноду, если соотношению нужен точный кроп
        images: needsCrop ? ['46:48', 0] : ['46:25', 0],
        audio: ['46:14', 0],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine' },
    },

    // ─── Reference image nodes (правка 55: up to 9) ───
    ...refImageNodes,

    // ─── Reference video nodes (VHS_LoadVideo) ───
    ...refVideoNodes,

    // ─── Reference audio nodes (LoadAudio) ───
    ...refAudioNodes,
  }

  return workflow
}
