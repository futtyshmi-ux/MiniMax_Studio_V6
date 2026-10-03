import { NextRequest, NextResponse } from 'next/server'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/**
 * GET /api/comfy/files?type=all|video|image
 * Lists output files from the ComfyUI output directory.
 *
 * - (правка 91) Один уровень вложенности: файлы из подпапок проектов
 *   идут с subfolder = имя папки; сами папки — в `folders`.
 * - `.meta.json` sidecars and dotfiles are never listed.
 * - Files written within the last HOT_SKIP_SECONDS are skipped: VHS creates
 *   the output mp4 at the start of muxing and writes it progressively, so a
 *   "fresh" file is usually still incomplete (serving it would poison the
 *   browser cache for the plain file URL).
 * - URLs carry `&_t=<mtime>` so a new version of a file is always a new URL –
 *   a mid-write fetch can never shadow the finished file in the HTTP cache.
 */
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']
const HOT_SKIP_SECONDS = 4

async function listDir(
  OUTPUT_DIR: string,
  dirAbs: string,
  subfolder: string,
  typeFilter: string,
): Promise<Array<{ url: string; filename: string; subfolder: string; mtime: number; type: string; hasMeta: boolean; generationTime: number | null }>> {
  const files: Array<{ url: string; filename: string; subfolder: string; mtime: number; type: string; hasMeta: boolean; generationTime: number | null }> = []
  const entries = await fs.readdir(dirAbs, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.endsWith('.meta.json')) continue
    const ext = path.extname(entry.name).toLowerCase()

    const isVideo = VIDEO_EXTS.includes(ext)
    const isImage = IMAGE_EXTS.includes(ext)
    if (typeFilter === 'video' && !isVideo) continue
    if (typeFilter === 'image' && !isImage) continue
    if (!isVideo && !isImage) continue

    let mtime = 0
    let hasMeta = false
    let generationTime: number | null = null
    try {
      const filePath = path.join(dirAbs, entry.name)
      const stats = await fs.stat(filePath)
      mtime = Math.floor(stats.mtimeMs / 1000)
      const metaPath = filePath + '.meta.json'
      hasMeta = existsSync(metaPath)
      // Время генерации из метаданных (sidecar .meta.json → generation_time) —
      // тот же источник, что показывает диалог метаданных. Бейдж превью теперь
      // берёт значение ОТСЮДА, а не из клиентской оценки useGenDurations
      // (откуда и было расхождение «много/мало»).
      if (hasMeta) {
        try {
          const raw = await fs.readFile(metaPath, 'utf-8')
          const meta = JSON.parse(raw) as { generation_time?: unknown; params?: { generation_time?: unknown } }
          const top = typeof meta.generation_time === 'number' ? meta.generation_time : null
          const nested = typeof meta.params?.generation_time === 'number' ? meta.params.generation_time : null
          const gt = top ?? nested
          if (typeof gt === 'number' && Number.isFinite(gt) && gt > 0) generationTime = gt
        } catch { /* sidecar malformed / mid-write — оставим null */ }
      }
    } catch { /* ignore */ }

    // Still being written — skip until it goes "cold"
    if (Date.now() / 1000 - mtime < HOT_SKIP_SECONDS) continue

    files.push({
      url: `/api/comfy/file?filename=${encodeURIComponent(entry.name)}&subfolder=${encodeURIComponent(subfolder)}&type=output&_t=${mtime}`,
      filename: entry.name,
      subfolder,
      mtime,
      type: isVideo ? 'video' : 'image',
      hasMeta,
      generationTime,
    })
  }
  return files
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const typeFilter = searchParams.get('type') || 'all'
  const OUTPUT_DIR = getAppConfig().outputDir

  if (!OUTPUT_DIR) {
    return NextResponse.json({ files: [], folders: [] })
  }

  try {
    const rootEntries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true })
    // (правка 91) Подпапки = проектные папки галереи.
    const folders = rootEntries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'ru'))

    let files = await listDir(OUTPUT_DIR, OUTPUT_DIR, '', typeFilter)
    for (const folder of folders) {
      const sub = await listDir(OUTPUT_DIR, path.join(OUTPUT_DIR, folder), folder, typeFilter)
      files = files.concat(sub)
    }

    // Sort by mtime descending (newest first)
    files.sort((a, b) => b.mtime - a.mtime)

    return NextResponse.json({ files, folders })
  } catch {
    return NextResponse.json({ files: [], folders: [] })
  }
}
