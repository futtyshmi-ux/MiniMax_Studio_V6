import { NextRequest, NextResponse } from 'next/server'
import { promises as fs, existsSync } from 'fs'
import { basename, extname, join, resolve } from 'path'
import { serveLocalFile } from '@/lib/local-file'

/**
 * (правка 108) Вложения чата ассистента — ИЗОЛИРОВАННОЕ хранилище.
 *
 * Картинки/видео, прикреплённые в чате, существуют ТОЛЬКО в чате и нужны
 * ТОЛЬКО для генерации описания (мультимодальный LLM). Они НЕ должны:
 *   • лежать в ComfyUI/input/ (общая папка референсов генерации);
 *   • попадать в референсы генерации (<Picture N>/<Video N>);
 *   • появляться в галерее / upscale / «чистке input».
 *
 * Поэтому они живут в отдельной папке проекта <project>/data/chat-attachments/
 * (переносима вместе с data/assistant-chats.json) и обслуживаются этим роутом.
 *
 *   POST   /api/assistant/attachment          — загрузка (FormData: file)
 *   GET    /api/assistant/attachment?filename — подача (Range-совместимо)
 *   DELETE /api/assistant/attachment?filename — удаление (при удалении чата)
 */
export const dynamic = 'force-dynamic'

const ATTACH_DIR = resolve(process.cwd(), 'data', 'chat-attachments')

// Лимит вложения: раньше файл буферизовался целиком без ограничения, и
// гигабайтное видео могло уронить весь Node-процесс (вместе с генерациями).
// 1 ГБ достаточно для любых референсов LLM.
const MAX_ATTACH_BYTES = 1024 * 1024 * 1024

/** Unsafe filename characters — replace with '_' (any OS). */
const UNSAFE = /[<>:"/\\|?*\x00-\x1f]/g

/** Keep only image/video extensions (everything else is meaningless for the LLM). */
function allowedExt(ext: string): string | null {
  const e = ext.toLowerCase()
  if (
    e === '.png' || e === '.jpg' || e === '.jpeg' || e === '.webp' ||
    e === '.gif' || e === '.bmp' || e === '.avif' ||
    e === '.mp4' || e === '.m4v' || e === '.webm' || e === '.mov' || e === '.mkv'
  ) return e
  return null
}

/** Traversal-safe resolution inside ATTACH_DIR. null = invalid/missing. */
async function safeAttachPath(filename: string): Promise<string | null> {
  const name = basename(filename)
  if (!name || name === '.' || name === '..') return null
  const target = resolve(ATTACH_DIR, name)
  if (!target.startsWith(ATTACH_DIR)) return null
  try {
    const st = await fs.stat(target)
    if (!st.isFile()) return null
  } catch {
    return null
  }
  return target
}

/* ─── POST: upload ─── */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    const ext = allowedExt(extname(file.name))
    if (!ext) {
      return NextResponse.json(
        { error: 'Поддерживаются только изображения и видео (png, jpg, webp, gif, mp4, webm, mov…)' },
        { status: 400 },
      )
    }
    if (file.size > MAX_ATTACH_BYTES) {
      return NextResponse.json(
        { error: 'Файл слишком большой (лимит 1 ГБ). Уменьшите видео перед вложением.' },
        { status: 413 },
      )
    }
    const buf = Buffer.from(await file.arrayBuffer())
    await fs.mkdir(ATTACH_DIR, { recursive: true })
    const safeBase = basename(file.name).replace(UNSAFE, '_') || 'attachment'
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeBase}`
    await fs.writeFile(join(ATTACH_DIR, unique), buf)
    return NextResponse.json({ name: unique })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Upload failed: ${msg}` }, { status: 500 })
  }
}

/* ─── GET: serve (Range-capable for video seeking) ─── */
export async function GET(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename')
  if (!filename) {
    return new Response('Missing filename', { status: 400 })
  }
  const source = await safeAttachPath(filename)
  if (!source) {
    return new Response('Attachment not found', { status: 404 })
  }
  const local = await serveLocalFile(req, filename, source)
  if (local) return local
  return new Response('Failed to serve attachment', { status: 500 })
}

/* ─── DELETE: remove (best-effort, called when a chat is deleted) ─── */
export async function DELETE(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename')
  if (!filename) {
    return NextResponse.json({ error: 'Missing filename' }, { status: 400 })
  }
  const source = await safeAttachPath(filename)
  if (!source) {
    return NextResponse.json({ deleted: false, reason: 'not found' })
  }
  try {
    await fs.unlink(source)
    return NextResponse.json({ deleted: true })
  } catch {
    return NextResponse.json({ deleted: false })
  }
}
