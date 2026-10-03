/**
 * Server-side metadata writer (правка 21).
 *
 * Previously .meta.json sidecars were written ONLY by the browser after it
 * saw the job finish — closing the tab/window while the ComfyUI queue kept
 * generating produced videos without metadata. Now:
 *
 *   1. /api/comfy/generate  → recordPendingMeta(promptId, params)
 *      (server persists the job params immediately at submit time)
 *   2. /api/comfy/status    → markPendingRunning(promptId) on 'running',
 *                             finalizePendingMeta(promptId, outputs) on 'done'
 *                             (writes the sidecar even with no browser alive)
 *   3. /api/comfy/metadata  → client fast path: writeMetaSidecar() +
 *      clearPendingMeta() so the server copy never overwrites fresher data.
 *
 * Pending entries live in `<outputDir>/.pending-meta.json` (a dotfile — the
 * files listing skips dotfiles) and are pruned after 24h.
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { computeFinalDimensions, finalDimsFromMegapixels, framesForDuration, clampLowResMP, type MiniMaxH3Params } from '@/lib/comfy/minimax-h3-template'

/* ──────────────────── shared helpers ──────────────────── */

/** (правки 121, 124) Итоговые размеры видео ПОСЛЕ точного кропа — ТО же
 *  формула, что в шаблоне (buildMiniMaxH3Workflow): пресет → номинал
 *  (computeFinalDimensions), свободное разрешение → finalDimsFromMegapixels.
 *  lowResMP на итог больше не влияет: апскейлер — «target dimensions». */
export function computeOutputDimensions(
  aspectRatio: string,
  megapixels: number,
  targetDimensions?: { width: number; height: number },
): { w: number; h: number } {
  const d = targetDimensions
    ? computeFinalDimensions(targetDimensions.width, targetDimensions.height)
    : finalDimsFromMegapixels(aspectRatio, megapixels)
  return { w: d.outW, h: d.outH }
}

/** Write a .meta.json sidecar next to the output file + clean VHS
 *  byproducts (silent video / first-frame png). Returns the path or null. */
export function writeMetaSidecar(
  filename: string,
  subfolder: string,
  params: Record<string, unknown>,
): string | null {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !filename) return null

  const safeName = path.basename(filename)
  const safeSub = subfolder ? path.basename(subfolder) : ''
  const dir = path.resolve(path.join(OUTPUT_DIR, safeSub))
  if (!dir.startsWith(OUTPUT_DIR)) return null

  const metaFile = path.join(dir, safeName + '.meta.json')
  fs.mkdirSync(dir, { recursive: true })
  const metadata = {
    ...params,
    created_at: Date.now() / 1000,
    job_id: (params.job_id as string) || `srv_${Date.now().toString(36)}`,
  }
  fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2), 'utf-8')

  // VHS byproduct cleanup (same logic the client-facing route had).
  // Удаляем «сиблинга» ТОЛЬКО если он создан ПОЗЖЕ начала этой же задачи:
  // без фильтра по mtime файл пользователя foo-audio.mp4 из совсем другой
  // генерации мог стереть его легитимный foo.mp4.
  const audioMatch = safeName.match(/^(.*)-audio\.[^.]+$/i)
  if (audioMatch) {
    const jobStartMs = typeof params.started_at === 'number' ? params.started_at : 0
    const base = audioMatch[1]
    const ext = path.extname(safeName).toLowerCase()
    const unwanted = [path.join(dir, base + ext), path.join(dir, base + '.png')]
    for (const f of unwanted) {
      try {
        const st = fs.statSync(f)
        // «Сиблинг» той же задачи: изменён после её старта и не старше
        // самого аудиофайла (иначе это более поздний чужой файл).
        if (st.mtimeMs >= jobStartMs) fs.unlinkSync(f)
      } catch { /* нет файла — ок */ }
    }
  }
  return metaFile
}

/* ──────────────────── pending-meta store ──────────────────── */

interface PendingEntry {
  params: Record<string, unknown>
  started_at: number
  /** Set on the first status poll that saw the prompt executing. */
  running_since?: number
  /** Set when a status poll saw the prompt QUEUED behind other jobs.
   *  Mirrors the client's `sawQueued` (use-video-gen.ts): a job that waited
   *  in the queue counts from its execution start, a job that went straight
   *  to execution counts from submission — otherwise the sidecar's
   *  generation_time diverges from the gallery badge. */
  saw_queued?: boolean
}

const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

function pendingFile(): string | null {
  const dir = getAppConfig().outputDir
  return dir ? path.join(dir, '.pending-meta.json') : null
}

function loadPending(): Record<string, PendingEntry> {
  const file = pendingFile()
  if (!file || !fs.existsSync(file)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, PendingEntry>
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const fresh: Record<string, PendingEntry> = {}
    for (const [pid, e] of Object.entries(parsed)) {
      if (e && typeof e.started_at === 'number' && now - e.started_at < PENDING_MAX_AGE_MS) {
        fresh[pid] = e
      }
    }
    return fresh
  } catch {
    return {}
  }
}

function savePending(map: Record<string, PendingEntry>) {
  const file = pendingFile()
  if (!file) return
  try {
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

/** Map a generate-request body to the canonical sidecar fields
 *  (same shape the browser writes — see use-video-gen genParamsMap). */
function bodyToMetaParams(body: MiniMaxH3Params): Record<string, unknown> {
  const fps = 24
  // (правка 138) дефолт 5 → 2.5: минимум 2.5 с
  const duration = body.duration ?? 2.5
  // Actual frame count the server produces (node 46:19), for metadata (правка 55).
  const videoLengthFrames = framesForDuration(duration, fps)
  const finalResolution = body.finalResolution ?? 0.7
  // (правки 121, 124) ТОЧНЫЕ финальные размеры: пресет → body.targetDimensions,
  // свободное разрешение → MP-путь (та же формула, что в шаблоне)
  const { w, h } = computeOutputDimensions(body.aspectRatio || '16:9', finalResolution, body.targetDimensions)
  const references: Array<{ type: string; path: string; role: string }> = [
    ...(body.refImages ?? []).map((p) => ({ type: 'image', path: p, role: '' })),
    ...(body.refVideos ?? []).map((r) => ({ type: 'video', path: r.path, role: '' })),
    ...(body.refAudios ?? []).map((p) => ({ type: 'audio', path: p, role: '' })),
  ]
  // (правка 157) Режимы + размеры первого кадра — для «Повторить»
  // (без first_frame_width/height ориентация из кадра не восстановится
  //  и flf-генерация снова даст не ту ориентацию).
  const genMode: 'ref' | 't2v' | 'flf' = body.mode === 't2v' || body.mode === 'flf' ? body.mode : 'ref'
  return {
    prompt: body.prompt,
    model_type: 'minimax_h3_ref2va',
    workflow: 'two-pass-latent-upscaler',
    seed: body.seed ?? -1,
    generation_mode: genMode,
    ...(genMode === 'flf' && {
      first_frame: body.firstFrame ?? null,
      last_frame: body.lastFrame ?? null,
      first_frame_width: body.firstFrameWidth ?? null,
      first_frame_height: body.firstFrameHeight ?? null,
    }),
    resolution: `${w}x${h}`,
    aspect_ratio: body.aspectRatio,
    final_resolution_mp: finalResolution,
    // Заклёмпленное значение — как в реальном workflow (clampLowResMP)
    low_res_mp: clampLowResMP(body.lowResMP ?? 0.2, finalResolution),
    video_length: videoLengthFrames,
    duration_seconds: videoLengthFrames / fps,
    fps,
    pass1_steps: body.firstSamplerSteps ?? 4,
    pass2_steps: { '3step': 3, '4step': 4, '5step': 5, '6step': 6, '7step': 7 }[body.sigmaVariant || '3step'] ?? 3,
    sigma_variant: body.sigmaVariant || '3step',
    pass2_sampler: body.pass2Sampler || 'euler', // (правка 69)
    pass1_sampler: body.pass1Sampler || 'euler', // (правка 70)
    pass1_scheduler: body.pass1Scheduler || 'simple', // (правка 70)
    turbo_lora_strength: typeof body.turboLoraStrength === 'number' ? body.turboLoraStrength : 1.0, // (правка 70)
    minimax_h3_reference_detail: body.refImageSize || 'match', // (правка 58)
    low_vram_attention: body.lowVramAttention !== false,
    chunk_feed_forward: body.chunkFeedForward !== false,
    ...(body.chunkFeedForward !== false
      ? {
          chunk_ff_chunks: body.chunkFFChunks ?? 2,
          chunk_ff_threshold: body.chunkFFThreshold ?? 4096,
        }
      : {}),
    lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    references,
  }
}

/** /api/comfy/generate: persist job params right after submission. */
export function recordPendingMeta(promptId: string, body: MiniMaxH3Params) {
  try {
    const map = loadPending()
    map[promptId] = { params: { ...bodyToMetaParams(body), job_id: promptId }, started_at: Date.now() }
    savePending(map)
  } catch { /* non-critical */ }
}

/** /api/comfy/status: the prompt was seen waiting in the queue. */
export function markPendingQueued(promptId: string) {
  try {
    const map = loadPending()
    const e = map[promptId]
    if (e && !e.saw_queued) {
      e.saw_queued = true
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** /api/comfy/status: first observation of the prompt actually executing. */
export function markPendingRunning(promptId: string) {
  try {
    const map = loadPending()
    const e = map[promptId]
    if (e && e.running_since === undefined) {
      e.running_since = Date.now()
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** /api/comfy/status on 'done': write the sidecar server-side.
 *  Skips when the browser already wrote it (client data wins) or when the
 *  pending entry is missing. Returns the written path or null.
 *  `execMs` — REAL execution time from ComfyUI WS events (preferred);
 *  falls back to the submit/running-anchor estimate when unavailable
 *  (e.g. the tracker restarted mid-job). */
export function finalizePendingMeta(
  promptId: string,
  outputs: Array<{ filename: string; subfolder?: string }>,
  execMs?: number | null,
): string | null {
  try {
    const map = loadPending()
    const entry = map[promptId]
    if (!entry) return null
    delete map[promptId]
    savePending(map)

    const primary =
      outputs.find((o) => o.filename?.match(/\.(mp4|webm|mov|m4v)$/i)) || outputs[0]
    if (!primary?.filename) return null

    // Generation time: prefer the REAL ComfyUI execution window (WS events);
    // fall back to the submit/running-anchor estimate (same rule as the
    // client badge: queued → from execution start, straight → from submit).
    const from = entry.saw_queued ? (entry.running_since ?? entry.started_at) : entry.started_at
    const durationMs = typeof execMs === 'number' && execMs > 0 ? execMs : Date.now() - from
    return writeMetaSidecar(primary.filename, primary.subfolder || '', {
      ...entry.params,
      generation_time: Math.max(1, Math.round(durationMs / 1000)),
    })
  } catch {
    return null
  }
}

/** Drop a pending entry (client already wrote the sidecar / job errored). */
export function clearPendingMeta(promptId: string) {
  try {
    const map = loadPending()
    if (promptId in map) {
      delete map[promptId]
      savePending(map)
    }
  } catch { /* non-critical */ }
}
