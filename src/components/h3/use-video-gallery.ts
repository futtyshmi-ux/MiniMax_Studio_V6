'use client'

/**
 * Shared gallery loading hook — lists generated videos from ComfyUI's
 * output directory via /api/comfy/files. Used by both the Generate view
 * (results under the prompt) and the Gallery tab so they stay in sync.
 *
 * Auto-refresh: the hook subscribes to the global generation phase and, while
 * a generation is in progress, silently polls the file list and detects
 * completion via ComfyUI's status endpoint. This means the Gallery tab picks
 * up a finished video immediately — even if the Generate tab is unmounted
 * (whose own polling would have stopped).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useGenProgress } from '@/lib/gen-progress-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import type { VideoGalleryFile } from './video-gallery-grid'

const ACTIVE_PHASES = new Set(['submitting', 'queued', 'running'])
const ACTIVE_POLL_MS = 2500

export function useVideoGallery(opts?: {
  /** Current generation phase — retriggers loads shortly after 'done'. */
  phase?: string
}) {
  const [files, setFiles] = useState<VideoGalleryFile[]>([])
  /** (правка 91) Папки проектов (подпапки output; общая '' не входит). */
  const [folders, setFolders] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // Монотонный id загрузки: применяем состояние только самого свежего
  // запроса — иначе параллельные load() (опрос + ручное обновление) могут
  // завершиться в обратном порядке и устаревший список перетрёт свежий.
  const loadSeq = useRef(0)
  // Prefer an explicitly passed phase; otherwise read the global store so
  // GalleryView (and any consumer) auto-refreshes without wiring a prop.
  const storePhase = useGenProgress((s) => s.video.phase)
  const phase = opts?.phase ?? storePhase
  // (правка 134) Сигнал внешнего обновления — заводской сброс / удаление
  // контента. При bump() галерея сразу перечитывает список файлов, не
  // дожидаясь переключения вкладок.
  const refreshVersion = useGalleryRefresh((s) => s.version)

  /**
   * Load the file list.
   * @param background When true, skip the visible "loading" state so the grid
   *   keeps showing the current files (no skeleton flicker) — used for the
   *   periodic/refresh loads, not the very first load.
   */
  const load = useCallback(async (background = false) => {
    const seq = ++loadSeq.current
    if (!background) setLoading(true)
    try {
      const res = await fetch('/api/comfy/files?type=all')
      if (seq !== loadSeq.current) return // уже есть более свежая загрузка
      if (!res.ok) {
        console.warn('[Gallery] Failed to load files:', res.status)
        return
      }
      const data = await res.json()
      if (seq !== loadSeq.current) return
      setFolders(Array.isArray(data.folders) ? data.folders : [])
      const videoFiles = (data.files ?? []).filter(
        (f: { type?: string; name?: string }) =>
          f.type?.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i),
      )
      const next: VideoGalleryFile[] = videoFiles.map(
        (f: { url: string; filename?: string; name?: string; subfolder?: string; mtime?: number; generationTime?: number | null }) => ({
          url: f.url,
          filename: f.filename || f.name || '',
          subfolder: f.subfolder || '',
          mtime: f.mtime,
          generationTime: typeof f.generationTime === 'number' ? f.generationTime : null,
        }),
      )
      // Only update state if the file list actually changed (avoids re-renders)
      setFiles((prev) => {
        if (
          prev.length === next.length &&
          prev.every((p, i) => p.filename === next[i].filename && p.subfolder === next[i].subfolder && p.mtime === next[i].mtime)
        ) {
          return prev
        }
        return next
      })
    } catch (err) {
      console.error('[Gallery] Error loading files:', err)
    } finally {
      // (фикс M5) loading снимает ПОСЛЕДНИЙ живой запрос — независимо от
      // background. Раньше фоновая загрузка (watcher активной генерации)
      // обгоняла стартовую: стартовая отбрасывалась по seq (не трогала
      // loading), фоновая — background и не должна была → skeleton висел
      // ВЕЧНО («не отображаются видео» после запуска с активной генерацией).
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // After a generation finishes the file may take a moment to flush/encode —
  // a few staggered silent reloads guarantee the newest video shows up.
  useEffect(() => {
    if (phase === 'done') {
      const timers = [1000, 3000, 6000, 12000].map((delay) => setTimeout(() => load(true), delay))
      return () => timers.forEach(clearTimeout)
    }
  }, [phase, load])

  // (правка 134) Внешний сигнал обновления (заводской сброс / удаление
  // контента): перечитываем список файлов в фоне, без skeleton-фликера.
  useEffect(() => {
    if (refreshVersion === 0) return
    // Небольшая задержка — даём бэкенду время реально удалить файлы.
    const t = setTimeout(() => void load(true), 300)
    return () => clearTimeout(t)
  }, [refreshVersion, load])

  // While a generation is active, keep the list fresh and detect completion
  // directly from the backend so the new video appears even if the Generate
  // tab (and its polling) is unmounted. Flipping the shared phase to
  // 'done'/'error' also keeps the status card and queue indicator in sync and
  // stops this watcher (the effect re-runs and clears the interval).
  const active = ACTIVE_PHASES.has(phase)
  useEffect(() => {
    if (!active) return
    // (фикс M5) Счётчик подряд идущих 'unknown': карточка может следить за
    // задачей, умершей вместе с перезапуском ComfyUI (persisted 'running'
    // остался после перезагрузки страницы). Если за prompt_id не осталось
    // активного элемента очереди — очередь его не подхватит, и карточка
    // вечно крутила бы «Генерация…». ~8 тиков × 2.5с = 20с — честно роняем.
    let unknownStreak = 0
    const tick = async () => {
      await load(true)
      const { promptId, phase: cur } = useGenProgress.getState().video
      if (!promptId || !ACTIVE_PHASES.has(cur)) return
      try {
        const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
        if (!res.ok) return
        const s = await res.json()
        if (s.status === 'done') {
          useGenProgress.getState().setVideoPhase('done')
          useGenProgress.getState().setVideoProgress(100, 100)
        } else if (s.status === 'error') {
          // ComfyUI отвечает «error» на ПРЕРВАННЫЙ промпт: если задача
          // отменена осознанно (кнопка/очередь) — не показываем красную
          // «Ошибку», оставляем чистое состояние отмены.
          const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qItem?.status === 'cancelled') return
          useGenProgress.getState().setVideoPhase('error')
          if (s.detail) useGenProgress.getState().setVideoError(s.detail)
        } else if (s.status === 'unknown') {
          unknownStreak++
          if (unknownStreak >= 8) {
            const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
            const qActive = qItem && ['submitting', 'queued', 'running'].includes(qItem.status)
            // Элемент очереди активен → им занимается его собственный поллер
            // (он честно покажет ошибку после своих 20 'unknown'). Действуем
            // только когда карточка осталась одна, без элемента очереди.
            if (!qActive) {
              const isNotFound = s.detail?.includes('не найдена') || s.detail?.includes('отклонена')
              useGenProgress.getState().setVideoError(isNotFound
                ? 'Задача не найдена в ComfyUI (сервер был перезапущен) — отслеживание остановлено'
                : 'ComfyUI не отвечает — отслеживание остановлено')
              useGenProgress.getState().setVideoPhase('error')
            }
          }
        } else {
          unknownStreak = 0
        }
        // 'running'/'queued' — генерация жива, просто ждём следующего тика
      } catch {
        // transient network blip — retry on the next tick
      }
    }
    void tick()
    const id = setInterval(() => void tick(), ACTIVE_POLL_MS)
    return () => clearInterval(id)
  }, [active, phase, load])

  const deleteFile = useCallback(async (filename: string, subfolder: string) => {
    try {
      const res = await fetch('/api/comfy/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, subfolder }),
      })
      if (res.ok) {
        toast.success('Видео удалено')
        setFiles((prev) => prev.filter((f) => !(f.filename === filename && f.subfolder === subfolder)))
      } else {
        toast.error('Не удалось удалить файл')
      }
    } catch {
      toast.error('Ошибка удаления')
    }
  }, [])

  return { files, folders, loading, load, deleteFile }
}