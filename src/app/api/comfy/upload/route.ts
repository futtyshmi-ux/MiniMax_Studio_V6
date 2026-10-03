import { NextRequest, NextResponse } from 'next/server'
import { uploadImage } from '@/lib/comfy/minimax-h3-client'
import { stageFile } from '@/lib/staging'

/**
 * POST /api/comfy/upload
 * Body: FormData with 'image' field
 *
 * Uploads the file to ComfyUI's input/ directory. When ComfyUI is not
 * reachable, the file is staged locally (.local-input/) and transferred
 * to ComfyUI automatically at generation time — the response carries
 * `staged: true` so the UI can inform the user.
 */
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get('image')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    const buf = Buffer.from(await file.arrayBuffer())
    try {
      const name = await uploadImage(buf, file.name)
      return NextResponse.json({ name })
    } catch (comfyErr) {
      // ComfyUI unreachable — stage locally instead of failing hard
      try {
        const name = await stageFile(buf, file.name)
        return NextResponse.json({ name, staged: true })
      } catch {
        const msg = comfyErr instanceof Error ? comfyErr.message : String(comfyErr)
        return NextResponse.json({ error: msg }, { status: 500 })
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
