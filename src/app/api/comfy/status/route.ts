import { NextRequest, NextResponse } from 'next/server'
import { getStatusWithRetry } from '@/lib/comfy/minimax-h3-client'
import { getExecutionDurationMs } from '@/lib/comfy/progress-tracker'
import { markPendingRunning, markPendingQueued, finalizePendingMeta, clearPendingMeta } from '@/lib/pending-meta'

/**
 * GET /api/comfy/status?prompt_id=...
 * Also drives the server-side metadata writer: marks execution start and
 * finalizes the .meta.json sidecar on completion — works even when no
 * browser tab is alive (the ComfyUI queue keeps generating without it).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const promptId = searchParams.get('prompt_id')
  if (!promptId) {
    return NextResponse.json({ error: 'prompt_id required' }, { status: 400 })
  }
  try {
    // (фикс) Используем getStatusWithRetry — автоматические ретраи при
    // сетевых сбоях (WinError 10054). Раньше один обрыв TCP = ошибка.
    const result = await getStatusWithRetry(promptId)
    // Real execution time (from ComfyUI WS events) — single source of truth
    // for the gallery badge AND the .meta.json sidecar.
    if (result.status === 'done') {
      const execMs = getExecutionDurationMs(promptId)
      if (execMs !== null) {
        ;(result as { execution_ms?: number }).execution_ms = execMs
      }
    }
    // Server-side sidecar bookkeeping (never fails the status response)
    try {
      if (result.status === 'running') {
        markPendingRunning(promptId)
      } else if (result.status === 'queued') {
        markPendingQueued(promptId)
      } else if (result.status === 'done') {
        finalizePendingMeta(promptId, result.outputs ?? [], getExecutionDurationMs(promptId))
      } else if (result.status === 'error') {
        clearPendingMeta(promptId)
      }
      // 'unknown' (ComfyUI недоступен) — pending-meta не трогаем
    } catch { /* non-critical */ }
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ status: 'error', detail: msg }, { status: 502 })
  }
}
