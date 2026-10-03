'use client'

/**
 * Reference viewer dialog — full-size preview of a reference file
 * (image / video with player / audio with waveform-less player).
 * Sources the file from ComfyUI input/ (or the local staging fallback)
 * via /api/comfy/file, so staged refs are viewable offline too.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { FilmIcon, ImageIcon, AudioLinesIcon } from 'lucide-react'

export interface RefViewerData {
  kind: 'image' | 'video' | 'audio'
  name: string
  /** ComfyUI input/ filename (staged names are served too). */
  path: string
}

export function RefViewerDialog({
  data,
  onOpenChange,
}: {
  data: RefViewerData | null
  onOpenChange: (v: boolean) => void
}) {
  const src = data
    ? `/api/comfy/file?filename=${encodeURIComponent(data.path)}&type=input`
    : ''

  return (
    <Dialog open={!!data} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden p-0 gap-0">
        {data && (
          <>
            <DialogHeader className="px-4 pt-4 pb-2 shrink-0">
              <DialogTitle className="flex items-center gap-2 text-sm font-medium">
                {data.kind === 'image' && <ImageIcon className="w-4 h-4 text-purple-400" />}
                {data.kind === 'video' && <FilmIcon className="w-4 h-4 text-cyan-400" />}
                {data.kind === 'audio' && <AudioLinesIcon className="w-4 h-4 text-emerald-400" />}
                <span className="truncate">{data.name}</span>
              </DialogTitle>
              <DialogDescription className="sr-only">
                Просмотр референса
              </DialogDescription>
            </DialogHeader>
            <div className="px-4 pb-4 flex items-center justify-center bg-black/40 rounded-b-lg min-h-[300px] max-h-[80vh] overflow-auto">
              {data.kind === 'image' && (
                <img
                  src={src}
                  alt={data.name}
                  className="max-w-full max-h-[76vh] object-contain rounded"
                  draggable={false}
                />
              )}
              {data.kind === 'video' && (
                <video
                  src={src}
                  controls
                  autoPlay
                  loop
                  playsInline
                  className="max-w-full max-h-[76vh] rounded"
                />
              )}
              {data.kind === 'audio' && (
                <div className="w-full flex flex-col items-center gap-6 py-16">
                  <AudioLinesIcon className="w-20 h-20 text-emerald-400/60" />
                  <audio src={src} controls autoPlay className="w-full max-w-2xl" />
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
