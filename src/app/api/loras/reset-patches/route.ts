import { NextResponse } from 'next/server'

const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')

/**
 * POST /api/loras/reset-patches
 * Unloads all models with LoRA patches from ComfyUI cache.
 * This forces a clean reload of the base model on next generation.
 */
export async function POST() {
  try {
    // Step 1: Free VRAM (unload models)
    const res = await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    })
    
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json(
        { error: `ComfyUI /free failed (${res.status}): ${text.slice(0, 200)}` },
        { status: 502 }
      )
    }
    
    return NextResponse.json({ 
      ok: true, 
      message: 'LoRA patches cleared. Next generation will reload base model.' 
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Не удалось сбросить патчи LoRA: ${msg}` },
      { status: 502 }
    )
  }
}
