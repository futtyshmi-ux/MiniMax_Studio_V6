import { NextResponse } from 'next/server'
import { LLM_PORT, llmStatus } from '@/lib/llm-runner'

export const dynamic = 'force-dynamic'

/** POST /api/llm/abort — stop the current LLM generation (best effort). */
export async function POST() {
  try {
    await fetch(`http://127.0.0.1:${LLM_PORT}/abort`, { method: 'POST' }).catch(() => {})
  } catch {
    /* runner not up — nothing to abort */
  }
  return NextResponse.json({ ok: true, ...llmStatus() })
}
