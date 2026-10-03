import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/**
 * POST /api/comfy/copy-to-input
 * Body: { sourceFilename: string, sourceSubfolder?: string }
 *
 * Copies a file from ComfyUI's output directory into its input directory,
 * making it available as a LoadImage source in workflows.
 */
export async function POST(req: NextRequest) {
  const { outputDir: OUTPUT_DIR, inputDir: INPUT_DIR } = getAppConfig()
  try {
    const body = await req.json()
    const { sourceFilename, sourceSubfolder } = body as {
      sourceFilename: string
      sourceSubfolder?: string
    }

    if (!sourceFilename) {
      return NextResponse.json({ error: 'sourceFilename is required' }, { status: 400 })
    }

    // Build the source path (output dir + optional subfolder).
    // path.basename: подпапки галереи легально содержат кириллицу — старая
    // зачистка [^a-zA-Z0-9_-] превращала «Проект» в '' и искала файл в корне
    // output (404 или, хуже, копирование ЧУЖОГО одноимённого файла).
    // Одноsegment-проверка отсекает traversal.
    const subRaw = (sourceSubfolder || '').split(/[\\/]/).filter(Boolean)
    if (subRaw.length > 1) {
      return NextResponse.json({ error: 'Invalid subfolder' }, { status: 400 })
    }
    const sub = subRaw[0] ?? ''
    const safeName = path.basename(sourceFilename) // prevent path traversal
    const sourcePath = path.join(OUTPUT_DIR, sub, safeName)

    // Verify source exists
    let stat
    try {
      stat = await fs.stat(sourcePath)
    } catch {
      return NextResponse.json(
        { error: `Source file not found: ${sourceFilename}` },
        { status: 404 }
      )
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Source is not a file' }, { status: 400 })
    }

    // Ensure input dir exists
    await fs.mkdir(INPUT_DIR, { recursive: true })

    // Copy WITHOUT silent overwrite: одноимённый файл в input/ мог быть
    // чужим референсом — добавляем числовой суффикс при коллизии (ComfyUI
    // /upload/image делает так же).
    let destName = safeName
    let destPath = path.join(INPUT_DIR, destName)
    let n = 1
    while (true) {
      try {
        // O_EXCL-семантика через fs.open: падает, если файл уже существует
        const fh = await fs.open(destPath, 'wx')
        await fh.close()
        await fs.unlink(destPath) // освобождаем имя под copyFile
        break
      } catch {
        const ext = path.extname(safeName)
        const stem = safeName.slice(0, safeName.length - ext.length)
        destName = `${stem}_${n++}${ext}`
        destPath = path.join(INPUT_DIR, destName)
        if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
      }
    }
    await fs.copyFile(sourcePath, destPath)

    return NextResponse.json({ name: destName })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
