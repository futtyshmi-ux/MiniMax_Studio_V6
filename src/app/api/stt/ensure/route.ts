import { NextResponse } from 'next/server'
import { ensureStt } from '@/lib/stt-runner'

/**
 * (правка 65) POST /api/stt/ensure
 * Запустить STT-сервис (transcribe.dll, CPU) с параметрами из конфига.
 */
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const res = await ensureStt()
    return NextResponse.json(
      res.ok ? { ok: true } : { ok: false, error: res.error ?? 'STT-сервер не запустился' },
      { status: res.ok ? 200 : 500 },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
