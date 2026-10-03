import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/**
 * POST /api/comfy/delete
 * Body: { filename: string, subfolder?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const filename = body.filename as string
    const OUTPUT_DIR = getAppConfig().outputDir
    if (!filename) {
      return NextResponse.json({ error: 'filename required' }, { status: 400 })
    }

    // Sanitize: prevent path traversal
    const safeName = path.basename(filename)
    const subfolder = body.subfolder ? path.basename(body.subfolder) : ''
    const target = path.resolve(path.join(OUTPUT_DIR, subfolder, safeName))

    // Ensure target is within OUTPUT_DIR
    if (!target.startsWith(OUTPUT_DIR + path.sep) && target !== path.join(OUTPUT_DIR, safeName)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    await fs.unlink(target)
    // Also delete .meta.json sidecar if present
    await fs.unlink(target + '.meta.json').catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
