'use client'

/**
 * Generation status card — phase readout, animated progress bar, elapsed
 * timer, live ComfyUI preview and error state. Pinned to the bottom of
 * the parameters panel so it stays visible while adjusting settings.
 * (The CTA button lives next to the prompt — see GenerateView.)
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface GenerationStatusProps {
  phase: string
  isGenerating: boolean
  progressPercent: number
  statusMessage: string | null
  error: string | null
  onInterrupt: () => void
  onReset: () => void
  /** Timestamp (Date.now()) when generation started — drives the elapsed timer. */
  startedAt?: number | null
  /** Current prompt_id for the live preview. */
  promptId?: string | null
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}ч ${m}м ${s}с`
  if (m > 0) return `${m}м ${s}с`
  return `${s}с`
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="text-[10px] font-mono text-muted-foreground tabular-nums">{formatElapsed(Date.now() - startedAt)}</span>
}

/** Live preview of the current denoising step (from ComfyUI WebSocket). */
function GenPreview({ promptId, active }: { promptId: string | null; active: boolean }) {
  const [previewData, setPreviewData] = useState<{
    url: string
    mime: string
    step: number
    total: number
    width: number
    height: number
    stage?: { stage: number; totalStages: number; step: number; total: number } | null
  } | null>(null)

  useEffect(() => {
    if (!active || !promptId) return
    let cancelled = false
    const poll = async () => {
      try {
        // Cache-busting: append timestamp to prevent browser caching
        const res = await fetch(`/api/comfy/preview?prompt_id=${encodeURIComponent(promptId)}&_t=${Date.now()}`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        // Stage must update even WITHOUT a new preview image: during pass 2
        // the KJ preview override (pass 1 only) emits nothing, so the last
        // pass-1 frame stays on screen while the label must move to 2/2.
        if (data.stage) {
          const s = data.stage as { stage: number; totalStages: number; step: number; total: number }
          setPreviewData((prev) =>
            prev ? { ...prev, stage: s } : {
              url: '', mime: 'image/jpeg', step: 0, total: 0, width: 0, height: 0, stage: s,
            },
          )
        }
        if (data.preview?.image) {
          setPreviewData((prev) => {
            const base = prev ?? { url: '', mime: 'image/jpeg', step: 0, total: 0, width: 0, height: 0, stage: null }
            return {
              ...base,
              url: data.preview.image,
              mime: data.preview.mime || 'image/jpeg',
              step: data.preview.step || 0,
              total: data.preview.total || 0,
              width: data.preview.width || 0,
              height: data.preview.height || 0,
            }
          })
        }
      } catch { /* ignore */ }
    }
    poll()
    const timer = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [promptId, active])

  if (!previewData || !previewData.url) {
    // No preview frame yet (or pass 2, where none is emitted) — still show
    // which pass is running so the label is never stale/empty.
    const stageOnly = previewData?.stage
    return (
      <div className="rounded-lg border border-dashed border-border bg-[var(--surface-1)]/50 h-28 flex flex-col items-center justify-center gap-1">
        <span className="text-[10px] text-muted-foreground/50 creative-pulse">Ожидание preview…</span>
        {stageOnly && (
          <span className="text-[10px] text-cyan-300 font-medium">
            Pass {stageOnly.stage}/{stageOnly.totalStages}
            {stageOnly.total > 0 ? ` · шаг ${stageOnly.step}/${stageOnly.total}` : ''}
          </span>
        )}
      </div>
    )
  }

  const isVideo = previewData.mime === 'video/mp4'
  const isAnimatedWebp = previewData.mime === 'image/webp'

  // Stage label across the WHOLE generation (not just the pass the preview
  // image comes from): "Pass 1/2" during low-res, "Pass 2/2" during the
  // high-res refinement. Step/total prefer the stage tracker (works even on
  // pass 2, where no KJ preview image is emitted) and fall back to the
  // preview image's own counters.
  const stage = previewData.stage
  const passLabel = stage ? `Pass ${stage.stage}/${stage.totalStages}` : 'Превью'
  const step = stage && stage.total > 0 ? stage.step : previewData.step
  const total = stage && stage.total > 0 ? stage.total : previewData.total
  const stepLabel = total > 0 ? ` · шаг ${step}/${total}` : ''

  return (
    <div className="relative rounded-lg overflow-hidden border border-cyan-500/20 bg-black/40">
      {isVideo ? (
        <video
          src={previewData.url}
          autoPlay
          loop
          muted
          className="w-full h-auto max-h-48 object-contain"
        />
      ) : (
        <img
          src={previewData.url}
          alt="Preview"
          className="w-full h-auto max-h-48 object-contain"
          draggable={false}
        />
      )}
      {isAnimatedWebp && (
        <span className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/50 rounded text-[8px] text-cyan-300">anim</span>
      )}
      <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-cyan-300 font-medium flex items-center gap-1.5">
        <span>{passLabel}{stepLabel}</span>
        {previewData.width > 0 && previewData.height > 0 && (
          <span className="text-white/40 font-normal">{previewData.width}×{previewData.height}</span>
        )}
      </div>
    </div>
  )
}

export function GenerationStatus({
  phase,
  isGenerating,
  progressPercent,
  statusMessage,
  error,
  onInterrupt,
  onReset,
  startedAt,
  promptId,
}: GenerationStatusProps) {
  return (
    <div className="space-y-2">
      {/* Phase + elapsed */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span
          className={cn(
            'font-medium shrink-0',
            phase === 'running'
              ? 'text-cyan-400'
              : phase === 'queued' || phase === 'submitting'
                ? 'text-yellow-400'
                : phase === 'done'
                  ? 'text-green-400'
                  : phase === 'error'
                    ? 'text-red-400'
                    : 'text-muted-foreground',
          )}
        >
          {phase === 'idle' && 'Готов к генерации'}
          {phase === 'submitting' && 'Отправка…'}
          {phase === 'queued' && 'В очереди…'}
          {phase === 'running' && (progressPercent > 0 ? `Генерация… ${progressPercent}%` : 'Генерация идёт…')}
          {phase === 'done' && 'Готово ✓'}
          {phase === 'error' && 'Ошибка'}
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {startedAt && isGenerating && <ElapsedTimer startedAt={startedAt} />}
          {statusMessage && (
            <span className="text-muted-foreground/60 truncate max-w-[140px]" title={statusMessage}>
              {statusMessage}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
        {isGenerating ? (
          phase === 'queued' || phase === 'submitting' || (phase === 'running' && progressPercent === 0) ? (
            <div
              className={cn(
                'h-full w-1/3 rounded-full animate-pulse',
                phase === 'running'
                  ? 'bg-gradient-to-r from-cyan-500/80 to-blue-500/80'
                  : 'bg-gradient-to-r from-yellow-500/80 to-amber-500/80',
              )}
            />
          ) : (
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full"
            />
          )
        ) : phase === 'done' ? (
          <div className="h-full w-full bg-gradient-to-r from-green-500/60 to-emerald-500/60 rounded-full" />
        ) : null}
      </div>

      {/* Live preview — only while a job is active */}
      {isGenerating && <GenPreview promptId={promptId ?? null} active={phase === 'running' || phase === 'queued'} />}

      {/* Stop */}
      {isGenerating && (
        <button
          onClick={onInterrupt}
          className="w-full text-xs text-red-400/70 hover:text-red-400 py-1 transition-colors"
        >
          Остановить
        </button>
      )}

      {/* Error */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg"
        >
          <span className="text-sm text-red-400 font-medium shrink-0">Ошибка</span>
          <div className="space-y-1 min-w-0">
            <p className="text-xs text-red-300/70 break-words">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="h-auto p-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/20"
            >
              Попробовать снова
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  )
}
