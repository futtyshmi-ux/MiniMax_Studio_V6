import { NextRequest, NextResponse } from 'next/server'
import { existsSync, statSync } from 'fs'
import path from 'path'

/**
 * GET /api/config/check?dir=...
 * Validates a candidate backend folder: it should be the root of a
 * portable ComfyUI-Easy-Install (contain ComfyUI/ and python_embeded/).
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const dir = (new URL(req.url).searchParams.get('dir') || '').trim()
  if (!dir) {
    return NextResponse.json({ error: 'dir is required' }, { status: 400 })
  }
  const root = path.resolve(dir)
  let exists = false
  try {
    exists = statSync(root).isDirectory()
  } catch {
    exists = false
  }
  return NextResponse.json({
    dir: root,
    exists,
    has_comfy: existsSync(path.join(root, 'ComfyUI')),
    has_python: existsSync(path.join(root, 'python_embeded', 'python.exe')),
  })
}
