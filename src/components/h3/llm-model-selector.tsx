'use client'

/**
 * LLM Model Selector — dropdown to switch between LLM models/quantizations:
 * Gemma 4 12B (Q3_K_M / Q4_K_M / Q5_K_M) or Qwen3.5 9B (правка 52).
 * Listed with VRAM recommendations. (правка 48)
 */
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { BotIcon, Loader2Icon } from 'lucide-react'

interface LlmModelOption {
  id: string
  label: string
  filename: string
  sizeLabel: string
}

const LLM_OPTIONS: LlmModelOption[] = [
  // (правка 136) Bonsai 2 27B — тернарный квант Qwen-семейства на форке
  // llama.cpp (PrismML). Значение 'bonsai' = спец-маркер в config [llm] model.
  { id: 'llm_assistant_bonsai', label: 'Bonsai 2 27B · тернарная (27B в ~7.8 GB, vision)', filename: 'bonsai', sizeLabel: '~7.8 GB' },
  { id: 'llm_assistant', label: 'Gemma 4 12B · Q4_K_M (баланс, ~7.1 GB)', filename: 'gemma-4-12b-it-Q4_K_M.gguf', sizeLabel: '~7.1 GB' },
  { id: 'llm_assistant_q3', label: 'Gemma 4 12B · Q3_K_M (лёгкая, ~8 GB VRAM)', filename: 'gemma-4-12b-it-Q3_K_M.gguf', sizeLabel: '~5.6 GB' },
  { id: 'llm_assistant_q5', label: 'Gemma 4 12B · Q5_K_M (макс. качество, ~12 GB VRAM)', filename: 'gemma-4-12b-it-Q5_K_M.gguf', sizeLabel: '~8.6 GB' },
  // Qwen3.5 9B (правка 52): альтернатива для слабых машин — 5.7 ГБ весов,
  // мультимодальная (картинки + видео). Нужен свежий llama.cpp (qwen35).
  { id: 'llm_assistant_qwen', label: 'Qwen3.5 9B · Q4_K_M (vision, лёгкая, ~5.7 GB)', filename: 'Qwen3.5-9B-Q4_K_M.gguf', sizeLabel: '~5.7 GB' },
]

export function LlmModelSelector() {
  const [selected, setSelected] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        // (правка 162) пустое llm_model = дефолт Bonsai — показываем Bonsai
        if (d.llm_model) setSelected(d.llm_model)
        // если пусто — selected остаётся '' → в селекте '' = Bonsai
      })
      .catch(() => {})
  }, [])

  const save = useCallback(async (filename: string) => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_model: filename }),
      })
      if (res.ok) {
        const opt = LLM_OPTIONS.find((o) => o.filename === filename)
        // (правка 162) пустое значение = дефолт Bonsai
        toast.success(
          filename ? `LLM: ${opt?.label ?? filename}` : 'LLM: базовая модель (Bonsai 2 27B)',
          { description: 'Применится при следующем обращении к ассистенту.' },
        )
      }
    } catch {
      toast.error('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }, [])

  const handleSelect = (value: string) => {
    setSelected(value)
    void save(value)
  }

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2">
        <BotIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Модель ассистента</span>
        {saving && <Loader2Icon className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>
      <select
        value={selected}
        onChange={(e) => handleSelect(e.target.value)}
        disabled={saving}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
      >
        {/* (правка 162) '' (пусто) = дефолт = Bonsai 2 27B;
            другие модели выбираются явно своим именем файла */}
        {LLM_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id === 'llm_assistant_bonsai' ? '' : opt.filename}>
            {opt.label} — {opt.sizeLabel}
          </option>
        ))}
      </select>
      <p className="text-[10px] text-muted-foreground/50">
        Bonsai 2 — 27B тернарная (дефолт, лучшая на ГБ VRAM, папка в config.ini
        [llm] bonsai_dir) · Gemma Q3 — 8 ГБ VRAM · Q4 — 12 ГБ · Q5 — 16+ ГБ
        · Qwen3.5 9B — лёгкая (8–12 ГБ), требует свежий llama.cpp
      </p>
    </div>
  )
}
