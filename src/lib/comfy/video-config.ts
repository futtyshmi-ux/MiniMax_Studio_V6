/**
 * Video generation configuration (ComfyUI-compatible).
 * The UI component passes VideoGenerateParams to useVideoGen,
 * which maps them to the ComfyUI workflow (MiniMax H3 Ref2VA).
 */

/** One ref2va reference. `path` is the ComfyUI input/ filename. */
export interface VideoReferenceParam {
  kind: 'image' | 'video' | 'audio'
  /** ComfyUI input/ filename (from /api/comfy/upload). */
  path: string
  /** Free text: who/what this reference is. */
  role?: string
  /** Images: identity | scene | style | composition. */
  imageIntent?: 'identity' | 'scene' | 'style' | 'composition'
  /** Audio: voice | drive | style. */
  audioIntent?: 'voice' | 'drive' | 'style'
  /** Videos: include the reference's own audio track. */
  includeAudio?: boolean
}

/**
 * Parameters from the UI — the hook maps them to the ComfyUI workflow.
 */
export interface VideoGenerateParams {
  /** Model type (kept for UI compatibility; ComfyUI uses the workflow template). */
  modelType: string
  /** (правка 146) Режим генерации: 'ref' (default) | 't2v' | 'flf'. */
  mode?: 'ref' | 't2v' | 'flf'
  /** (правка 146) flf: ComfyUI input/ filename первого кадра. */
  firstFrame?: string
  /** (правка 146) flf: ComfyUI input/ filename последнего кадра. */
  lastFrame?: string
  /** (правка 152) flf: ширина первого кадра в пикселях (для aspect ratio). */
  firstFrameWidth?: number
  /** (правка 152) flf: высота первого кадра в пикселях. */
  firstFrameHeight?: number
  /** Positive prompt (supports <Picture 1>/<Picture 2> tags for refs). */
  prompt: string
  /** Random seed (-1 = random, default: -1). */
  seed?: number
  /** Sampling steps (default 20; turbo: 4). */
  steps?: number
  /** Resolution string — ТОЧНЫЙ номинал (правка 124), e.g. "1280x720", "1920x1080". */
  resolution?: string
  /** Total output frames (H3: 17n+5, min 124). */
  videoLength?: number
  /** Turbo mode (4-step LoRA). */
  turbo?: boolean
  /** Turbo LoRA multiplier 0.1–2.0 (default 0.7). */
  turboWeight?: number
  /** Custom LoRA filename (overrides turbo default). */
  turboLoraName?: string
  /** Non-turbo LoRA filename. */
  loraName?: string
  /** (правка 91) Подпапка вывода — папка проекта галереи ('' = общая). */
  outputSubfolder?: string

  /* ── FL2VA: first/last frame ── */
  imagePromptType?: '' | 'S' | 'E' | 'SE'
  startFramePath?: string
  endFramePath?: string

  /* ── ref2va: reference manifest ── */
  references?: VideoReferenceParam[]
  referenceDetail?: 'match' | 'max'

  /* ── Two-pass latent upscaler ── */
  /** (правка 124) Точные номинальные (финальные) размеры видео — приоритет
   *  над finalResolution: gen = ceil32(nominal), кроп → ровно номинал. */
  targetDimensions?: { width: number; height: number }
  /** Target resolution in MP for the latent upscaler (default 0.7 ≈ 720p;
   *  (правка 124) используется в режиме свободного разрешения). */
  finalResolution?: number
  /** Low-res pass 1 resolution in MP (default 0.2). */
  lowResMP?: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 4, max 30). */
  firstSamplerSteps?: number
  /** Pass 2 sigma variant: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant?: string
  /** (правка 69) Pass 2 sampler (default 'euler'). */
  pass2Sampler?: string
  /** (правка 70) Pass 1 sampler (default 'euler'). */
  pass1Sampler?: string
  /** (правка 70) Pass 1 scheduler (default 'simple'). */
  pass1Scheduler?: string
  /** Enable MiniMaxLowVRAMAttention (head-chunked attention, saves VRAM). */
  lowVramAttention?: boolean
  /** Enable MiniMaxChunkFeedForward (chunked FFN for long sequences). */
  chunkFeedForward?: boolean
  /** ChunkFF: number of feed-forward chunks (default 2). */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold above which chunking kicks in (default 4096). */
  chunkFFThreshold?: number

  /* ── misc ── */
  textEncoder?: string
  negativePrompt?: string
  guidance?: number
  audioGuidance?: number
  [key: string]: unknown
}
