/**
 * Central runtime app configuration, backed by config.ini next to the
 * project root. The backend folder (portable ComfyUI-Easy-Install root)
 * is user-configurable from the Settings dialog — all file routes read
 * it through getAppConfig() so a change applies without a restart.
 *
 * Precedence for the backend root:
 *   1. config.ini [comfy] comfy_dir
 *   2. env COMFY_ROOT
 *   3. ./ComfyUI-Easy-Install (default, next to the app)
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join, resolve } from 'path'

const CONFIG_PATH = join(process.cwd(), 'config', 'config.ini')

export interface AppConfig {
  reserveGb: number
  dynamicVram: boolean
  /** LLM assistant device: 'auto' (VRAM-based) | 'gpu' | 'cpu'. */
  llmDevice: 'auto' | 'gpu' | 'cpu'
  /** LLM context window size in tokens. */
  llmContextSize: number
  /** Max output tokens per LLM response (clamped to fit inside the context window). */
  llmMaxOutputTokens: number
  /** Root of the portable backend install (contains ComfyUI/ and python_embeded/). */
  comfyRoot: string
  /** ComfyUI output directory (gallery files). */
  outputDir: string
  /** ComfyUI input directory (reference uploads). */
  inputDir: string
  /** Embedded python executable for launching the backend. */
  pythonExe: string
  /** Custom diffusion model filename (empty = default). */
  diffusionModel: string
  /** Custom LLM model filename (empty = default Q4_K_M). */
  llmModel: string
  /** (правка 136 / Bonsai) Папка портативной сборки Bonsai 2 27B (llama.cpp\
   * + models). Модель ассистента llmModel='bonsai' запускается из неё. */
  llmBonsaiDir: string
  /** (правка 53) Ассистент смотрит кадры видео-референсов. Выкл по умолчанию:
   *  модель знает только о НАЛИЧИИ видео (экономия контекста). */
  llmVideoVision: boolean
  /** (правка 109) Квантизация KV-кэша LLM: 'off' (fp16) | 'q8_0' | 'q5_1' | 'q4_0'.
   *  Уменьшает потребление VRAM/RAM ценой небольшого падения качества. */
  llmKvCache: 'off' | 'q8_0' | 'q5_1' | 'q4_0'
  /** (правка 135b) Тонкая настройка сэмплинга LLM — ВКЛ/ВЫКЛ. */
  llmSamplingOverride: boolean
  /** (правка 135b) temperature — переопределение (если override вкл). */
  llmTemperature: number
  /** (правка 135b) top_p — переопределение (если override вкл). */
  llmTopP: number
  /** (правка 135b) top_k — переопределение (если override вкл). */
  llmTopK: number
  /** (правка 135b) min_p — переопределение (если override вкл). */
  llmMinP: number
  /** (правка 135b) presence_penalty — переопределение (если override вкл). */
  llmPresencePenalty: number
  /** (правка 135b) frequency_penalty — переопределение (если override вкл). */
  llmFrequencyPenalty: number
  /** (правка 135b) repeat_penalty — переопределение (если override вкл). */
  llmRepeatPenalty: number
  /** Play notification sound when generation completes (default true). */
  soundOn: boolean
  /** (правка 65) Голосовой ввод (whisper STT): включён ли диктат в UI. */
  sttEnabled: boolean
  /** (правка 72) Папка встроенного STT-рантайма (transcribe.dll + models/). Дефолт <проект>/stt. */
  sttDir: string
  /** (правка 65) Файл модели STT (имя в папках моделей; пусто = авто). */
  sttModel: string
  /** (правка 65) Язык распознавания: 'ru' | 'en' | 'auto'. */
  sttLanguage: string
  /** (правка 65) Потоки CPU (0 = авто). */
  sttThreads: number
  /** (правка 74) Вкладка Upscale (DLSS 5 Visual Enhancer): сервис включён. */
  upscaleEnabled: boolean
  /** (правка 74) Порт DLSS-моста Upscale (bridge.py, дефолт 7890). */
  upscalePort: number
}

/* ────────────────────────── INI parsing ────────────────────────── */

function parseIni(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  let currentSection = ''
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1)
      continue
    }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      result[`${currentSection}.${key}`] = value
      result[key] = value
    }
  }
  return result
}

/* ────────────────────────── Cached reads ────────────────────────── */

let cache: { mtimeMs: number; config: AppConfig } | null = null

export function getAppConfig(): AppConfig {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(CONFIG_PATH).mtimeMs
  } catch {
    /* no config.ini yet — use defaults below */
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.config

  let ini: Record<string, string> = {}
  try {
    if (existsSync(CONFIG_PATH)) ini = parseIni(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    /* unreadable config — fall back to defaults */
  }

  const rawRoot =
    (ini['comfy.comfy_dir'] ?? '').trim() ||
    (process.env.COMFY_ROOT || '').trim() ||
    join(process.cwd(), 'ComfyUI-Easy-Install')
  const comfyRoot = resolve(rawRoot)

  const config: AppConfig = {
    reserveGb: parseFloat(ini['vram.reserve_gb'] ?? ini['reserve_gb'] ?? '3') || 3,
    // Canonical home is [vram]; [comfy]/bare kept as read fallbacks for
    // configs written by older versions.
    dynamicVram: (ini['vram.dynamic_vram'] ?? ini['comfy.dynamic_vram'] ?? ini['dynamic_vram'] ?? '1') !== '0',
    llmDevice: (['auto', 'gpu', 'cpu'].includes(ini['llm.device'] ?? '')
      ? ini['llm.device']
      : 'auto') as AppConfig['llmDevice'],
    // (правка 119) контекст ассистента: по умолчанию 25K, максимум 100K токенов
    llmContextSize: Math.max(8192, Math.min(102400, parseInt(ini['llm.context_size'] ?? '25600', 10) || 25600)),
    llmMaxOutputTokens: Math.max(256, Math.min(16384, parseInt(ini['llm.max_output_tokens'] ?? '4096', 10) || 4096)),
    comfyRoot,
    outputDir: join(comfyRoot, 'ComfyUI', 'output'),
    inputDir: join(comfyRoot, 'ComfyUI', 'input'),
    pythonExe: join(comfyRoot, 'python_embeded', 'python.exe'),
    diffusionModel: (ini['comfy.diffusion_model'] ?? '').trim(),
    llmModel: (ini['llm.model'] ?? '').trim(),
    // (правка 136) Bonsai теперь живёт ВНУТРИ проекта (<проект>/Bonsai_2_27B)
    // — дефолт относительный, проект переносим. Внешний путь при желании
    // задаётся в config.ini: [llm] bonsai_dir=...
    llmBonsaiDir: (ini['llm.bonsai_dir'] ?? '').trim() || join(process.cwd(), 'Bonsai_2_27B'),
    // (правка 53) по умолчанию ВЫКЛ: ассистент не тратит контекст на кадры видео
    llmVideoVision: ini['llm.video_vision'] === '1',
    // (правка 109) квантизация KV-кэша; (правка 119) по умолчанию q4_0 — экономия памяти
    llmKvCache: (['off', 'q8_0', 'q5_1', 'q4_0'].includes(ini['llm.kv_cache'] ?? '')
      ? ini['llm.kv_cache']
      : 'q4_0') as AppConfig['llmKvCache'],
    // (правка 135b) тонкая настройка сэмплинга LLM — по умолчанию ВЫКЛ,
    // тогда route.ts использует модель-осознанные значения из llm-sampling.ts.
    // Если ВКЛ — пользовательские значения ниже применяются.
    llmSamplingOverride: ini['llm.sampling_override'] === '1',
    llmTemperature: parseFloat(ini['llm.temperature'] ?? '0.7') || 0.7,
    llmTopP: parseFloat(ini['llm.top_p'] ?? '0.95') || 0.95,
    llmTopK: Math.max(1, Math.min(200, parseInt(ini['llm.top_k'] ?? '40', 10) || 40)),
    llmMinP: Math.max(0, Math.min(1, parseFloat(ini['llm.min_p'] ?? '0.05') || 0.05)),
    llmPresencePenalty: Math.max(0, Math.min(2.5, parseFloat(ini['llm.presence_penalty'] ?? '0.0') || 0.0)),
    llmFrequencyPenalty: Math.max(0, Math.min(2.5, parseFloat(ini['llm.frequency_penalty'] ?? '0.0') || 0.0)),
    llmRepeatPenalty: Math.max(1.0, Math.min(2.0, parseFloat(ini['llm.repeat_penalty'] ?? '1.0') || 1.0)),
    soundOn: ini['ui.sound_on'] !== '0',
    // (правка 65) Голосовой ввод — whisper (transcribe.cpp), CPU-only.
    // По умолчанию ВКЛ: кнопка диктата видна, а при отсутствии модели
    // показывает понятную ошибку с подсказкой, где её скачать.
    sttEnabled: ini['stt.enabled'] !== '0',
    // (правка 72) STT-рантайм встроен в проект: <проект>/stt (переопределяется в config.ini).
    sttDir: (ini['stt.dir'] ?? '').trim() || join(process.cwd(), 'stt'),
    sttModel: (ini['stt.model'] ?? '').trim(),
    sttLanguage: (['auto', 'ru', 'en'].includes(ini['stt.language'] ?? '')
      ? ini['stt.language']
      : 'ru') as string,
    sttThreads: Math.max(0, Math.min(32, parseInt(ini['stt.threads'] ?? '0', 10) || 0)),
    // (правка 74) Upscale (DLSS 5 Visual Enhancer) — встроенная папка upscale/.
    upscaleEnabled: ini['upscale.enabled'] !== '0',
    upscalePort: Math.max(1024, Math.min(65535, parseInt(ini['upscale.port'] ?? '7890', 10) || 7890)),
  }
  cache = { mtimeMs, config }
  return config
}

/* ────────────────────────── Writing ────────────────────────── */

/**
 * Set a single `key = value` line inside an INI section, preserving the
 * rest of the file. Creates the section when missing. Resets the cache.
 */
export function setConfigValue(section: string, key: string, value: string): void {
  let content = ''
  try {
    content = readFileSync(CONFIG_PATH, 'utf-8')
  } catch {
    content = ''
  }
  // A newline inside a value would corrupt the INI layout — strip
  // line breaks and other control characters defensively.
  const safeValue = value.replace(/[\r\n\0]/g, ' ').trim()
  const lines = content.split(/\r?\n/)

  let inSection = false
  let sectionStart = -1
  let replaced = false
  let insertAt = -1

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('[') && t.endsWith(']')) {
      if (inSection) break // reached the next section
      inSection = t.slice(1, -1) === section
      if (inSection) sectionStart = i
      continue
    }
    if (inSection) {
      if (t.toLowerCase().startsWith(key.toLowerCase() + '=')) {
        lines[i] = `${key}=${safeValue}`
        replaced = true
        break
      }
      insertAt = i + 1 // after the last line inside the section
    }
  }

  if (!replaced) {
    if (sectionStart >= 0) {
      lines.splice(sectionStart + 1, 0, `${key}=${safeValue}`)
    } else {
      lines.push('', `[${section}]`, `${key}=${safeValue}`)
    }
  }

  writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf-8')
  cache = null
}
