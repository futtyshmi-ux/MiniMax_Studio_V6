'use client'

/**
 * VideoGalleryGrid — compact video gallery for the video generation tab.
 * Shows generated videos as a grid with thumbnails, click → VideoLightbox player.
 */

import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  DownloadIcon,
  RefreshCcwIcon,
  VideoIcon,
  Trash2Icon,
  InfoIcon,
  RotateCcwIcon,
  SparklesIcon,
  Maximize2Icon,
} from 'lucide-react'
import { MetaDialog } from './meta-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { VideoLightbox } from './video-lightbox'
import { useGenDurations, formatDuration, formatSeconds } from '@/lib/gen-duration-store'
import { restoreFromMeta } from '@/lib/restore-from-meta'
import { useUpscaleTarget } from '@/lib/upscale-target-store'

/** Custom MIME для drag&drop видео из галереи в поле загрузки Upscale. */
export const H3_VIDEO_DND_MIME = 'application/x-h3-video'

/** Thumbnail width for gallery cards (server-side sharp/ffmpeg resize). */
const THUMB_WIDTH = 600

export interface VideoGalleryFile {
  url: string
  filename: string
  subfolder: string
  size?: number
  mtime?: number
  /** Время генерации (секунды) из .meta.json sidecar — показывается на бейдже. */
  generationTime?: number | null
}

interface VideoGalleryGridProps {
  files: VideoGalleryFile[]
  loading?: boolean
  onRefresh?: () => void
  onDeleteFile?: (filename: string, subfolder: string) => void | Promise<void>
  emptyHint?: string
}

/**
 * (правка 78) Пометки источников видео в галерее:
 * - «DLSS 5» — вывод neural-rendering моста (DLSS 5 Visual Enhancer):
 *   «<исходное>_DLSS5_<YYYYMMDD-HHMMSS-NNNNNN>.ext»
 *   (upscale/src/…/processor.py + core/naming.py, rename_mode=Auto);
 * - «Upscale» — вывод настоящего апскейла (RTX Video SDK, вкладка
 *   «Upscale»): «<исходное>_RTXVIDEO[_PREVIEW]_<stamp>-<uuid8>.ext»
 *   (upscale/src/upscale/video/processor.py:67-69).
 * Minimax-генерации так не называются — это надёжные маркеры.
 */
export type VideoSourceBadge = 'dlss5' | 'upscale'

export function videoSourceBadge(file: Pick<VideoGalleryFile, 'filename'>): VideoSourceBadge | null {
  if (/_DLSS5_\d{8}-\d{6}-\d{6}/.test(file.filename)) return 'dlss5'
  if (/_RTXVIDEO(?:_PREVIEW)?_\d{8}-\d{6}-[0-9a-f]{8}/.test(file.filename)) return 'upscale'
  return null
}

/** @deprecated используй videoSourceBadge — различает DLSS 5 и Upscale. */
export function isUpscaleVideo(file: Pick<VideoGalleryFile, 'filename'>): boolean {
  return videoSourceBadge(file) !== null
}

function thumbUrl(file: VideoGalleryFile): string {
  // The file URL from /api/comfy/files already carries `&_t=<mtime>` for
  // cache-busting — just add the thumbnail width.
  const sep = file.url.includes('?') ? '&' : '?'
  return `${file.url}${sep}width=${THUMB_WIDTH}`
}

/**
 * Poster URL — server-side extracted JPEG frame (ffmpeg, disk-cached).
 * Used as the <video poster> so the grid paints instantly without
 * downloading full videos.
 */
function posterUrl(file: VideoGalleryFile): string {
  return thumbUrl(file)
}

export const VideoGalleryGrid = memo(function VideoGalleryGrid({
  files,
  loading = false,
  onRefresh,
  onDeleteFile,
  emptyHint = 'Пока нет видео',
}: VideoGalleryGridProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [metaIndex, setMetaIndex] = useState<number | null>(null)
  /** Удаление, ожидающее подтверждения (диалог «Удалить видео?»). */
  const [pendingDelete, setPendingDelete] = useState<{ filename: string; subfolder: string } | null>(null)
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  const durations = useGenDurations((s) => s.entries)

  // Build a filename → entry map. Entries without a filename (very old
  // sessions) are NOT matched — an index-based guess ("N-th newest entry ↔
  // N-th newest file") happily showed another video's generation time.
  const durationMap = useMemo(() => {
    const byName = new Map<string, (typeof durations)[0]>()
    const sorted = [...durations].sort((a, b) => b.ts - a.ts)
    for (const entry of sorted) {
      if (entry.filename) {
        byName.set(entry.filename, entry)
      }
    }
    return byName
  }, [durations])

  /* ── «Отправить на апскейл»: кладём цель в store и переключаем вкладку.
   *    UpscaleView заберёт её и импортирует видео через сервер
   *    (/api/upscale/import) — браузер в цикле не участвует. ── */
  const sendToUpscale = useCallback((file: VideoGalleryFile) => {
    useUpscaleTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-upscale'))
  }, [])

  /* ── Delete handler (оптимистичное обновление в useVideoGallery) ── */
  const handleDelete = useCallback(
    async (filename: string, subfolder: string) => {
      if (!onDeleteFile) return
      await onDeleteFile(filename, subfolder)
    },
    [onDeleteFile],
  )

  /** Подтвердить отложенное удаление (кнопка «Удалить» или Enter). */
  const confirmPendingDelete = useCallback(async () => {
    if (!pendingDelete) return
    const { filename, subfolder } = pendingDelete
    setPendingDelete(null)
    await handleDelete(filename, subfolder)
  }, [pendingDelete, handleDelete])

  /* ── Empty state ── */
  if (!loading && files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-12">
        <VideoIcon className="w-10 h-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    )
  }

  /* ── Loading skeletons ── */
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="aspect-video rounded-lg bg-[var(--surface-2)] animate-pulse"
          />
        ))}
      </div>
    )
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-3">
        <Badge variant="secondary" className="text-xs">
          {files.length} видео
        </Badge>
        {onRefresh && (
          <button
            onClick={() => onRefresh()}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-muted-foreground transition-colors"
            title="Обновить"
          >
            <RefreshCcwIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <AnimatePresence mode="popLayout">
          {files.map((file, index) => (
            <motion.div
              key={`${file.subfolder}/${file.filename}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="group relative aspect-video rounded-lg overflow-hidden border border-border bg-[var(--surface-2)] cursor-pointer"
              onClick={() => setLightboxIndex(index)}
              draggable
              onDragStartCapture={(e) => {
                // Drag&drop в поле загрузки Upscale: отдаём имя файла из
                // общей папки output (а не локальный File) — upscale-view
                // импортирует его на сервере (/api/upscale/import).
                // (правка 93) 'copyMove': цель в галерее папок объявляет
                // dropEffect 'move' — при effectAllowed 'copy' браузер
                // считает их несовместимыми и событие drop НЕ наступает.
                e.dataTransfer.setData(
                  H3_VIDEO_DND_MIME,
                  JSON.stringify({ filename: file.filename, subfolder: file.subfolder }),
                )
                e.dataTransfer.setData('text/plain', file.filename)
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onPointerEnter={() => { videoRefs.current[index]?.play().catch(() => {}) }}
              onPointerLeave={() => { const v = videoRefs.current[index]; if (v) { v.pause(); v.currentTime = 0; } }}
            >
              {/* Video thumbnail — poster JPEG (server-cached) + lazy video.
                  preload="none" keeps the grid light: full video streams
                  only on hover (pointer events below) or in the lightbox. */}
              <video
                ref={(el) => { videoRefs.current[index] = el }}
                src={file.url}
                poster={posterUrl(file)}
                muted
                loop
                preload="none"
                playsInline
                className="w-full h-full object-cover pointer-events-none"
                onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0; }}
              />

              {/* Hover overlay */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                <a
                  href={file.url}
                  download={file.filename}
                  onClick={(e) => e.stopPropagation()}
                  className="p-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white transition-colors"
                  title="Скачать"
                >
                  <DownloadIcon className="w-3.5 h-3.5" />
                </a>
                <button
                  onClick={(e) => { e.stopPropagation(); setMetaIndex(index) }}
                  className="p-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white transition-colors"
                  title="Метаданные"
                >
                  <InfoIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void restoreFromMeta(`${file.subfolder}/${file.filename}`)
                  }}
                  className="p-1.5 rounded-lg bg-cyan-500/40 hover:bg-cyan-500/60 text-white transition-colors"
                  title="Повторить генерацию (восстановить все параметры)"
                >
                  <RotateCcwIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    sendToUpscale(file)
                  }}
                  className="p-1.5 rounded-lg bg-violet-500/40 hover:bg-violet-500/60 text-white transition-colors"
                  title="Отправить на апскейл (DLSS 5)"
                >
                  <SparklesIcon className="w-3.5 h-3.5" />
                </button>
                {onDeleteFile && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setPendingDelete({ filename: file.filename, subfolder: file.subfolder }) }}
                    className="p-1.5 rounded-lg bg-red-500/40 hover:bg-red-500/60 text-white transition-colors"
                    title="Удалить"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* (правка 78) Пометка источника — результат DLSS 5 / апскейла,
                  а не Minimax-генерации. Всегда видна, не только при наведении. */}
              {(() => {
                const badge = videoSourceBadge(file)
                if (!badge) return null
                if (badge === 'upscale') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[9px] font-semibold text-cyan-300 border border-cyan-400/40"
                      title="Результат апскейла (RTX Video SDK, вкладка «Upscale»)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Maximize2Icon className="w-2.5 h-2.5" />
                      Upscale
                    </span>
                  )
                }
                return (
                  <span
                    className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[9px] font-semibold text-fuchsia-300 border border-fuchsia-400/40"
                    title="Результат апскейла (вкладка «Upscale»)"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <SparklesIcon className="w-2.5 h-2.5" />
                    DLSS 5
                  </span>
                )
              })()}

              {/* Filename + duration badge */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-1.5">
                <div className="flex items-center justify-between gap-1">
                  <p className="text-[10px] text-white/70 truncate font-mono">
                    {String(files.length - index).padStart(3, '0')}
                  </p>
                  {(() => {
                    // Время генерации: приоритет — значение из метаданных
                    // (.meta.json → generation_time, то же, что в диалоге
                    // метаданных); фолбэк — клиентская оценка useGenDurations.
                    const metaSec = typeof file.generationTime === 'number' && file.generationTime > 0
                      ? file.generationTime
                      : null
                    const storeEntry = durationMap.get(file.filename)
                    const label = metaSec != null
                      ? formatSeconds(metaSec)
                      : storeEntry
                        ? formatDuration(storeEntry.durationMs)
                        : null
                    if (!label) return null
                    return (
                      <span
                        className="text-[9px] text-cyan-300/80 font-medium shrink-0"
                        title="Время генерации (из метаданных)"
                      >
                        {label}
                      </span>
                    )
                  })()}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Lightbox: onDelete вызывает удаление напрямую — у лайтбокса есть
          собственное inline-подтверждение, второй диалог здесь не нужен
          (раньше было двойное подтверждение). */}
      {lightboxIndex !== null && (
        <VideoLightbox
          files={files.map((f) => ({ url: f.url, filename: f.filename, subfolder: f.subfolder }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onDelete={onDeleteFile ? (filename, subfolder) => handleDelete(filename, subfolder) : undefined}
        />
      )}

      {/* Metadata dialog */}
      {metaIndex !== null && files[metaIndex] && (
        <MetaDialog
          filePath={`${files[metaIndex].subfolder}/${files[metaIndex].filename}`}
          filename={files[metaIndex].filename}
          onClose={() => setMetaIndex(null)}
        />
      )}

      {/* Delete confirmation — Enter confirms, Esc cancels */}
      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent
          className="max-w-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void confirmPendingDelete()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2Icon className="w-4 h-4 text-red-400" />
              Удалить видео?
            </DialogTitle>
            <DialogDescription>
              Файл «{pendingDelete?.filename}» и его метаданные будут удалены
              безвозвратно. Это действие нельзя отменить.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-1">
            <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              autoFocus
              onClick={() => void confirmPendingDelete()}
            >
              <Trash2Icon className="w-3.5 h-3.5" />
              Удалить
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50 text-right -mt-1">
            Enter — удалить · Esc — отмена
          </p>
        </DialogContent>
      </Dialog>
    </>
  )
})
