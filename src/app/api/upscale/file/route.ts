import { NextRequest } from 'next/server'
import path from 'path'
import { serveLocalFile } from '@/lib/local-file'
import { getAppConfig } from '@/lib/app-config'

/**
 * (правка 74) GET /api/upscale/file?path=<absolute path>
 * Стриминг результата (Range-поддержка, video seek). Пути ограничены
 * разрешёнными корнями: общая папка output ComfyUI (результаты с правки 74.2),
 * data/upscale-output (старые результаты), data/upscale-input, upscale/outputs.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get('path') ?? ''
  if (!raw) {
    return new Response('Missing path', { status: 400 })
  }
  const resolved = path.resolve(raw)
  const roots = [
    // (правка 74.2) основные результаты теперь пишутся в общую папку output
    path.resolve(getAppConfig().outputDir),
    path.resolve(process.cwd(), 'data', 'upscale-output'),
    path.resolve(process.cwd(), 'data', 'upscale-input'),
    path.resolve(process.cwd(), 'upscale', 'outputs'),
  ]
  const inside = roots.some((root) => {
    const rel = path.relative(root, resolved)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
  if (!inside) {
    return new Response('Forbidden path', { status: 403 })
  }
  const res = await serveLocalFile(req, path.basename(resolved), resolved)
  if (!res) {
    return new Response('Not found', { status: 404 })
  }
  return res
}
