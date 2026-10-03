/**
 * ComfyUI client for MiniMax H3 video generation.
 *
 * Endpoints:
 *   POST /prompt          — submit workflow
 *   GET  /history/:id     — result
 *   GET  /queue           — current queue state
 *   POST /upload/image    — upload reference images
 *   GET  /view            — serve output files
 */

import { buildMiniMaxH3Workflow, type MiniMaxH3Params } from './minimax-h3-template'
import { getClientId } from './progress-tracker'

export const COMFY_URL =
  process.env.COMFY_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8188'

/**
 * (фикс Phase 6) Рутинные логи опроса статуса ([status] … RUNNING/QUEUED/…)
 * заспамили консоль start.bat — по строке на каждый тик поллинга (1/с на
 * задачу) и пугали пользователя. Теперь они видны ТОЛЬКО при запуске с
 * переменной окружения H3_DEBUG=1. Предупреждения об аномалиях (NOT FOUND,
 * ошибки выполнения) остаются в консоли всегда.
 */
const statusDbg = process.env.H3_DEBUG
  ? (...args: unknown[]) => console.log('[status]', ...args)
  : () => {}

export interface SubmitResult {
  prompt_id: string
  number?: number
}

export interface StatusResult {
  status: 'queued' | 'running' | 'done' | 'error' | 'unknown'
  progress?: number
  detail?: string
  /** Output files when done. */
  outputs?: Array<{ filename: string; subfolder: string; type: string }>
}

/**
 * Upload an image (or any reference file, e.g. a video) to ComfyUI's input
 * directory. Returns the filename. Large video references can take a while —
 * pass a longer timeout (or rely on the 5-minute default).
 */
export async function uploadImage(
  buffer: Buffer,
  filename: string,
  timeoutMs = 300_000,
): Promise<string> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(buffer)]), filename)
  form.append('subfolder', '')
  form.append('type', 'input')

  const res = await fetch(`${COMFY_URL}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.name as string
}

/** Submit a MiniMax H3 workflow. Returns prompt_id. */
export async function submitVideo(params: MiniMaxH3Params): Promise<SubmitResult> {
  const workflow = buildMiniMaxH3Workflow(params)
  const body = {
    prompt: workflow,
    client_id: getClientId(),
    // VideoHelperSuite (VHS_VideoCombine) otherwise writes THREE files per
    // generation: the first-frame PNG poster, an intermediate SILENT video,
    // and the muxed video-with-audio. We only want the audio video (+ our own
    // .meta.json sidecar). These VHS options are read from
    // extra_pnginfo.workflow.extra — skip the PNG and delete the silent video
    // so the output folder ends up clean.
    extra_data: {
      extra_pnginfo: {
        workflow: {
          extra: {
            VHS_MetadataImage: false,
            VHS_KeepIntermediate: false,
          },
        },
      },
    },
  }

  let res: Response
  try {
    res = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(
      `ComfyUI не отвечает на ${COMFY_URL}. ` +
        `Запустите ComfyUI и проверьте порт. (${String(err)})`,
    )
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`ComfyUI отклонил воркфлоу (HTTP ${res.status}): ${detail.slice(0, 500)}`)
  }

  const data = (await res.json()) as SubmitResult
  if (!data.prompt_id) throw new Error('ComfyUI вернул ответ без prompt_id.')
  return data
}

/**
 * (фикс) Ретраи при сетевых сбоях. Раньше один обрыв TCP (WinError 10054)
 * = getStatus возвращал 'unknown' → клиент считал это ошибкой и падал.
 * Теперь автоматически повторяем 2 раза с задержкой 1с, 2с.
 */
export async function getStatusWithRetry(promptId: string, maxRetries = 2): Promise<StatusResult> {
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Экспоненциальная задержка: 1с, 2с
        const delay = Math.pow(2, attempt) * 1000
        await new Promise(r => setTimeout(r, delay))
      }
      
      return await getStatus(promptId)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      
      // Если это последний ретрай — бросаем ошибку
      if (attempt === maxRetries) {
        throw lastError
      }
      
      // Иначе — пробуем снова
    }
  }
  
  throw lastError || new Error('Unknown error')
}

/** Poll the status of a submitted prompt. */
export async function getStatus(promptId: string): Promise<StatusResult> {
  statusDbg(`getStatus(${promptId})`)
  // (фикс) Увеличенные таймауты для видео генерации. Раньше 5 секунд было
  // мало — при длинной генерации TCP-соединение разрывалось (WinError 10054),
  // и getStatus возвращал 'unknown' → клиент считал это ошибкой.
  // Теперь 30 секунд — достаточно даже для медленных машин.
  const histRes = await fetch(`${COMFY_URL}/history/${promptId}`, {
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)

  if (histRes && histRes.ok) {
    const hist = await histRes.json()
    const entry = hist[promptId]
    if (entry) {
      const statusStr = entry.status?.status_str?.toLowerCase() ?? ''
      const errMsg = entry.status?.messages?.find(
        (m: { type: string }) => m.type === 'execution_error',
      )

      if (errMsg || statusStr.includes('error')) {
        console.warn(`[status] ${promptId}: ERROR from history —`, statusStr, errMsg?.data?.exception_type)
        return {
          status: 'error',
          detail:
            errMsg?.data?.exception_type ||
            entry.status?.status_str ||
            'Ошибка выполнения',
        }
      }

      // Extract outputs — check ALL keys for file arrays (robust to different node output names)
      const outputs: Array<{ filename: string; subfolder: string; type: string }> = []
      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        const o = nodeOutput as Record<string, unknown>
        for (const val of Object.values(o)) {
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item && typeof item === 'object' && 'filename' in item) {
                outputs.push(item as { filename: string; subfolder: string; type: string })
              }
            }
          }
        }
      }
      statusDbg(`${promptId}: DONE`)
      return { status: 'done', outputs }
    }
    // No entry in history — fall through to queue check
    statusDbg(`${promptId}: not in history, checking queue...`)
  } else {
    statusDbg(`${promptId}: history request failed (histRes=${!!histRes}, ok=${histRes?.ok})`)
  }

  // Check queue
  // (фикс) Увеличенный таймаут — см. выше
  const queueRes = await fetch(`${COMFY_URL}/queue`, {
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)

  if (queueRes && queueRes.ok) {
    const queue = await queueRes.json()
    const running = queue.queue_running ?? []
    const pending = queue.queue_pending ?? []

    // ComfyUI queue format: [[number, prompt_id, prompt, ...], ...]
    // item[0] = queue number (int), item[1] = prompt_id (string)
    if (running.some((item: unknown[]) => item[1] === promptId)) {
      statusDbg(`${promptId}: RUNNING`)
      return { status: 'running' }
    }
    if (pending.some((item: unknown[]) => item[1] === promptId)) {
      statusDbg(`${promptId}: QUEUED`)
      return { status: 'queued' }
    }
    statusDbg(`${promptId}: NOT in queue (running=${running.length}, pending=${pending.length})`)
  } else {
    statusDbg(`${promptId}: queue request failed (queueRes=${!!queueRes})`)
  }

  // Оба запроса упали — ComfyUI недоступен/перезапускается. Это НЕ «queued»:
  // раньше такой ответ бесконечно показывал «В очереди…», пока не истекал
  // 60-минутный таймаут. Клиент считает подряд идущие 'unknown' и падает
  // в ошибку после N попыток.
  if (!histRes && !queueRes) {
    return { status: 'unknown', detail: 'ComfyUI не отвечает' }
  }

  // Not in queue and not in history. ComfyUI answers (both requests
  // succeeded) but this prompt_id is nowhere to be found — it was either
  // rejected (execution error that ComfyUI didn't record in /history for
  // this client_id), lost (ComfyUI restart), or never properly queued.
  //
  // Returning 'queued' here was a trap: the client polls forever, shows
  // «Генерация…» for the full 60-minute timeout, and the user sees a
  // phantom generation. Returning 'unknown' lets the client's consecutive-
  // unknown counter kick in (20 polls × 1s = 20s) and surface a clear
  // error: «ComfyUI не отвечает» — which, while slightly misleading in
  // this specific case (ComfyUI IS responding), is far better than
  // waiting an hour for a job that will never finish.
  console.warn(
    `[status] ${promptId}: NOT FOUND — ComfyUI отвечает (history+queue OK), ` +
    `но prompt_id отсутствует в обоих. Возможно, ComfyUI отклонил задачу, ` +
    `или был перезапущен. Возвращаю 'unknown'.`
  )
  return { status: 'unknown', detail: 'Задача не найдена в ComfyUI (отклонена или потеряна)' }
}

/**
 * Cancel a specific prompt (правка 145).
 *
 * ГЛАВНОЕ: /interrupt убивает ТЕКУЩУЮ выполняющуюся задачу ComfyUI — независимо
 * от того, какой prompt_id мы имеем в виду. Раньше /interrupt слался ВСЕГДА:
 * удаление ОЖИДАЮЩЕЙ задачи (или уже завершённой) прерывало ЧУЖУЮ идущую
 * генерацию (баг: «удалил последнюю из трёх — прервалась та, что генерировалась»).
 *
 * Теперь:
 *  • задача ВЫПОЛНЯЕТСЯ → /interrupt + удалить из очереди;
 *  • задача ОЖИДАЕТ → только удалить из очереди; затем перепроверка: если за
 *    это время она успела стартовать (гонка pending→running между GET и
 *    DELETE) — прерываем именно её;
 *  • задачи нет в очереди (завершена/потеряна) → ничего не делаем, /interrupt
 *    не трогаем.
 */
export async function cancelPrompt(promptId: string): Promise<void> {
  const inQueueState = async (): Promise<{ running: boolean; pending: boolean }> => {
    try {
      const res = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return { running: false, pending: false }
      const q = await res.json()
      const match = (arr: unknown[]) => (arr ?? []).some((item) => Array.isArray(item) && item[1] === promptId)
      return {
        running: match(q.queue_running),
        pending: match(q.queue_pending),
      }
    } catch {
      return { running: false, pending: false }
    }
  }
  const deleteFromQueue = () =>
    fetch(`${COMFY_URL}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  const interruptRunning = () =>
    fetch(`${COMFY_URL}/interrupt`, { method: 'POST' }).catch(() => {})

  const state = await inQueueState()

  if (state.running) {
    // Наша задача исполняется: прерываем и вычищаем остатки из очереди.
    await interruptRunning()
    await deleteFromQueue()
    return
  }
  if (state.pending) {
    // Только удаление из очереди — НЕ трогаем чужую выполняющуюся задачу.
    await deleteFromQueue()
    // Гонка: задача могла стартовать между GET и DELETE — тогда DELETE её не
    // взял, и она теперь running. Перепроверяем и прерываем ИМЕННО её.
    const after = await inQueueState()
    if (after.running) await interruptRunning()
    return
  }
  // Задачи в очереди нет (завершена/отклонена/потеряна): полный no-op.
  // Раньше здесь уходил безусловный /interrupt — и убивал чужую генерацию.
}

/** Build a URL for viewing a generated file. */
export function fileUrl(filename: string, subfolder = '', type = 'output'): string {
  const params = new URLSearchParams({ filename, subfolder, type })
  return `${COMFY_URL}/view?${params}`
}
