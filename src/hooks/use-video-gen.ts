'use client'

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import type { VideoGenerateParams, VideoReferenceParam } from '@/lib/comfy/video-config'
import { useGenProgress, type GenPhase } from '@/lib/gen-progress-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { useGenDurations } from '@/lib/gen-duration-store'
import { useGenStore } from '@/lib/gen-store'
import { playNotificationSound } from '@/lib/sound'
import { computeFinalDimensions, finalDimsFromMegapixels, framesForDuration, selectResolution, flfNominalDimensions } from '@/lib/comfy/minimax-h3-template'

/** (правка 158) flf: вычисляем номинал из пресета + размеров кадра —
 *  ТОЖЕ формула, что и на сервере (body.targetDimensions в route.ts).
 *  Без этого «Повторить» (restore-from-meta) восстанавливает resolution
 *  из метаданных, но UI-бейдж/разрешение в форме не совпадает с реальным
 *  размером генерации (мета хранит итоговый outW×outH из computeOutputDimensions).
 */
function flfFinalResolution(p: {
  mode?: 'ref' | 't2v' | 'flf'
  firstFrameWidth?: number
  firstFrameHeight?: number
  resolution?: string
  finalResolution?: number
  freeResolution?: boolean
}): string | undefined {
  if (p.mode !== 'flf') return undefined
  if (!p.firstFrameWidth || !p.firstFrameHeight) return undefined
  if (!p.resolution) return undefined
  const match = p.resolution.match(/(\d+)\s*x\s*(\d+)/i)
  if (!match) return undefined
  const shortSide = Math.min(parseInt(match[1], 10), parseInt(match[2], 10))
  if (!shortSide) return undefined
  const dims = flfNominalDimensions(shortSide, p.firstFrameWidth, p.firstFrameHeight)
  return `${dims.w}x${dims.h}`
}

export type { GenPhase }

const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 60 * 60 * 1000

/** Store of generation params for metadata (keyed by promptId). */
const genParamsMap = new Map<string, Record<string, unknown>>()

/* (fix H2) Эпоха прерываний: interrupt() во время 'submitting' (POST ещё в
 * полёте) раньше оставлял задачу-сироту в ComfyUI — cancel для неё послать
 * было нечем (prompt_id ещё нет), и после разрешения POST она тихо просилась
 * в GPU без UI-отслеживания. Теперь generate() замечает смену эпохи после
 * POST и сам отменяет вернувшийся prompt_id. */
let interruptEpoch = 0

/* ── genParamsMap persistence (survives page reload) ──
 * Without this, a reload before the job finishes loses the params and the
 * finished video never gets its .meta.json sidecar. */
const GEN_PARAMS_STORAGE_KEY = 'h3_gen_params_v1'
const GEN_PARAMS_MAX_AGE_MS = 24 * 60 * 60 * 1000

function persistGenParams() {
  if (typeof window === 'undefined') return
  try {
    const now = Date.now()
    const fresh: Record<string, unknown> = {}
    for (const [pid, p] of genParamsMap) {
      if (typeof p.started_at === 'number' && now - p.started_at > GEN_PARAMS_MAX_AGE_MS) {
        genParamsMap.delete(pid)
        continue
      }
      fresh[pid] = p
    }
    window.localStorage.setItem(GEN_PARAMS_STORAGE_KEY, JSON.stringify(fresh))
  } catch { /* storage unavailable — keep in-memory only */ }
}

if (typeof window !== 'undefined') {
  try {
    const raw = window.localStorage.getItem(GEN_PARAMS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
      const now = Date.now()
      for (const [pid, p] of Object.entries(parsed)) {
        if (p && typeof p.started_at === 'number' && now - p.started_at <= GEN_PARAMS_MAX_AGE_MS) {
          genParamsMap.set(pid, p)
        }
      }
    }
  } catch { /* corrupted storage — start fresh */ }
}

/**
 * (правка 124) Известные пресеты → строка соотношения сторон.
 * Ключи = ТОЧНЫЕ номиналы (финальные размеры): короткая сторона = «p»,
 * длинная = короткая × (A:B), чётные (yuv420p). Неизвестные значения
 * проходят эвристику соотношения ниже.
 */
const RES_TO_ASPECT: Record<string, string> = {
  '854x480': '16:9 (Widescreen)',
  '480x854': '9:16 (Portrait Widescreen)',
  '480x480': '1:1 (Square)',
  '640x480': '4:3 (Standard)',
  '480x640': '3:4 (Portrait Standard)',
  '1120x480': '21:9 (Ultrawide)',
  '1280x720': '16:9 (Widescreen)',
  '720x1280': '9:16 (Portrait Widescreen)',
  '720x720': '1:1 (Square)',
  '960x720': '4:3 (Standard)',
  '720x960': '3:4 (Portrait Standard)',
  '1680x720': '21:9 (Ultrawide)',
  '1920x1080': '16:9 (Widescreen)',
  '1080x1920': '9:16 (Portrait Widescreen)',
  '1080x1080': '1:1 (Square)',
  '2520x1080': '21:9 (Ultrawide)',
}

/**
 * (правки 121, 124) Итоговые размеры видео в режиме свободного разрешения
 * (MP) — ТО же формула, что в шаблоне (finalDimsFromMegapixels): генерация
 * кратная 32 (бинарные MP узла), итог — максимальный вписанный
 * прямоугольник с точным соотношением. lowResMP больше не влияет на итог:
 * апскейлер работает в режиме «target dimensions».
 */
export function computeOutputDimensions(aspectRatio: string, megapixels: number): { w: number; h: number } {
  const d = finalDimsFromMegapixels(aspectRatio, megapixels)
  return { w: d.outW, h: d.outH }
}

/**
 * Drives the ComfyUI video generation lifecycle for MiniMax H3.
 *
 * Flow:
 *   1. Upload ref images to ComfyUI input/
 *   2. Submit workflow via /api/comfy/generate
 *   3. Poll /api/comfy/status?prompt_id=X until done
 *   4. Save metadata on completion
 */
export function useVideoGen() {
  const progressStore = useGenProgress()
  const queue = useGenQueue()

  const timersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const abortFlagsRef = useRef<Map<string, boolean>>(new Map())

  const clearTimer = useCallback((pid: string) => {
    const timer = timersRef.current.get(pid)
    if (timer) {
      clearInterval(timer)
      timersRef.current.delete(pid)
    }
    abortFlagsRef.current.delete(pid)
  }, [])

  const clearAllTimers = useCallback(() => {
    for (const pid of timersRef.current.keys()) {
      const timer = timersRef.current.get(pid)!
      clearInterval(timer)
    }
    timersRef.current.clear()
    abortFlagsRef.current.clear()
  }, [])

  useEffect(() => clearAllTimers, [clearAllTimers])

  /** Save metadata file when generation completes. */
  const saveMetadata = useCallback(async (
    promptId: string,
    outputs: Array<{ filename: string; subfolder: string }>,
    durationMs?: number | null,
  ) => {
    const params = genParamsMap.get(promptId)
    if (!params || !outputs.length) return
    try {
      const primary = outputs.find((o) => o.filename?.match(/\.(mp4|webm|mov)$/i)) || outputs[0]
      await fetch('/api/comfy/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: primary.filename,
          subfolder: primary.subfolder || '',
          params: {
            ...params,
            // Real generation time (execution time) — the same value the
            // gallery badge shows. Only recorded when server-measured
            // (execution_ms from WS events). No fallback — better nothing
            // than a wrong number.
            ...(durationMs != null && { generation_time: Math.round(durationMs / 1000) }),
            job_id: promptId,
          },
        }),
      }).catch(() => {})
    } catch { /* non-critical */ }
    // Clean up
    genParamsMap.delete(promptId)
    persistGenParams()
  }, [])

  // (фикс M4) pollUntilDone ОБЯЗАН быть стабильным (стабильные deps): его
  // идентичность стоит в deps эффекта реанимации ниже. Раньше в deps был
  // `queue` — объект состояния из useGenQueue(), который меняется при КАЖДОМ
  // обновлении стора (progress-тики раз в секунду и т.д.) → pollUntilDone
  // пересоздавался → эффект реанимации перезапускался на каждом тике и
  // (фикс M3) убивал свежие 'submitting'-задачи, чей POST ещё был в полёте:
  // «Отправка прервана перезагрузкой страницы» без всякой перезагрузки,
  // видео генерировалось, а очередь показывала «Ошибка». Теперь все вызовы
  // идут через useGenQueue.getState() — замыкание на живой стор, deps пустые.
  const pollUntilDone = useCallback(
    (promptId: string, queueId: string, startedAt: number) => {
      if (timersRef.current.has(promptId)) return

      // When this prompt actually started EXECUTING (first 'running' poll).
      let runningSince: number | null = null
      // True once a poll saw this prompt 'queued' behind other jobs — such a
      // video counts from its actual execution start; a job that went
      // straight to execution counts from the button press (startedAt).
      let sawQueued = false
      // Счётчик подряд идущих ответов 'unknown' (ComfyUI недоступен)
      let unknownCount = 0
      // Guard от наложения тиков: если fetch статуса/прогресса длится дольше
      // интервала, два тика concurrently увидят 'done' и ветка завершения
      // сработает дважды (двойные метаданные, звук, запись длительности).
      let tickInFlight = false

      const timer = setInterval(async () => {
        if (tickInFlight) return
        tickInFlight = true
        try {
          await tick()
        } finally {
          tickInFlight = false
        }
      }, POLL_INTERVAL_MS)

      async function tick() {
        const aborted = abortFlagsRef.current.get(promptId)
        if (aborted) {
          clearTimer(promptId)
          return
        }

        // The queue item was cancelled (or removed) elsewhere — stop tracking.
        // Without this, a cancelled prompt keeps polling forever: ComfyUI no
        // longer knows it, so getStatus falls back to 'queued' forever.
        // (фикс) Также останавливаем если элемент в terminal-статусе (error/done):
        // rehydration effect мог пометить его ошибкой, но поллинг всё ещё активен
        // и без этого guard вызовал setStatus('running') — resurrection error → running.
        const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (!qItem || qItem.status === 'cancelled' || qItem.status === 'error' || qItem.status === 'done') {
          clearTimer(promptId)
          return
        }

        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          clearTimer(promptId)
          useGenQueue.getState().setStatus(queueId, 'error', 'Превышено время ожидания')
          useGenProgress.getState().setVideoError('Превышено время ожидания генерации (60 мин).')
          useGenProgress.getState().setVideoPhase('error')
          return
        }

        try {
          const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
          if (!res.ok) return // transient network blip
          const s = await res.json()

          // Re-check after await: user may have cancelled while request was in-flight.
          // Without this, a 'error' status from ComfyUI (which reports cancelled
          // prompts as errors) would overwrite the clean post-cancel state.
          if (abortFlagsRef.current.get(promptId)) {
            clearTimer(promptId)
            return
          }
          const qItem2 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (!qItem2 || qItem2.status === 'cancelled') {
            clearTimer(promptId)
            return
          }

          // ComfyUI недоступен (перезапуск/крах): не считаем это «queued» —
          // после N подряд неответов честно падаем в ошибку, иначе карточка
          // крутилась бы «В очереди…» весь часовой таймаут.
          if (s.status === 'unknown') {
            unknownCount++
            // (фикс) Порог 20 вместо 10: во время активной генерации
            // ComfyUI event-loop заблокирован GPU-операциями, и отдельные
            // /history запросы могут не уложиться в 30с → ложный 'unknown'.
            // 20 × 1с = 20с непрерывного недоступа — это уже реальный сбой.
            if (unknownCount >= 20) {
              clearTimer(promptId)
              // Честная диагностика: 'unknown' бывает в двух случаях:
              //  1) ComfyUI не отвечает (сервер выключен/перезапускается)
              //  2) ComfyUI отвечает, но prompt_id отсутствует в history
              //     и queue — задача отклонена или потеряна
              const isNotFound = s.detail?.includes('не найдена') || s.detail?.includes('отклонена')
              const errMsg = isNotFound
                ? 'Задача не найдена в ComfyUI — возможно, была отклонена при отправке или ComfyUI был перезапущен'
                : 'ComfyUI не отвечает (сервер выключен или перезапускается)'
              useGenQueue.getState().setStatus(queueId, 'error', errMsg)
              useGenProgress.getState().setVideoError(errMsg)
              useGenProgress.getState().setVideoPhase('error')
              return
            }
            return
          }
          unknownCount = 0

          // ── Progress from WebSocket tracker ──
          if (s.status === 'running' || s.status === 'queued') {
            // Fetch progress percentage from WebSocket tracker
            try {
              const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
              if (progRes.ok) {
                const progData = await progRes.json()
                if (progData.progress) {
                  const pct = progData.progress.percent
                  useGenQueue.getState().setProgress(queueId, pct, 100)
                  // Only update shared progress store for the RUNNING prompt
                  if (s.status === 'running') {
                    useGenProgress.getState().setVideoProgress(pct, 100)
                  }
                }
              }
            } catch { /* non-critical */ }

            // Update phase and queue status
            if (s.status === 'running') {
              if (runningSince === null) runningSince = Date.now()
              // (фикс) Terminal-status guard: элемент мог стать error/done/cancelled
              // между guard в начале tick() и этим вызовом (race с rehydration).
              const guardItem = useGenQueue.getState().items.find((i) => i.id === queueId)
              if (guardItem && ['done', 'error', 'cancelled'].includes(guardItem.status)) {
                clearTimer(promptId)
                return
              }
              const cur = useGenProgress.getState().video
              if (cur.promptId !== promptId) {
                // The card must follow the job that is actually EXECUTING —
                // previews/progress are keyed to the executing prompt. Take
                // the card over (forced) from a merely-queued or dead prompt.
                const tracked = useGenQueue.getState().items.find((i) => i.promptId === cur.promptId)
                const trackedRunning = tracked
                  ? tracked.status === 'running'
                  : cur.phase === 'running'
                if (!trackedRunning) {
                  useGenProgress.getState().startVideoGen(promptId, true)
                }
              }
              if (useGenProgress.getState().video.phase !== 'running') {
                useGenProgress.getState().setVideoPhase('running')
              }
              useGenQueue.getState().setStatus(queueId, 'running')
            } else {
              // This prompt is waiting behind other jobs — its duration
              // timer must start only when its turn comes.
              sawQueued = true
              // (фикс) Terminal-status guard для queued-ветки
              const guardItem = useGenQueue.getState().items.find((i) => i.id === queueId)
              if (guardItem && ['done', 'error', 'cancelled'].includes(guardItem.status)) {
                clearTimer(promptId)
                return
              }
              // Only set 'queued' in shared store if no other item is running
              const anyRunning = useGenQueue.getState().items.some(
                (i) => i.status === 'running' && i.id !== queueId
              )
              useGenQueue.getState().setStatus(queueId, 'queued')
              const cur = useGenProgress.getState().video
              if (!anyRunning && cur.phase !== 'running') {
                // Карточка может следить за ЗАВЕРШЁННОЙ/отменённой задачей
                // (напр., прошлой генерацией) — забираем её на эту queued,
                // иначе карточка опрашивает мёртвый prompt и осциллирует
                // «Готово»/«В очереди».
                const tracked = cur.promptId
                  ? useGenQueue.getState().items.find((i) => i.promptId === cur.promptId)
                  : null
                const trackedActive = tracked
                  ? ['submitting', 'queued', 'running'].includes(tracked.status)
                  : false
                if (!trackedActive) {
                  useGenProgress.getState().startVideoGen(promptId, true)
                } else {
                  useGenProgress.getState().setVideoPhase('queued')
                }
              }
            }
          } else if (s.status === 'error') {
            clearTimer(promptId)
            const label = s.detail || 'Ошибка генерации'
            useGenQueue.getState().setStatus(queueId, 'error', label)
            useGenProgress.getState().setVideoError(label)
            useGenProgress.getState().setVideoPhase('error')
          } else if (s.status === 'done') {
            clearTimer(promptId)
            console.log(`[pollUntilDone] ${promptId}: DONE detected, queueId=${queueId}`)
            // REAL generation time from ComfyUI WS execution events
            // (server-measured). Single source of truth for BOTH the gallery
            // Single source of truth: server-measured execution time from
            // ComfyUI WebSocket events. Poll-based estimates are unreliable
            // (startedAt = button press, not execution start) and cause the
            // gallery badge to show less time than the .meta.json sidecar.
            // If the tracker missed the events, durationMs stays null and we
            // simply don't record a duration (better nothing than wrong).
            const execMs = typeof s.execution_ms === 'number' && s.execution_ms > 0
              ? s.execution_ms
              : null
            // Fallback-цепочка (серверные WS-события потеряны):
            //  1) runningSince — момент, когда тик впервые увидел 'running'
            //     (чистое время исполнения, без ожидания в очереди);
            //  2) Date.now() - startedAt — только если задача НИ РАЗУ не была
            //     в очереди за чужими работами (иначе в бейдж уезжали бы
            //     минуты ожидания — противоречило «better nothing than wrong»).
            let durationMs: number | null = execMs
            if (durationMs === null) {
              if (runningSince !== null) durationMs = Date.now() - runningSince
              else if (!sawQueued) durationMs = Date.now() - startedAt
            }
            useGenQueue.getState().setStatus(queueId, 'done')
            useGenProgress.getState().setVideoPhase('done')
            useGenProgress.getState().setVideoProgress(100, 100)
            // Notification sound (if enabled)
            if (typeof window !== 'undefined') {
              fetch('/api/config').then((r) => r.json()).then((d) => {
                if (d.sound_on !== false) playNotificationSound()
              }).catch(() => {})
            }
            // Save metadata with output filename
            // Fallback: if outputs is empty, find the newest video file from the output dir
            const doSave = async () => {
              let outputs = s.outputs
              if (!outputs || outputs.length === 0) {
                // Fallback: history gave no outputs. Pick the newest video
                // written AFTER this job started that has no sidecar yet —
                // avoids stealing a parallel generation's file.
                try {
                  const filesRes = await fetch('/api/comfy/files?type=video')
                  if (filesRes.ok) {
                    const filesData = await filesRes.json()
                    // Files are sorted mtime desc (newest first)
                    const startedAtSec = startedAt / 1000 - 5 // mtime skew allowance
                    // Только папка этой задачи: листинг включает ВСЕ подпапки
                    // галереи — без фильтра сайдкар мог прилипнуть к чужому
                    // файлу из другого проекта, завершившемуся чуть раньше.
                    const ownSub = genParamsMap.get(promptId)?.output_subfolder || ''
                    const candidate = (filesData.files ?? []).find(
                      (f: { hasMeta?: boolean; mtime?: number; subfolder?: string }) =>
                        (f.subfolder || '') === ownSub &&
                        !f.hasMeta && typeof f.mtime === 'number' && f.mtime >= startedAtSec,
                    )
                    if (candidate) {
                      outputs = [{ filename: candidate.filename, subfolder: candidate.subfolder || '' }]
                    }
                  }
                } catch { /* ignore */ }
              }
              // Record the duration against the actual VIDEO output — using
              // the same fallback filename the metadata save uses, so the
              // gallery badge appears even when history returned no outputs.
              const badgeFilename =
                outputs?.find((o) => o.filename?.match(/\.(mp4|webm|mov|m4v)$/i))?.filename ||
                outputs?.[0]?.filename ||
                undefined
              if (durationMs !== null) {
                useGenDurations.getState().record(durationMs, 'video', badgeFilename)
              }
              if (outputs?.length) {
                await saveMetadata(promptId, outputs, durationMs)
              } else {
                genParamsMap.delete(promptId)
                persistGenParams()
              }
            }
            void doSave()
          }
        } catch {
          /* transient network blip — keep polling */
        }
      }

      timersRef.current.set(promptId, timer)
    },
    [clearTimer, saveMetadata]
  )

  // Re-hydrate on mount: re-attach polling for every ACTIVE queue item that
  // survived a page reload (the queue store is persisted). Also point the
  // shared progress card at an active item when it came back idle.
  // (фикс M4) Эффект выполняется ТОЛЬКО на монтировании: pollUntilDone теперь
  // стабилен (см. комментарий выше). Раньше из-за нестабильного pollUntilDone
  // эффект перезапускался на каждом обновлении стора.
  // (fix M3, M4) 'submitting' без prompt_id ≠ сразу «ошибка»: POST /generate
  // летит до 120 с (AbortSignal.timeout(120_000)). Мгновенная пометка ошибки
  // убивала свежие задачи (POST завершался, видео генерировалось, а очередь
  // показывала «Ошибка» и бросала отслеживание). Даём отправке полный таймаут
  // POST + запас; если prompt_id так и не пришёл — только тогда ошибка.
  useEffect(() => {
    const items = useGenQueue.getState().items
    const SUBMIT_GRACE_MS = 150_000 // POST timeout (120 с) + запас
    const graceTimers: ReturnType<typeof setTimeout>[] = []
    for (const it of items) {
      if (it.status !== 'submitting' || it.promptId) continue
      const giveUp = () => {
        const cur = useGenQueue.getState().items.find((x) => x.id === it.id)
        if (cur && cur.status === 'submitting' && !cur.promptId) {
          useGenQueue.getState().setStatus(it.id, 'error', 'Отправка прервана перезагрузкой страницы')
        }
      }
      const left = SUBMIT_GRACE_MS - (Date.now() - it.createdAt)
      if (left <= 0) {
        giveUp()
      } else {
        graceTimers.push(setTimeout(giveUp, left))
      }
    }
    for (const it of items) {
      if (!it.promptId) continue
      if (!['submitting', 'queued', 'running'].includes(it.status)) continue
      if (timersRef.current.has(it.promptId)) continue
      abortFlagsRef.current.set(it.promptId, false)
      pollUntilDone(it.promptId, it.id, it.createdAt)
    }
    const cur = useGenProgress.getState().video
    if (cur.phase === 'idle' || !cur.promptId) {
      const next =
        items.find((i) => i.status === 'running' && i.promptId) ??
        items.find((i) => ['submitting', 'queued'].includes(i.status) && i.promptId)
      if (next?.promptId) {
        useGenProgress.getState().startVideoGen(next.promptId)
      }
    }
    return () => {
      for (const t of graceTimers) clearTimeout(t)
    }
  }, [pollUntilDone])

  /**
   * Submit a video generation job via ComfyUI.
   * Reference images must already be uploaded to ComfyUI input/
   * (their filenames are in params.references[].path).
   */
  const generate = useCallback(
    async (params: VideoGenerateParams) => {
      const queueId = queue.enqueue('video', params.prompt?.slice(0, 50) || 'Видео')

      // Немедленно показываем «Отправка…» на чистой карточке — БЕЗ данных
      // прошлой задачи. НО: если уже есть активная генерация (running/queued)
      // в очереди — НЕ сбрасываем: таймер текущей генерации должен продолжить.
      const hasActiveInQueue = useGenQueue.getState().items.some(
        (i) => i.type === 'video' && ['submitting', 'queued', 'running'].includes(i.status) && i.id !== queueId
      )
      if (!hasActiveInQueue) {
        useGenProgress.getState().beginVideoSubmit()
      }

      try {
        // Build MiniMaxH3Params from VideoGenerateParams
        // Extract ref image filenames (ComfyUI input/ filenames)
        // (правка 146) режим генерации: в t2v/flf картинки/видео-рефы не идут
        // (кадры — отдельными полями firstFrame/lastFrame)
        const genMode = params.mode ?? 'ref'
        const refImages: string[] = []
        const refVideos: Array<{ path: string; includeAudio: boolean }> = []
        const refAudios: string[] = []
        if (params.references?.length) {
          for (const ref of params.references) {
            if (!ref.path) continue
            if (/^[A-Za-z]:[\\/]/.test(ref.path) || ref.path.startsWith('/')) {
              throw new Error(
                `Файл «${ref.path}» загружен в старую систему. Удалите его и загрузите заново.`,
              )
            }
            if (ref.kind === 'image') {
              if (genMode === 'ref') refImages.push(ref.path)
            } else if (ref.kind === 'video') {
              if (genMode === 'ref') refVideos.push({ path: ref.path, includeAudio: ref.includeAudio !== false })
            } else if (ref.kind === 'audio') {
              refAudios.push(ref.path)
            }
          }
        }
        // No references required — the hybrid model supports prompt-only generation

        // (правка 124) Два режима:
        //  • пресет (известные WxH) — это ТОЧНЫЙ номинал: сервер делает
        //    gen = ceil32(nominal), апскейлер «target dimensions», кроп →
        //    ровно номинал (16:9 1080p: 1920×1088 → 1920×1080);
        //  • свободное разрешение (finalResolution > 0) / неизвестные WxH —
        //    MP-путь (finalDimsFromMegapixels: бинарные MP узла + вписанный кроп).
        let aspectRatio = '16:9 (Widescreen)'
        let qualityFinalRes: number | null = null
        let presetDims: { w: number; h: number } | null = null

        // (правка 152) В режиме flf соотношение сторон берётся из первого кадра
        if (genMode === 'flf' && params.firstFrameWidth && params.firstFrameHeight) {
          const ratio = params.firstFrameWidth / params.firstFrameHeight
          if (Math.abs(ratio - 21/9) < 0.2) aspectRatio = '21:9 (Ultrawide)'
          else if (Math.abs(ratio - 16/9) < 0.15) aspectRatio = '16:9 (Widescreen)'
          else if (Math.abs(ratio - 9/16) < 0.15) aspectRatio = '9:16 (Portrait Widescreen)'
          else if (Math.abs(ratio - 1) < 0.1) aspectRatio = '1:1 (Square)'
          else if (Math.abs(ratio - 4/3) < 0.15) aspectRatio = '4:3 (Standard)'
          else if (Math.abs(ratio - 3/4) < 0.15) aspectRatio = '3:4 (Portrait Standard)'
          else if (Math.abs(ratio - 3/2) < 0.15) aspectRatio = '3:2 (Photo)'
          else if (Math.abs(ratio - 2/3) < 0.15) aspectRatio = '2:3 (Portrait Photo)'
          else aspectRatio = '16:9 (Widescreen)'
          // (правка 155) В flf используем номинальные размеры из пресета (480p/720p/1080p),
          // а не фиксированные 0.7 MP. Это позволяет выбрать 480p или 720p и получать
          // соответствующее разрешение (480×854 vs 720×1280 для 9:16), а не одинаковое.
          // (правка 157) Ориентация берётся из КАДРА, не из пресета UI: короткая
          // сторона = заданное качество (min(w,h)), длинная = короткая × (fw/fh) —
          // точная пропорция первого кадра. Горизонтальный кадр + любой пресет
          // (480p/720p/1080p) → всегда горизонтальное видео.
          if (params.resolution) {
            const match = params.resolution.match(/(\d+)\s*x\s*(\d+)/i)
            if (match) {
              const pw = parseInt(match[1], 10)
              const ph = parseInt(match[2], 10)
              const shortSide = Math.min(pw, ph)
              const dims = flfNominalDimensions(shortSide, params.firstFrameWidth, params.firstFrameHeight)
              presetDims = { w: dims.w, h: dims.h }
              // MP для метаданных (не используется в расчёте, только для информации)
              qualityFinalRes = Math.round((dims.w * dims.h / 1_000_000) * 100) / 100
            } else {
              qualityFinalRes = 0.7
            }
          } else {
            qualityFinalRes = 0.7
          }
        } else if (params.resolution) {
          // Exact preset match first; unknown resolutions use ratio heuristic.
          aspectRatio = RES_TO_ASPECT[params.resolution] ?? aspectRatio
          const match = params.resolution.match(/(\d+)\s*x\s*(\d+)/i)
          if (match) {
            const w = parseInt(match[1], 10)
            const h = parseInt(match[2], 10)
            if (RES_TO_ASPECT[params.resolution]) {
              // (правка 124) Известный пресет: WxH — и есть точный номинал
              presetDims = { w, h }
            } else {
              const ratio = w / h
              if (Math.abs(ratio - 21/9) < 0.2) aspectRatio = '21:9 (Ultrawide)'
              else if (Math.abs(ratio - 16/9) < 0.15) aspectRatio = '16:9 (Widescreen)'
              else if (Math.abs(ratio - 9/16) < 0.15) aspectRatio = '9:16 (Portrait Widescreen)'
              else if (Math.abs(ratio - 1) < 0.1) aspectRatio = '1:1 (Square)'
              else if (Math.abs(ratio - 4/3) < 0.15) aspectRatio = '4:3 (Standard)'
              else if (Math.abs(ratio - 3/4) < 0.15) aspectRatio = '3:4 (Portrait Standard)'
              else if (Math.abs(ratio - 3/2) < 0.15) aspectRatio = '3:2 (Photo)'
              else if (Math.abs(ratio - 2/3) < 0.15) aspectRatio = '2:3 (Portrait Photo)'
              else aspectRatio = '16:9 (Widescreen)'
            }
            // Derive final resolution (MP) directly from pixel count
            // (метаданные + MP-путь для неизвестных WxH)
            const totalPx = w * h
            qualityFinalRes = Math.round((totalPx / 1_000_000) * 100) / 100
          }
        }

        // Duration: videoLength is frame count, convert to seconds at 24fps.
        // Keep duration as an exact float (NO integer rounding) so the server's
        // frames formula round-trips on the 17n+5 grid (правка 55).
        const fps = 24
        // (правка 138) дефолт 48 → 60: минимум 2.5 с (60 кадров при 24 fps)
        const duration = Math.max(2.5, (params.videoLength ?? 60) / fps)
        // Actual frame count the server will produce (node 46:19) — for metadata.
        const videoLengthFrames = framesForDuration(duration, fps)

        // Final resolution: explicit override (>0) > quality-derived > default
        const finalResolution = (params.finalResolution && params.finalResolution > 0)
          ? params.finalResolution
          : qualityFinalRes ?? 0.7
        // (правка 124) Точные размеры — только для известного пресета и без
        // свободного режима. Шаблон (сервер) из них делает gen = ceil32 и
        // финальный кроп; метаданные — тот же расчёт ниже.
        // (правка 153) В режиме flf single-pass: если есть presetDims — используем их,
        // иначе шаблон рассчитывает из lowRes (finalRes MP).
        // (правка 155) В flf с пресетом (480p/720p/1080p) targetDimensions = номинал,
        // чтобы 480p и 720p давали разные разрешения (480×854 vs 720×1280 для 9:16).
        const freeMode = (params.finalResolution ?? 0) > 0
        const targetDimensions = presetDims && !freeMode
          ? { width: presetDims.w, height: presetDims.h }
          : undefined

        // Actual seed: resolve random (-1) to a concrete value so metadata stores it
        const actualSeed = (params.seed ?? -1) < 0 ? Math.floor(Math.random() * 2 ** 31) : (params.seed ?? -1)

        const body = {
          prompt: params.prompt,
          mode: genMode, // (правка 146) ref | t2v | flf
          firstFrame: genMode === 'flf' ? params.firstFrame : undefined,
          lastFrame: genMode === 'flf' ? params.lastFrame : undefined,
          firstFrameWidth: genMode === 'flf' ? params.firstFrameWidth : undefined,
          firstFrameHeight: genMode === 'flf' ? params.firstFrameHeight : undefined,
          refImages,
          refVideos: refVideos.length > 0 ? refVideos : undefined,
          refAudios: refAudios.length > 0 ? refAudios : undefined,
          aspectRatio,
          duration,
          seed: actualSeed,
          targetDimensions, // (правка 124) точный номинал — приоритет над MP
          finalResolution,
          lowResMP: params.lowResMP ?? 0.2,
          firstSamplerSteps: params.firstSamplerSteps ?? 4,
          sigmaVariant: params.sigmaVariant || '3step',
          pass2Sampler: params.pass2Sampler || 'euler', // (правка 69)
          pass1Sampler: params.pass1Sampler || 'euler', // (правка 70)
          pass1Scheduler: params.pass1Scheduler || 'simple', // (правка 70)
          refImageSize: params.referenceDetail || 'match', // (правка 58)
          lowVramAttention: params.lowVramAttention !== false,
          chunkFeedForward: params.chunkFeedForward !== false,
          chunkFFChunks: params.chunkFFChunks ?? 2,
          chunkFFThreshold: params.chunkFFThreshold ?? 4096,
          outputSubfolder: params.outputSubfolder || '', // (правка 91)
        }

        const myEpoch = interruptEpoch
        // (правка 141, фикс Phase 4) Таймаут 120 с: сервер может ждать
        // освобождения mutex (фоновая выгрузка, выгрузка LLM) + upload
        // референсов + submit. 60 с было мало: AbortSignal убивал запрос,
        // а сервер продолжал работу → «двойная» задача в ComfyUI.
        // 120 с достаточно для всех нормальных сценариев.
        const res = await fetch('/api/comfy/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        })

        const data = await res.json()
        if (!res.ok || !data.prompt_id) {
          // (правка 141) Логируем статус и тело ответа — для диагностики
          // «третье видео не добавляется».
          console.error(`[gen] generate() failed: HTTP ${res.status}`, data)
          throw new Error(data.error || `Не удалось отправить задачу в ComfyUI (HTTP ${res.status}).`)
        }

        const promptId = data.prompt_id as string

        // (fix H2) Пользователь нажал «Отмена», пока POST был в полёте:
        // задача уже в ComfyUI, но UI её не отслеживает. Отменяем её на
        // сервере сразу и НЕ запускаем поллинг/карточку.
        if (interruptEpoch !== myEpoch) {
          void fetch('/api/comfy/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt_id: promptId }),
          }).catch(() => {})
          genParamsMap.delete(promptId)
          persistGenParams()
          queue.remove(queueId)
          return
        }

        queue.setPromptId(queueId, promptId)
        abortFlagsRef.current.set(promptId, false)

        // Staged references (uploaded while ComfyUI was down) have been
        // transferred server-side — update the stored paths so previews
        // and future generations use the real ComfyUI input/ names.
        const transfers = (data.staged_transfers ?? {}) as Record<string, string>
        if (Object.keys(transfers).length > 0) {
          const store = useGenStore.getState()
          for (const ref of store.video.refs) {
            const mapped = transfers[ref.path]
            if (mapped && mapped !== ref.path) {
              store.updateVideoRef(ref.id, { path: mapped })
            }
          }
        }

        // (правки 121, 124) ACTUAL финальные размеры — ТО же, что шаблон:
        // пресет → номинал (computeFinalDimensions), свободное → finalDimsFromMegapixels
        // (правка 153) В режиме flf — single-pass: lowRes = targetDimensions (ceil32)
        // или selectResolution(aspect, finalRes).
        // (правка 155) В flf с пресетом targetDimensions = номинал (480p/720p/1080p).
        // (правка 156) В flf final = lowRes (ceil32) — апскейлер early-return.
        const finalDims = genMode === 'flf'
          ? (() => {
              const lowRes = targetDimensions
                ? {
                    w: Math.max(32, Math.ceil(targetDimensions.width / 32) * 32),
                    h: Math.max(32, Math.ceil(targetDimensions.height / 32) * 32),
                  }
                : selectResolution(aspectRatio, finalResolution)
              return computeFinalDimensions(lowRes.w, lowRes.h)
            })()
          : targetDimensions
            ? computeFinalDimensions(targetDimensions.width, targetDimensions.height)
            : finalDimsFromMegapixels(aspectRatio, finalResolution)
        const { outW, outH } = finalDims

        // Store params for metadata saving.
        // Reference paths go through staged_transfers so the sidecar records
        // the real ComfyUI input/ names, not the local staged ones.
        const metaReferences = (params.references ?? []).map((r) => ({
          type: r.kind,
          path: transfers[r.path] ?? r.path,
          role: r.imageIntent || '',
        }))
        genParamsMap.set(promptId, {
          prompt: params.prompt,
          generation_mode: genMode, // (правка 146) ref | t2v | flf
          ...(genMode === 'flf' && {
            first_frame: transfers[params.firstFrame ?? ''] ?? params.firstFrame ?? null,
            last_frame: transfers[params.lastFrame ?? ''] ?? params.lastFrame ?? null,
            // (правка 157) Размеры первого кадра — для «Повторить»: без них
            // ориентация из кадра не восстановится и flf снова сломается.
            first_frame_width: params.firstFrameWidth ?? null,
            first_frame_height: params.firstFrameHeight ?? null,
            // (правка 158) Итоговый номинал flf (WxH из flfNominalDimensions) —
            // «Повторить» восстанавливает ТОЧНО эти размеры, а не UI-пресет.
            flf_resolution: flfFinalResolution(params) ?? null,
          }),
          // Папка вывода этой задачи — для fallback-поиска выходного файла
          // (фильтр по своей подпапке, чтобы не украсть чужой файл)
          output_subfolder: params.outputSubfolder || '',
          model_type: 'minimax_h3_ref2va',
          workflow: 'two-pass-latent-upscaler',
          seed: actualSeed,
          resolution: `${outW}x${outH}`,
          aspect_ratio: aspectRatio,
          final_resolution_mp: finalResolution,
          low_res_mp: params.lowResMP ?? 0.2,
          video_length: videoLengthFrames,
          duration_seconds: videoLengthFrames / fps,
          fps,
          pass1_steps: params.firstSamplerSteps ?? 4,
          pass2_steps: { '3step': 3, '4step': 4, '5step': 5, '6step': 6, '7step': 7 }[params.sigmaVariant || '3step'] ?? 3,
          sigma_variant: params.sigmaVariant || '3step',
          pass2_sampler: params.pass2Sampler || 'euler', // (правка 69)
          pass1_sampler: params.pass1Sampler || 'euler', // (правка 70)
          pass1_scheduler: params.pass1Scheduler || 'simple', // (правка 70)
          turbo_lora_strength: typeof params.turboLoraStrength === 'number' ? params.turboLoraStrength : 1.0, // (правка 70)
          minimax_h3_reference_detail: params.referenceDetail || 'match', // (правка 58) — meta-dialog уже умеет показывать это поле
          low_vram_attention: params.lowVramAttention !== false,
          chunk_feed_forward: params.chunkFeedForward !== false,
          ...(params.chunkFeedForward !== false
            ? {
                chunk_ff_chunks: params.chunkFFChunks ?? 2,
                chunk_ff_threshold: params.chunkFFThreshold ?? 4096,
              }
            : {}),
          lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
          references: metaReferences,
          started_at: Date.now(),
        })
        persistGenParams()

        pollUntilDone(promptId, queueId, Date.now())
        useGenProgress.getState().startVideoGen(promptId)
      } catch (err) {
        // (фикс Phase 4) Детальная диагностика: логируем ТОЧНУЮ ошибку,
        // включая HTTP-статус и тело ответа. Это видно в DevTools console.
        const isTimeout = err instanceof DOMException && err.name === 'AbortError'
        const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message)
        let errMsg: string
        if (isTimeout) {
          errMsg = 'Таймаут запроса (120 с). Сервер, вероятно, ждёт освобождения GPU. Попробуйте ещё раз.'
        } else if (isNetwork) {
          errMsg = 'Веб-сервер недоступен (ERR_CONNECTION_REFUSED). Убедитесь, что start.bat запущен.'
        } else {
          errMsg = err instanceof Error ? err.message : String(err)
        }
        // (правка 141) Если ComfyUI не запущен — показываем понятное сообщение
        const isComfyDown = /ComfyUI не отвечает|Failed to load resource|502|Bad Gateway|ERR_CONNECTION_REFUSED/i.test(errMsg)
        const displayMsg = isComfyDown
          ? 'ComfyUI не запущен или не отвечает. Запустите start.bat и подождите, пока ComfyUI запустится (30-90 секунд).'
          : errMsg
        console.error(`[gen] generate() CAUGHT: type=${isTimeout ? 'timeout' : isNetwork ? 'network' : 'other'}`, err, `| displayMsg: ${displayMsg}`)
        queue.setStatus(queueId, 'error', displayMsg)
        // Явный тост: 409 от vram-arbiter (ассистент занят VRAM) и другие
        // ошибки отправки должны быть видны сразу, а не только в очереди задач
        toast.error('Генерация не отправлена', { description: displayMsg, duration: 8000 })
        const cur = useGenProgress.getState().video
        if (cur.phase === 'idle' || cur.phase === 'done' || cur.phase === 'error' || cur.phase === 'submitting') {
          useGenProgress.getState().setVideoPhase('error')
          useGenProgress.getState().setVideoError(displayMsg)
        }
      }
    },
    [queue, pollUntilDone]
  )

  const interrupt = useCallback(async () => {
    // (fix H2) Ломаем эпоху: если сейчас в полёте POST /generate, его
    // продолжение увидит смену и отменит уже принятую задачу.
    interruptEpoch++
    const activeJobIds = useGenQueue
      .getState()
      .items
      .filter((i) => i.type === 'video' && ['submitting', 'queued', 'running'].includes(i.status))
      .map((i) => i.promptId)
      .filter((pid): pid is string => Boolean(pid))

    // Set abort flags FIRST — prevents in-flight poll responses from
    // overwriting the clean state with a spurious 'error'.
    for (const pid of timersRef.current.keys()) {
      abortFlagsRef.current.set(pid, true)
    }
    // Also mark active queue items as cancelled immediately.
    useGenQueue
      .getState()
      .items
      .filter((i) => i.type === 'video' && ['submitting', 'queued', 'running'].includes(i.status))
      .forEach((i) => useGenQueue.getState().setStatus(i.id, 'cancelled'))

    // (правка 141) Send cancel requests in PARALLEL (not sequential) to
    // reduce total cancel time. Also add a small delay between sends to
    // avoid overwhelming ComfyUI with concurrent /interrupt + /queue POSTs.
    const cancelPromises = activeJobIds.map(async (promptId) => {
      try {
        await fetch('/api/comfy/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt_id: promptId }),
        })
      } catch { /* ignore */ }
      genParamsMap.delete(promptId)
    })
    await Promise.allSettled(cancelPromises)
    persistGenParams()

    clearAllTimers()
    useGenProgress.getState().resetVideoGen()
    // Remove cancelled items from queue
    useGenQueue
      .getState()
      .items
      .filter((i) => i.type === 'video' && i.status === 'cancelled')
      .forEach((i) => useGenQueue.getState().remove(i.id))

    toast.info('Генерация отменена')
  }, [clearAllTimers])

  const reset = useCallback(() => {
    clearAllTimers()
    useGenProgress.getState().resetVideoGen()
  }, [clearAllTimers])

  return {
    phase: progressStore.video.phase,
    error: progressStore.video.error,
    promptId: progressStore.video.promptId,
    progressValue: progressStore.video.progressValue,
    progressMax: progressStore.video.progressMax,
    executingNode: progressStore.video.executingNode,
    statusMessage: progressStore.video.statusMessage,
    generate,
    interrupt,
    reset,
  }
}
