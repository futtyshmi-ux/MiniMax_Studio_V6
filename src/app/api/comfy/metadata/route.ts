import { NextRequest, NextResponse } from 'next/server'
import { writeMetaSidecar, clearPendingMeta } from '@/lib/pending-meta'

/**
 * POST /api/comfy/metadata
 * Body: { filename, subfolder, params: {...} }
 * Client fast path: saves a .meta.json sidecar next to the output file.
 * The server-side pending copy is cleared for this job so it never
 * overwrites the fresher client data.
 */
export const dynamic = 'force-dynamic'

interface MetadataBody {
  filename: string
  subfolder?: string
  params: Record<string, unknown>
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as MetadataBody

    if (!body.filename || !body.params) {
      return NextResponse.json({ error: 'filename and params are required' }, { status: 400 })
    }

    const metaFile = writeMetaSidecar(body.filename, body.subfolder || '', body.params)
    if (!metaFile) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    // Drop the server-side pending copy (client data wins)
    if (typeof body.params.job_id === 'string') {
      clearPendingMeta(body.params.job_id)
    }

    return NextResponse.json({ ok: true, path: metaFile })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save metadata' },
      { status: 500 },
    )
  }
}
