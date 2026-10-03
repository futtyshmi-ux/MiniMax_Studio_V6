import { NextResponse } from 'next/server'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sttStatus } from '@/lib/stt-runner'
import { stopStt } from '@/lib/stt-runner'

/**
 * (правка 72) STT-модели: скачивание, прогресс, отмена.
 *
 * POST   — начать скачивание модели
 * DELETE — отменить активное скачивание
 * GET    — прогресс скачивания (?name=small)
 *
 * Модели скачиваются из HuggingFace (ggerganov/whisper.cpp)
 * во встроенную папку <project>/stt/models/.
 */
export const dynamic = 'force-dynamic'

/* (правка 73) Модели лежат в корне репозитория (папки models/ больше нет —
 * старые URL вида .../resolve/main/models/*.bin дают 404). */
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

const STT_MODEL_CATALOG: Array<{
  name: string
  file: string
  sizeLabel: string
  quality: string
}> = [
  { name: 'tiny',     file: 'ggml-tiny.bin',     sizeLabel: '~75 МБ',  quality: 'быстро, качество низкое' },
  { name: 'base',     file: 'ggml-base.bin',     sizeLabel: '~142 МБ', quality: 'среднее качество' },
  { name: 'small',    file: 'ggml-small.bin',    sizeLabel: '~466 МБ', quality: 'хорошее (рекомендуется)' },
  { name: 'medium',   file: 'ggml-medium.bin',   sizeLabel: '~1.5 ГБ', quality: 'отличное' },
  { name: 'large-v3', file: 'ggml-large-v3.bin', sizeLabel: '~3.1 ГБ', quality: 'лучшее, медленно' },
]

interface DownloadState {
  name: string
  file: string
  dest: string
  downloaded: number
  total: number
  done: boolean
  error: string | null
  cancelled: boolean
  controller: AbortController
}

const active = new Map<string, DownloadState>()

function destDir(): string {
  const cfg = getAppConfig()
  const dir = join(cfg.sttDir, 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function isAlreadyDownloaded(name: string): boolean {
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (!cat) return false
  const dest = join(destDir(), cat.file)
  return existsSync(dest) && statSync(dest).size > 0
}

/* ─── GET /api/stt/models/download?name=small ─── */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const name = (url.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const st = active.get(name)
  if (st) {
    return NextResponse.json({
      name: st.name,
      active: true,
      downloaded: st.downloaded,
      total: st.total,
      done: st.done,
      error: st.error,
      cancelled: st.cancelled,
    })
  }

  // Not actively downloading — report if file already exists
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (cat && isAlreadyDownloaded(name)) {
    const dest = join(destDir(), cat.file)
    return NextResponse.json({
      name,
      active: false,
      downloaded: statSync(dest).size,
      total: statSync(dest).size,
      done: true,
      error: null,
      cancelled: false,
    })
  }

  return NextResponse.json({ name, active: false, downloaded: 0, total: 0, done: false, error: null, cancelled: false })
}

/* ─── POST /api/stt/models/download ─── */
export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = (typeof body.name === 'string' ? body.name : '').trim()
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (!cat) {
    return NextResponse.json({ error: `Неизвестная модель: ${name}` }, { status: 400 })
  }

  if (active.has(name)) {
    return NextResponse.json({ ok: true, already: true })
  }

  if (isAlreadyDownloaded(name)) {
    return NextResponse.json({ ok: true, already: true, downloaded: true })
  }

  const dir = destDir()
  const dest = join(dir, cat.file)

  // Stop STT service if running (it may hold the model file open)
  if (sttStatus().running) {
    try { await stopStt() } catch { /* ignore */ }
  }

  const controller = new AbortController()
  const state: DownloadState = {
    name,
    file: cat.file,
    dest,
    downloaded: 0,
    total: 0,
    done: false,
    error: null,
    cancelled: false,
    controller,
  }
  active.set(name, state)

  // Start download in background (fire-and-forget)
  void doDownload(state)

  return NextResponse.json({ ok: true, started: true, name })
}

/* ─── DELETE /api/stt/models/download?name=small ─── */
export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const name = (url.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const st = active.get(name)
  if (!st) return NextResponse.json({ ok: false, error: 'Нет активного скачивания' }, { status: 404 })

  st.cancelled = true
  st.controller.abort()

  return NextResponse.json({ ok: true, cancelled: true })
}

/* ─── Internal: stream download ─── */
async function doDownload(state: DownloadState) {
  const tmpDest = state.dest + '.part'
  try {
    const res = await fetch(`${HF_BASE}/${state.file}`, {
      signal: state.controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'MiniMaxH3Studio/1.0' },
    })
    if (!res.ok) {
      state.error = `HuggingFace ${res.status} ${res.statusText}`
      return
    }

    const contentLength = res.headers.get('content-length')
    if (contentLength) state.total = parseInt(contentLength, 10)

    if (!res.body) {
      state.error = 'Ответ без body (неподдерживаемый окружение)'
      return
    }

    const reader = res.body.getReader()
    const out = createWriteStream(tmpDest, { flags: 'w' })
    const buf = Buffer.alloc(1024 * 1024) // 1 MB chunks

    let received = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (state.cancelled) break

      if (value) {
        const b = Buffer.from(value)
        out.write(b)
        received += b.length
        state.downloaded = received
      }
    }
    out.end()
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve)
      out.on('error', reject)
    })

    if (state.cancelled) {
      // Clean up partial file
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
      return
    }

    // Rename .part → final
    const fs = await import('fs')
    fs.renameSync(tmpDest, state.dest)
    state.done = true
    state.downloaded = received
  } catch (err) {
    if (state.cancelled) {
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
    } else {
      state.error = err instanceof Error ? err.message : String(err)
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
    }
  } finally {
    // Keep state in map for progress queries; clean up after a delay
    setTimeout(() => {
      if (state.done || state.cancelled || state.error) {
        active.delete(state.name)
      }
    }, 60_000) // keep available for 60s after completion
  }
}
