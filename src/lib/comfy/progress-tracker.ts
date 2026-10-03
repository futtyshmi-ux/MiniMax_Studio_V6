/**
 * ComfyUI progress tracker.
 * Maintains a WebSocket connection to ComfyUI and stores:
 *   - Latest progress per prompt_id
 *   - Latest preview image (base64) per prompt_id
 *
 * IMPORTANT: Uses the SAME clientId as the prompt submission so that
 * ComfyUI ModelPreviewOverrideKJ events are delivered to us.
 */
import WebSocket from 'ws'
import { onQueueDrained } from '@/lib/vram-arbiter'

const COMFY_BASE_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const COMFY_WS_URL = COMFY_BASE_URL.replace(/^http/, 'ws') + '/ws'

/** Single shared client_id used for BOTH prompt submission and WebSocket. */
const CLIENT_ID = `cb_session_${Date.now().toString(36)}`

export function getClientId(): string {
  return CLIENT_ID
}

interface NodeProgress {
  value: number
  max: number
}

/**
 * Per-prompt progress. The H3 workflow has TWO sampler passes (Pass 1 low-res,
 * Pass 2 high-res); each emits its own `progress` WS events, so a flat value/max
 * would bounce 0→100→0→100. We track each progress-emitting node separately and
 * expose an overall fraction that goes 0→100 once across all passes.
 */
interface ProgressEntry {
  /** progress-emitting nodes observed for this prompt, in order. */
  nodes: string[]
  byNode: Record<string, NodeProgress>
  /** True when `executing` reported node===null (prompt finished). */
  done: boolean
  /**
   * STICKY (правка 50): becomes true the moment ANY pass-2 node is observed
   * (progress event, executing event, or KJ preview node_id '13') and never
   * reverts. The workflow runs pass 1 → pass 2 strictly once, so the stage
   * must be monotonic. The old logic derived the stage from the most recent
   * event's node, so a pass-2 KJ preview event (pseudo-node 'preview',
   * statically stage 1) flipped the stage back to 1 every step — the overall
   * bar snapped to 50% (pass-1 fraction 1.0 → (0+1)/2) on every step.
   */
  stage2Seen: boolean
  /**
   * Which pass the shared 'preview' pseudo-node (KJ step/total) currently
   * reflects; set from the node_id of the kj_preview_override event, so stage
   * fractions never mix stale values from the other pass into the bar.
   */
  previewStage: 1 | 2
}

interface PreviewEntry {
  image: string // base64 data
  mime: string // 'image/jpeg' | 'image/webp' | 'video/mp4' | 'image/png'
  width: number
  height: number
  step: number
  total: number
  timestamp: number
}

const progressMap = new Map<string, ProgressEntry>()
const previewMap = new Map<string, PreviewEntry>()

/**
 * Real execution window per prompt (ms), measured directly from ComfyUI
 * `executing` WS events: first node start → node===null (finished).
 * This is the ACTUAL generation time — independent of poll intervals and
 * submission overhead — and the single source of truth for both the gallery
 * badge and the .meta.json sidecar.
 */
const execWindows = new Map<string, { start: number; end: number | null }>()

/** Get the real execution duration in ms, or null if not (yet) measured. */
export function getExecutionDurationMs(promptId: string): number | null {
  const w = execWindows.get(promptId)
  if (!w || w.end === null) return null
  return Math.max(0, w.end - w.start)
}

let ws: WebSocket | null = null
let connecting = false
let activePromptId: string | null = null
/** The prompt_id currently executing (from 'executing' WS event). */
let executingPromptId: string | null = null
/** Предыдущее значение queue_remaining из status-событий ComfyUI. */
let lastQueueRemaining = 0

/** Set the active prompt_id (called when we submit a job). */
export function setActivePrompt(id: string) {
  activePromptId = id
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (connecting) return
  connecting = true

  try {
    // Use clientId query param so ComfyUI routes events to this session
    ws = new WebSocket(`${COMFY_WS_URL}?clientId=${CLIENT_ID}`)

    ws.on('open', () => {
      connecting = false
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())

        // Опустошение очереди → фоновая выгрузка моделей MiniMax из VRAM
        // (vram-arbiter: GPU освобождается сразу после завершения генераций)
        if (msg.type === 'status') {
          const remaining = msg.data?.status?.exec_info?.queue_remaining
          if (typeof remaining === 'number') {
            if (remaining === 0 && lastQueueRemaining > 0) {
              void onQueueDrained()
            }
            lastQueueRemaining = remaining
          }
        }

        // Standard progress events (one per sampler node/pass)
        if (msg.type === 'progress' && msg.data?.prompt_id) {
          const pid = msg.data.prompt_id
          const node = typeof msg.data.node === 'string' ? msg.data.node : 'sampler'
          let entry = progressMap.get(pid)
          if (!entry) {
            entry = { nodes: [], byNode: {}, done: false, stage2Seen: false, previewStage: 1 }
            progressMap.set(pid, entry)
          }
          if (!entry.byNode[node]) {
            entry.byNode[node] = { value: 0, max: 1 }
          }
          entry.byNode[node].value = msg.data.value
          entry.byNode[node].max = msg.data.max || 1
          if (!entry.nodes.includes(node)) {
            entry.nodes.push(node)
          }
          // Правка 50: sticky stage — pass-2 evidence never reverts to pass 1
          if (STAGE2_NODES.has(node)) entry.stage2Seen = true
        }

        // Standard preview events (from KSampler etc.)
        if (msg.type === 'preview' && msg.data?.prompt_id && msg.data?.image) {
          previewMap.set(msg.data.prompt_id, {
            image: msg.data.image,
            mime: `image/${msg.data.image_type || 'png'}`,
            width: msg.data.width || 0,
            height: msg.data.height || 0,
            step: 0,
            total: 0,
            timestamp: Date.now(),
          })
          trimPreviewMap()
        }

        // KJNodes ModelPreviewOverride events (custom type)
        if (msg.type === 'kj_preview_override' && msg.data?.image) {
          // Use the currently-executing prompt (most accurate for queue scenarios)
          const pid = executingPromptId || activePromptId || msg.data.node_id || 'unknown'
          previewMap.set(pid, {
            image: msg.data.image,
            mime: msg.data.mime || 'image/jpeg',
            width: msg.data.w || 0,
            height: msg.data.h || 0,
            step: msg.data.step || 0,
            total: msg.data.total || 0,
            timestamp: Date.now(),
          })
          // Also update progress from step/total
          if (msg.data.total > 0) {
            let entry = progressMap.get(pid)
            if (!entry) {
              entry = { nodes: [], byNode: {}, done: false, stage2Seen: false, previewStage: 1 }
              progressMap.set(pid, entry)
            }
            const node = 'preview'
            if (!entry.byNode[node]) entry.byNode[node] = { value: 0, max: 1 }
            entry.byNode[node].value = msg.data.step || 0
            entry.byNode[node].max = msg.data.total
            if (!entry.nodes.includes(node)) entry.nodes.push(node)
            // Правка 50: the KJ event knows its own node_id ('12' pass 1 /
            // '13' pass 2) — tag the shared pseudo-node with that pass and
            // latch the sticky stage from real pass-2 evidence.
            const kjNode = typeof msg.data.node_id === 'string' ? msg.data.node_id : ''
            entry.previewStage = STAGE2_NODES.has(kjNode) ? 2 : 1
            if (STAGE2_NODES.has(kjNode)) entry.stage2Seen = true
          }
          trimPreviewMap()
        }

        // Execution events
        if (msg.type === 'executing' && msg.data?.prompt_id) {
          // Real execution window: first node start → finished marker
          const pid = msg.data.prompt_id
          if (typeof msg.data.node === 'string') {
            let w = execWindows.get(pid)
            if (!w) {
              w = { start: Date.now(), end: null }
              execWindows.set(pid, w)
            }
            if (execWindows.size > 100) {
              const keys = Array.from(execWindows.keys())
              for (let i = 0; i < keys.length - 100; i++) execWindows.delete(keys[i])
            }
          } else if (msg.data.node === null) {
            const w = execWindows.get(pid)
            if (w && w.end === null) w.end = Date.now()
          }

          if (msg.data.node === null) {
            const entry = progressMap.get(msg.data.prompt_id)
            if (entry) entry.done = true
            // Clear preview when done
            previewMap.delete(msg.data.prompt_id)
            // Clear executing prompt if it was this one
            if (executingPromptId === msg.data.prompt_id) {
              executingPromptId = null
            }
          } else if (typeof msg.data.node === 'string') {
            const entry = progressMap.get(msg.data.prompt_id)
            if (entry && STAGE2_NODES.has(msg.data.node)) entry.stage2Seen = true
            // Track which prompt is currently executing
            executingPromptId = msg.data.prompt_id
          }
        }

        // Error events
        if (msg.type === 'execution_error' && msg.data?.prompt_id) {
          progressMap.delete(msg.data.prompt_id)
          previewMap.delete(msg.data.prompt_id)
        }

        // Cleanup progress: keep max 100 entries
        if (progressMap.size > 100) {
          const keys = Array.from(progressMap.keys())
          for (let i = 0; i < keys.length - 100; i++) {
            progressMap.delete(keys[i])
          }
        }
      } catch { /* ignore parse errors */ }
    })

    ws.on('close', () => {
      ws = null
      connecting = false
      setTimeout(connect, 3000)
    })

    ws.on('error', () => {
      ws = null
      connecting = false
      // Обычно после 'error' следует 'close' с реконнектом, но это не
      // гарантировано — страхуемся собственным таймером (безопасно: connect
      // сам идемпотентен через connecting-флаг).
      setTimeout(connect, 3000)
    })
  } catch {
    ws = null
    connecting = false
    setTimeout(connect, 5000)
  }
}

function trimPreviewMap() {
  if (previewMap.size > 10) {
    const keys = Array.from(previewMap.keys())
    previewMap.delete(keys[0])
  }
}

/* ─── Fixed two-stage progress (workflow is known: Pass 1 low-res, Pass 2 high-res) ───
 *
 * Dividing by the number of OBSERVED progress nodes makes the bar bounce:
 * while only pass-1 nodes exist the divisor is 1 (bar hits 100%), then the
 * pass-2 node appears and the divisor becomes 2 (bar drops to 50%). Instead,
 * the workflow always has exactly TWO stages, and every progress-emitting
 * node id is mapped to its stage up front. */
const TOTAL_STAGES = 2

/** Pass 1: SamplerCustomAdvanced '46:21', KJ preview override '12'. */
const STAGE1_NODES = new Set(['46:21', '12'])
/** Pass 2: SamplerCustomAdvanced '46:16', KJ preview override '13'. */
const STAGE2_NODES = new Set(['46:16', '13'])
/** Pseudo-node carrying KJ preview step/total for whichever pass is active. */
const PREVIEW_PSEUDO = 'preview'

function stageOf(node: string): 1 | 2 | null {
  if (STAGE2_NODES.has(node)) return 2
  if (STAGE1_NODES.has(node)) return 1
  return null
}

/** Stage of a node; the shared 'preview' pseudo-node follows the pass that
 *  last wrote it (правка 50), so its step/total never leaks into the wrong
 *  stage fraction. */
function stageOfTracked(entry: ProgressEntry, node: string): 1 | 2 | null {
  if (node === PREVIEW_PSEUDO) return entry.previewStage
  return stageOf(node)
}

/**
 * The stage currently executing. STICKY (правка 50): once pass 2 has any
 * evidence it stays 2 — the workflow never goes back from pass 2 to pass 1.
 */
function currentStage(entry: ProgressEntry): 1 | 2 {
  return entry.stage2Seen ? 2 : 1
}

/** Clamp helper. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

/** Lazy-init: start the WebSocket connection on first access. */
let initialized = false
function ensureConnected() {
  if (!initialized) {
    initialized = true
    connect()
  }
}

/**
 * Compute the overall progress fraction (0..1) across BOTH passes:
 *   overall = ((stage − 1) + stageFraction) / 2
 * The bar now goes 0→100 exactly once: 0–50% is pass 1, 50–100% is pass 2.
 * Returns null if the prompt is unknown.
 */
export function getOverallProgress(promptId: string): number | null {
  ensureConnected()
  const entry = progressMap.get(promptId)
  if (!entry || entry.nodes.length === 0) return null
  if (entry.done) return 1

  const stage = currentStage(entry)
  // Best fraction within the current stage (several nodes may report —
  // e.g. the sampler and the KJ preview override; take the furthest one).
  let stageFrac = 0
  for (const n of entry.nodes) {
    if (stageOfTracked(entry, n) !== stage) continue
    const np = entry.byNode[n]
    if (np && np.max > 0) {
      stageFrac = Math.max(stageFrac, clamp01((np.value || 0) / np.max))
    }
  }
  return clamp01(((stage - 1) + stageFrac) / TOTAL_STAGES)
}

/**
 * Stage readout for the live-preview overlay: which of the two passes is
 * running and its step/total (the largest reporting node of that stage).
 */
export function getStageInfo(
  promptId: string,
): { stage: number; totalStages: number; step: number; total: number } | null {
  ensureConnected()
  const entry = progressMap.get(promptId)
  if (!entry) return null
  const stage = currentStage(entry)
  let step = 0
  let total = 0
  for (const n of entry.nodes) {
    if (stageOfTracked(entry, n) !== stage) continue
    const np = entry.byNode[n]
    if (np && np.max > total) {
      total = np.max
      step = Math.min(np.value || 0, np.max)
    }
  }
  return { stage, totalStages: TOTAL_STAGES, step, total }
}

/** Get progress for a prompt_id. Returns null if unknown. */
export function getProgress(promptId: string): ProgressEntry | null {
  ensureConnected()
  return progressMap.get(promptId) ?? null
}

/** Get the latest preview image for a prompt_id. Returns null if none. */
export function getPreview(promptId: string): PreviewEntry | null {
  ensureConnected()
  return previewMap.get(promptId) ?? null
}