import { NextResponse } from 'next/server'
import { forceReleaseAssistantLock } from '@/lib/vram-arbiter'

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/release — (правка 110) принудительное снятие блокировки
 * ассистента (зависший streaming-счётчик). Вызывается UI-fallback'ом, когда
 * кнопка «Сгенерировать» держится заблокированной больше 60 с, хотя активного
 * стрима на клиенте уже нет. Свежий замок (стрим реально идёт) НЕ снимает:
 * forceReleaseAssistantLock проверяет возраст блокировки.
 */
export async function POST() {
  const released = forceReleaseAssistantLock(60_000)
  return NextResponse.json({ ok: true, released })
}
