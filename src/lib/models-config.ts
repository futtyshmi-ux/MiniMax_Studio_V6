/**
 * Model registry — defines all required models with their download URLs
 * and target paths relative to the ComfyUI root.
 */

export interface ModelDef {
  id: string
  label: string
  /** Relative path from ComfyUI root (e.g. "diffusion_models/xxx.safetensors") */
  relPath: string
  /** Direct download URL */
  url: string
  /** Approximate file size in bytes (for display) */
  sizeBytes: number
  /** Human-readable size */
  sizeLabel: string
  /** Category for grouping in UI */
  category: 'diffusion' | 'text_encoder' | 'vae' | 'lora' | 'upscaler' | 'preview' | 'llm'
  /** (правка 138 / Bonsai) Куда класть файл: 'comfy' (по умолчанию —
   *  ComfyUI/models/<relPath>) или 'bonsai' (<bonsai_dir>/<relPath>). */
  target?: 'comfy' | 'bonsai'
  /** (правка 138 / Bonsai) URL указывает на ZIP: после скачивания извлечь
   *  ТОЛЬКО эти файлы (рекурсивный поиск по архиву) в каталог relPath. */
  extractFiles?: string[]
  /** (правка 138) Опциональная модель: панель показывает, но «Скачать все»
   *  НЕ тянет (лишние гигабайты без ведома пользователя). */
  optional?: boolean
}

function gb(n: number): number {
  return Math.round(n * 1024 * 1024 * 1024)
}

export const MODELS: ModelDef[] = [
  {
    id: 'diffusion',
    // (правка 159) Основная модель — FastVideo VSA DataFree 1300-step 4-step int8 convrot
    // (Kijai/MiniMax-H3-experimental). Быстрая 4-шаговая генерация, ~22.9 ГБ.
    label: 'Diffusion Model (FastVideo VSA DataFree 1300-step 4-step int8 convrot)',
    relPath: 'diffusion_models/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
    url: 'https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/main/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors?download=true',
    sizeBytes: gb(22.9),
    sizeLabel: '~22.9 GB',
    category: 'diffusion',
  },
  {
    id: 'text_encoder',
    label: 'Text Encoder (Qwen3VL 32B NVFP4)',
    relPath: 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors?download=true',
    sizeBytes: gb(15.7),
    sizeLabel: '~15.7 GB',
    category: 'text_encoder',
  },
  {
    id: 'vae_video',
    label: 'Video VAE (INT8 ConvRot)',
    relPath: 'vae/minimax_h3_video_vae_int8_convrot.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors?download=true',
    sizeBytes: gb(2.6),
    sizeLabel: '~2.6 GB',
    category: 'vae',
  },
  {
    id: 'vae_audio',
    label: 'Audio VAE (FP32)',
    relPath: 'vae/minimax_h3_audio_vae_fp32.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors?download=true',
    sizeBytes: gb(0.6),
    sizeLabel: '~0.6 GB',
    category: 'vae',
  },
  {
    id: 'lora_turbo',
    label: 'Turbo LoRA (4-step v0.1)',
    relPath: 'loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors?download=true',
    sizeBytes: 1956193000,
    sizeLabel: '~1.9 GB',
    category: 'lora',
  },
  {
    id: 'upscaler',
    label: 'Latent Upscaler 3D (FP16)',
    relPath: 'latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16.safetensors',
    url: 'https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors?download=true',
    sizeBytes: 691 * 1024 * 1024,
    sizeLabel: '~691 MB',
    category: 'upscaler',
  },
  {
    id: 'tae_preview',
    label: 'TAE Preview Decoder (taeh3)',
    relPath: 'vae_approx/taeh3.safetensors',
    url: 'https://huggingface.co/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors?download=true',
    sizeBytes: 9_790_000,
    sizeLabel: '~9.8 MB',
    category: 'preview',
  },
  {
    id: 'llm_assistant',
    label: 'Ассистент — Gemma 4 12B (Q4_K_M, omni)',
    relPath: 'llm/gemma-4-12b-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q4_K_M.gguf?download=true',
    sizeBytes: gb(7.12),
    sizeLabel: '~7.1 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_q3',
    label: 'Ассистент — Gemma 4 12B (Q3_K_M, лёгкая, ~8 ГБ VRAM)',
    relPath: 'llm/gemma-4-12b-it-Q3_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q3_K_M.gguf?download=true',
    sizeBytes: gb(5.6),
    sizeLabel: '~5.6 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_q5',
    label: 'Ассистент — Gemma 4 12B (Q5_K_M, качество, ~12 ГБ VRAM)',
    relPath: 'llm/gemma-4-12b-it-Q5_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q5_K_M.gguf?download=true',
    sizeBytes: gb(8.6),
    sizeLabel: '~8.6 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_mmproj',
    label: 'Vision Projector (mmproj BF16) — для зрения LLM',
    relPath: 'llm/mmproj-BF16.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/mmproj-BF16.gguf?download=true',
    sizeBytes: 175 * 1024 * 1024,
    sizeLabel: '~175 MB',
    category: 'llm',
  },
  // ── Qwen3.5 9B (правка 52) — альтернативная LLM для слабых машин: ──
  // мультимодальная (картинка + видео), ~5.7 ГБ Q4 против 7.1 у Gemma 12B,
  // гибрид Gated DeltaNet → экономнее по KV-кэшу. Нужен свежий llama.cpp
  // (архитектура qwen35) — пользователь тестирует на своём железе.
  // Файлы в подпапке llm/qwen3.5-9b/, чтобы не конфликтовать с Gemma.
  {
    id: 'llm_assistant_qwen',
    label: 'Ассистент — Qwen3.5 9B (Q4_K_M, vision, лёгкая по VRAM)',
    relPath: 'llm/qwen3.5-9b/Qwen3.5-9B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf?download=true',
    sizeBytes: gb(5.68),
    sizeLabel: '~5.7 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_qwen_mmproj',
    label: 'Vision Projector (Qwen3.5 mmproj F16) — зрение для Qwen3.5 9B',
    relPath: 'llm/qwen3.5-9b/mmproj-F16.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf?download=true',
    sizeBytes: 918 * 1024 * 1024,
    sizeLabel: '~920 MB',
    category: 'llm',
  },
  // ── (правка 138) Bonsai 2 27B — тернарная LLM-ассистент на форке llama.cpp
  // (PrismML). Движок и модели живут в <bonsai_dir> (по умолчанию
  // <проект>/Bonsai_2_27B), НЕ в models ComfyUI. Точная версия движка
  // подобрана под кванты модели (prism-b10709-9a9394a, CUDA 12.4).
  {
    id: 'bonsai_engine_bin',
    label: 'Bonsai: движок llama-server (PrismML b10709, бинарники)',
    relPath: 'llama.cpp/',
    target: 'bonsai',
    url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/llama-prism-b10709-9a9394a-bin-win-cuda-12.4-x64.zip',
    sizeBytes: 242 * 1024 * 1024,
    sizeLabel: '~242 MB',
    category: 'llm',
    extractFiles: [
      'llama-server.exe',
      'llama-server-impl.dll',
      'llama-common.dll',
      'llama.dll',
      'mtmd.dll',
      'ggml.dll',
      'ggml-base.dll',
      'ggml-cpu.dll',
      'ggml-cuda.dll',
      'ggml-rpc.dll',
    ],
  },
  {
    id: 'bonsai_engine_cudart',
    label: 'Bonsai: движок — CUDA DLL (cublas/cudart 12.4)',
    relPath: 'llama.cpp/',
    target: 'bonsai',
    url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/cudart-llama-bin-win-cuda-12.4-x64.zip',
    sizeBytes: 373 * 1024 * 1024,
    sizeLabel: '~373 MB',
    category: 'llm',
    extractFiles: ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll'],
  },
  {
    id: 'bonsai_model',
    label: 'Bonsai 2 27B — модель (PQ2_0, тернарная, vision)',
    relPath: 'models/Ternary-Bonsai-2-27B-PQ2_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PQ2_0.gguf?download=true',
    sizeBytes: 7206168928,
    sizeLabel: '~7.2 GB',
    category: 'llm',
  },
  {
    id: 'bonsai_mmproj',
    label: 'Bonsai 2 27B — Vision Projector (mmproj Q8_0)',
    relPath: 'models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf?download=true',
    sizeBytes: 629246976,
    sizeLabel: '~630 MB',
    category: 'llm',
  },
  {
    id: 'bonsai_model_light',
    label: 'Bonsai 2 27B — модель (PTQ1_0, самая лёгкая, ~6 ГБ, для карт ≤8 ГБ)',
    relPath: 'models/Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PTQ1_0.gguf?download=true',
    sizeBytes: 595 * 1024 * 1024,
    sizeLabel: '~5.95 GB',
    category: 'llm',
    // Опциональная: качается только вручную; раннер подхватит её, если
    // основной PQ2_0 не скачан, а PTQ1_0 есть.
    optional: true,
  },
]

/** Group by category for UI display */
export const MODEL_CATEGORIES: { key: ModelDef['category']; label: string }[] = [
  { key: 'diffusion', label: 'Diffusion Model' },
  { key: 'text_encoder', label: 'Text Encoder' },
  { key: 'vae', label: 'VAE' },
  { key: 'lora', label: 'LoRA' },
  { key: 'upscaler', label: 'Upscaler' },
  { key: 'preview', label: 'Preview' },
  { key: 'llm', label: 'LLM-ассистент' },
]
