/**
 * Custom LoRA management (правка 44).
 *
 * Stores settings for custom LoRAs in a JSON file in the project root.
 * The built-in turbo LoRA is NOT included in this list.
 *
 * File: loras.json
 * Schema: [{ name: string, strength: number, enabled: boolean, trigger?: string }]
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'

export interface LoraEntry {
  /** Filename in ComfyUI models/loras/ (e.g. "my_lora.safetensors") */
  name: string
  /** Strength (0.0 – 2.0). */
  strength: number
  /** Whether this LoRA is included in generation. */
  enabled: boolean
  /** Trigger words — appended to the prompt when this LoRA is enabled. */
  trigger?: string
}

/** The turbo LoRA filename (excluded from custom list). */
export const TURBO_LORA_NAME = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'

function lorasFile(): string {
  return path.join(process.cwd(), 'data', 'loras.json')
}

export function loadLoras(): LoraEntry[] {
  try {
    const raw = fs.readFileSync(lorasFile(), 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((e) => e && typeof e.name === 'string')
  } catch {
    return []
  }
}

export function saveLoras(entries: LoraEntry[]): void {
  fs.writeFileSync(lorasFile(), JSON.stringify(entries, null, 2), 'utf-8')
}

/**
 * (правка 130) Сброс настроек LoRA к заводским:
 * все лоры выключены (enabled=false), сила по умолчанию (1.0), триггеры очищены.
 * Файл loras.json сохраняется с «чистым» состоянием.
 *
 * (правка 133) По умолчанию после заводского сброса включена стандартная
 * 4-шаговая турбо-лора (TURBO_LORA_NAME) — она нужна для базовой работы
 * генерации. Остальные кастомные лоры выключены.
 */
export function resetLorasToDefaults(): LoraEntry[] {
  const files = listLoraFiles()
  const defaults: LoraEntry[] = files.map((name) => ({
    name,
    strength: 1.0,
    enabled: name === TURBO_LORA_NAME,
    trigger: '',
  }))
  // (правка 133) Если турбо-лоры нет на диске, добавляем запись с enabled=true
  // — при загрузке файла она будет автоматически включена.
  if (!defaults.some((e) => e.name === TURBO_LORA_NAME)) {
    defaults.push({ name: TURBO_LORA_NAME, strength: 1.0, enabled: true, trigger: '' })
  }
  saveLoras(defaults)
  return defaults
}

/** Path to the ComfyUI models/loras/ directory. */
export function lorasDir(): string {
  const cfg = getAppConfig()
  return path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'loras')
}

/** List all .safetensors files in the LoRAs folder.
 *  (правка 95) Турбо-лора теперь в общем списке — управляется как обычная
 *  (вкл/выкл, сила, удаление), отдельная панель в настройках убрана. */
export function listLoraFiles(): string[] {
  const dir = lorasDir()
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.safetensors')) // (правка 82) убран дубль условия
      .sort()
  } catch {
    return []
  }
}