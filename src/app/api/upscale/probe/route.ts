import { NextRequest, NextResponse } from 'next/server'
import { bridgeUrl, ensureUpscale } from '@/lib/upscale-runner'

/**
 * (правка 74) POST /api/upscale/probe
 * Body: {input: "<absolute path>"}
 * Метаданные медиа (разрешение, FPS, длительность, HDR, кодек) для карточки
 * загруженного файла. Запускает bridge при необходимости.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { input?: string } | null
    const input = body?.input
    if (!input) {
      return NextResponse.json({ error: 'Не указан файл (input)' }, { status: 400 })
    }

    const start = await ensureUpscale()
    if (!start.ok) {
      return NextResponse.json({ ok: false, error: start.error ?? 'Upscale-сервис не запустился' }, { status: 500 })
    }
    const r = await fetch(bridgeUrl('/probe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await r.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
    if (!r.ok) {
      return NextResponse.json({ error: data.error ?? `probe → ${r.status}` }, { status: r.status >= 400 && r.status < 500 ? r.status : 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
