/**
 * Метаданные результатов апскейла (правка 94).
 *
 * Видео, созданные DLSS-мостом (нейрорендеринг «…_DLSS5_…») и настоящим
 * апскейлом (RTX Video SDK «…_RTXVIDEO_…»), падают в общий output ComfyUI
 * напрямую из bridge — сайдкар .meta.json для них никто не пишет, поэтому
 * в галерее у них нет «инфо о файле» (диалог метаданных пуст).
 *
 * Здесь: ffprobe (тот же бинарник, что и для превью) достаёт разрешение,
 * длительность, fps и размер — и пишет плоский сайдкар рядом с файлом,
 * в той же схеме, что читает MetaDialog.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'

const execFileAsync = promisify(execFile)

/** Определить «инструмент» по имени файла (маркеры те же, что в галерее). */
export function upscaleToolFor(filename: string): string {
  if (/_RTXVIDEO(?:_PREVIEW)?_\d{8}-\d{6}/i.test(filename)) {
    return 'RTX Video Super Resolution (апскейл)'
  }
  if (/_DLSS5_\d{8}-\d{6}/i.test(filename)) {
    return 'DLSS 5 Visual Enhancer (нейрорендеринг)'
  }
  return 'Upscale (DLSS-мост)'
}

/* ── ffprobe: тот же порядок поиска, что у ffmpeg в thumb.ts ── */

let ffprobeBin: string | null = null

function resolveFfprobeSync(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const runtimeDir = path.join(process.cwd(), 'runtime', 'ffmpeg')
  const candidates = [
    process.env.FFPROBE_PATH,
    path.join(runtimeDir, `ffprobe${ext}`),
    'ffprobe',
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    if (existsSync(bin) || !bin.includes(path.sep)) return bin
  }
  return ''
}

async function resolveFfprobe(): Promise<string> {
  if (ffprobeBin !== null) return ffprobeBin
  const bin = resolveFfprobeSync()
  if (!bin) {
    ffprobeBin = ''
    return ''
  }
  try {
    await execFileAsync(bin, ['-version'], { timeout: 10_000 })
    ffprobeBin = bin
    return bin
  } catch {
    ffprobeBin = ''
    return ''
  }
}

interface ProbeResult {
  width?: number
  height?: number
  fps?: number
  duration?: number
}

async function probeVideo(file: string): Promise<ProbeResult> {
  const bin = await resolveFfprobe()
  if (!bin) return {}
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate',
        '-show_entries', 'format=duration',
        '-of', 'json',
        file,
      ],
      { timeout: 15_000 },
    )
    const j = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string }>
      format?: { duration?: string }
    }
    const s = j.streams?.[0]
    const out: ProbeResult = {}
    if (s?.width && s?.height) {
      out.width = s.width
      out.height = s.height
    }
    if (s?.avg_frame_rate && s.avg_frame_rate.includes('/')) {
      const [num, den] = s.avg_frame_rate.split('/').map(Number)
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
        out.fps = Math.round((num / den) * 100) / 100
      }
    }
    const dur = Number(j.format?.duration)
    if (Number.isFinite(dur) && dur > 0) out.duration = Math.round(dur * 100) / 100
    return out
  } catch {
    return {}
  }
}

/**
 * Написать .meta.json для результата апскейла, если его ещё нет.
 * Идемпотентно: bridge может отдавать 'done' несколько поллов подряд.
 * Возвращает true, если сайдкар записан (или уже существовал).
 */
export async function ensureUpscaleMeta(
  outputPath: string,
  jobId: string,
  sourceHint?: unknown,
): Promise<boolean> {
  try {
    const OUTPUT_DIR = path.resolve(getAppConfig().outputDir)
    const file = path.resolve(outputPath)
    if (!file.startsWith(OUTPUT_DIR + path.sep)) return false // чужой путь
    if (!existsSync(file)) return false

    const metaFile = file + '.meta.json'
    if (existsSync(metaFile)) return true

    const name = path.basename(file)
    let size = 0
    let mtime = 0
    try {
      const st = statSync(file)
      size = st.size
      mtime = Math.floor(st.mtimeMs / 1000)
    } catch { /* ignore */ }

    const probe = await probeVideo(file)

    // Исходник: bridge кладёт в output разные поля — берём любое строковое
    // поле с путём, кроме самого результата (best effort).
    let sourceFile: string | null = null
    if (typeof sourceHint === 'string' && sourceHint && sourceHint !== outputPath) {
      sourceFile = path.basename(sourceHint)
    }

    const meta: Record<string, unknown> = {
      job_id: jobId,
      tool: upscaleToolFor(name),
      created_at: mtime || Math.floor(Date.now() / 1000),
      file_size: size,
    }
    if (probe.width && probe.height) meta.resolution = `${probe.width}x${probe.height}`
    if (probe.duration !== undefined) meta.duration_seconds = probe.duration
    if (probe.fps !== undefined) meta.fps = probe.fps
    if (sourceFile) meta.source_file = sourceFile

    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}
