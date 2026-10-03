/**
 * Диспетчер VRAM — строгая взаимная блокировка LLM ↔ MiniMax H3.
 *
 * Правила (см. docs/superpowers/specs/2026-08-31-vram-arbiter-design.md):
 *  • идёт генерация видео → чат LLM запрещён (409);
 *  • LLM отвечает → генерация запрещена (409);
 *  • перед загрузкой LLM — выгрузить модели ComfyUI и ПОДТВЕРДИТЬ по nvidia-smi;
 *  • перед отправкой генерации — выгрузить LLM и ПОДТВЕРДИТЬ по nvidia-smi;
 *  • после завершения всех генераций модели ComfyUI выгружаются фоном.
 *
 * Все переходы сериализуются async-mutex (withLock): чат и генерация
 * физически не могут выполняться параллельно.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { awaitLlmStartup, llmPid, stopLlm } from './llm-runner'

const execFileAsync = promisify(execFile)

const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/* ── Async-mutex: цепочка промисов ── */

let chain: Promise<unknown> = Promise.resolve()

/**
 * (фикс Phase 4) Максимальное время ожидания освобождения mutex.
 * Если предыдущая операция зависла (nvidia-smi timeout, зависший fetch),
 * следующая не ждёт вечно, а получает ошибку. 120 с — более чем достаточно
 * для всех нормальных операций (evict LLM ~15с, evict Comfy ~90с).
 */
const LOCK_WAIT_TIMEOUT_MS = 120_000

/**
 * Сериализует переданную операцию: следующий вызов ждёт завершения предыдущего.
 * НЕ реентерабелен: вызов withLock внутри залоченной секции приводит к deadlock.
 *
 * (фикс Phase 4) Гарантии:
 *  1. chain НКОГДА не остаётся rejected — каждое звено завершается resolved.
 *  2. Ожидание освобождения имеет таймаут — зависшая операция не блокирует
 *     последующие вызовы вечно.
 */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // Таймаут ожидания: если предыдущая операция в цепочке зависла,
  // не ждём вечно, а бросаем ошибку.
  const waitWithTimeout = Promise.race([
    chain,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(
        `Диспетчер VRAM: ожидание освобождения заняло >${LOCK_WAIT_TIMEOUT_MS / 1000} с (предыдущая операция зависла)`,
      )), LOCK_WAIT_TIMEOUT_MS),
    ),
  ])

  const run = waitWithTimeout.then(async (): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      throw err // вызывающий получит rejection, но chain остаётся resolved
    }
  })

  // chain всегда resolved — даже если run отклонён, цепочка не блокируется.
  chain = run.catch(() => {})
  return run
}

/* ── Счётчик активных SSE-стримов LLM ── */

let streamingCount = 0

/** (правка 110) Момент последнего +1 — для сторожа утечек. 0 = стримов нет. */
let streamingStartedAt = 0

/** (правка 110) Замок, держащийся дольше, считаем зависшим. Здорогому
 * стриму не жить столько: idle-сторож прерывает LLM после 5 мин тишины,
 * подключение к upstream ограничено 120 с. */
const STREAMING_STUCK_MS = 30 * 60_000

/** +1 при старте стрима ответа, −1 при завершении/обрыве. */
export function noteLlmStreaming(delta: 1 | -1): void {
  const prev = streamingCount
  streamingCount = Math.max(0, streamingCount + delta)
  // (правка 110) timestamp + диагностический лог (видно в server.log, кто +1/−1)
  if (delta > 0) streamingStartedAt = Date.now()
  if (streamingCount === 0) streamingStartedAt = 0
  console.log(`[vram] (правка 110) streaming: ${prev} → ${streamingCount}`)
}

/** True, пока LLM пишет ответ в чат. */
export function llmStreaming(): boolean {
  if (streamingCount <= 0) return false
  // (правка 110) Сторож утечек: если насос стрима завис (зависший
  // writer.write/close на half-open сокете) и finish() так и не сработал,
  // счётчик держал бы блокировку генерации ВЕЧНО (кнопка 409 навсегда).
  // Здорогому стриму не жить дольше STREAMING_STUCK_MS — снимаем замок.
  if (streamingStartedAt > 0 && Date.now() - streamingStartedAt > STREAMING_STUCK_MS) {
    console.warn(`[vram] (правка 110) streaming-счётчик завис (count=${streamingCount}, >30 мин) — снимаю блокировку`)
    streamingCount = 0
    streamingStartedAt = 0
    return false
  }
  return true
}

/**
 * (правка 110) Принудительное снятие блокировки ассистента (UI-fallback).
 * Только если замок держится ДОЛЬШЕ `minAgeMs`: свежий замок (стрим реально
 * идёт) не трогаем. true = сняли, false = нечего снимать / замок свежий.
 */
export function forceReleaseAssistantLock(minAgeMs: number = 60_000): boolean {
  if (streamingCount <= 0) return false
  const held = streamingStartedAt > 0 ? Date.now() - streamingStartedAt : Infinity
  if (held < minAgeMs) return false
  console.warn(`[vram] (правка 110) forceRelease: count ${streamingCount} → 0 (замок держался ${Math.round(held / 1000)} с)`)
  streamingCount = 0
  streamingStartedAt = 0
  return true
}

/* ── Состояние очереди ComfyUI ── */

/** True, когда в ComfyUI есть running/pending задачи (генерация «не закончилась»). */
export async function comfyBusy(): Promise<boolean> {
  try {
    const r = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return false
    const q = await r.json()
    return (q.queue_running?.length ?? 0) > 0 || (q.queue_pending?.length ?? 0) > 0
  } catch {
    return false // ComfyUI недоступен — ничего не может выполняться
  }
}

/* ── nvidia-smi: per-process VRAM ── */

/** VRAM (МБ) по PID для процессов на GPU. null = nvidia-smi недоступен. Значение -1 = объём неизвестен (WDDM `[N/A]`). */
async function gpuProcs(): Promise<Map<number, number> | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    )
    const map = new Map<number, number>()
    for (const line of stdout.trim().split(/\r?\n/)) {
      if (!line.trim()) continue
      const [pidS, mbS] = line.split(',')
      const pid = parseInt((pidS ?? '').trim(), 10)
      const mb = parseInt((mbS ?? '').replace(/[^\d]/g, ''), 10)
      if (Number.isFinite(pid) && pid > 0) map.set(pid, Number.isFinite(mb) ? mb : -1)
    }
    return map
  } catch {
    return null
  }
}

/**
 * Глобально занятый VRAM (МБ) по ВСЕМ процессам. null = nvidia-smi недоступен.
 * На Windows WDDM per-process объём недоступен ([N/A]), но глобальный — всегда.
 * ВНИМАНИЕ: на WDDM nvidia-smi запаздывает на десятки секунд после освобождения.
 */
async function gpuUsedMb(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    )
    const mb = parseInt((stdout.trim().split(/\r?\n/)[0] ?? ''), 10)
    return Number.isFinite(mb) ? mb : null
  } catch {
    return null
  }
}

/**
 * Занятый VRAM (МБ) по данным САМОГО ComfyUI (/system_stats → cudaMemGetInfo).
 * Реальное время — в отличие от nvidia-smi на WDDM. Учитывает все процессы.
 * null = ComfyUI недоступен или неожиданный формат ответа.
 */
async function comfyVramUsedMb(): Promise<number | null> {
  try {
    const r = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return null
    const j = await r.json()
    const d = j?.devices?.[0]
    const total = typeof d?.vram_total === 'number' ? d.vram_total : NaN
    const free = typeof d?.vram_free === 'number' ? d.vram_free : NaN
    if (!Number.isFinite(total) || !Number.isFinite(free)) return null
    return Math.round((total - free) / (1024 * 1024))
  } catch {
    return null
  }
}

/* ── ComfyUI /free ── */

/** Попросить ComfyUI выгрузить модели (асинхронно на стороне ComfyUI!). */
async function freeComfy(): Promise<void> {
  try {
    await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* ComfyUI недоступен — выгружать нечего */
  }
}

/* ── Поиск PID ComfyUI ── */

const PS_FIND_COMFY = [
  "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\"",
  "Where-Object { $_.CommandLine -like '*ComfyUI*main.py*' }",
  'Select-Object -ExpandProperty ProcessId',
].join(' | ')

/** PID python-процесса ComfyUI (по командной строке). null = не запущен. */
async function findComfyPid(): Promise<number | null> {
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-Command', PS_FIND_COMFY],
    { timeout: 10_000 },
  )
  const pid = parseInt((stdout.trim().split(/\r?\n/)[0] ?? ''), 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/* ── Проверенные выгрузки ── */

export type EvictResult = { ok: true } | { ok: false; error: string }

const VRAM_UNAVAILABLE = 'nvidia-smi недоступен — не могу подтвердить освобождение VRAM'

/**
 * Выгрузить LLM и подтвердить по nvidia-smi, что его PID исчез из GPU.
 * Вызывать ТОЛЬКО под withLock. Время — до ~15 с (обычно 1–2 с).
 */
export async function evictLlmVerified(): Promise<EvictResult> {
  // Пока LLM стартует, stopLlm бесполезен (процесс ещё не создан или ещё
  // грузится) — дожидаемся загрузки, затем останавливаем и верифицируем.
  await awaitLlmStartup()
  const pid = llmPid()
  if (pid !== null) {
    console.log('[vram] выгружаю LLM перед генерацией…')
    await stopLlm()
  }
  if (pid === null) return { ok: true } // не был запущен
  const deadline = Date.now() + 15_000
  for (;;) {
    const procs = await gpuProcs()
    if (procs === null) return { ok: false, error: VRAM_UNAVAILABLE }
    if (!procs.has(pid)) {
      console.log(`[vram] LLM (PID ${pid}) полностью покинул VRAM`)
      return { ok: true }
    }
    if (Date.now() > deadline) {
      const mb = procs.get(pid) ?? 0
      return { ok: false, error: `LLM (PID ${pid}) не освободил VRAM за 15 с (${mb < 0 ? 'объём неизвестен' : `${mb} МБ`})` }
    }
    await sleep(500)
  }
}

/** ComfyUI считается «пустым», когда его процесс держит ≤ этого объёма (только CUDA-контекст). */
const COMFY_EMPTY_MB = 1500

/**
 * Порог «GPU пуст» для ГЛОБАЛЬНОЙ проверки (WDDM-режим, per-process недоступен):
 * базовая линия — CUDA-контексты всех процессов (~1–1.5 ГБ), без моделей ComfyUI.
 */
const COMFY_GLOBAL_EMPTY_MB = 2500

/**
 * Выгрузить модели ComfyUI (POST /free) и подтвердить освобождение VRAM.
 * Верификация, в порядке надёжности:
 *  1) per-process nvidia-smi (когда драйвер отдаёт объём — TCC/часть систем);
 *  2) /system_stats самого ComfyUI (cudaMemGetInfo — реальное время);
 *  3) глобальный nvidia-smi (на WDDM запаздывает на десятки секунд).
 * PID ComfyUI — только ускоряет точную ветку; при сбое поиска верифицируем
 * системными метриками (freeComfy не требует PID). Вызывать ТОЛЬКО под withLock.
 */
export async function evictComfyVerified(timeoutMs = 30_000): Promise<EvictResult> {
  const procs0 = await gpuProcs()
  if (procs0 === null) return { ok: false, error: VRAM_UNAVAILABLE }

  let comfyPid: number | null = null
  try {
    comfyPid = await findComfyPid()
  } catch {
    comfyPid = null // CIM-поиск иногда таймаутится — верифицируем по метрикам
  }

  // (фикс правки 136) ComfyUI НЕ запущен → выгружать нечего: его моделей в
  // VRAM нет физически. Раньше включался fallback на ГЛОБАЛЬНЫЙ nvidia-smi,
  // который считает и НАШ собственный LLM-процесс (Bonsai ~10 ГБ), и сторонние
  // приложения → ложный 503 «не освободил VRAM» на ВТОРОМ сообщении чата,
  // если ComfyUI в этот момент выключен.
  if (comfyPid === null) {
    const comfyAlive = await fetch(`${COMFY_URL}/system_stats`, {
      signal: AbortSignal.timeout(2500),
    }).then((r) => r.ok).catch(() => false)
    if (!comfyAlive) {
      console.log('[vram] ComfyUI не запущен — выгружать его модели не нужно')
      return { ok: true }
    }
  }

  if (comfyPid === null) {
    console.log('[vram] PID ComfyUI не найден — верифицирую по системным метрикам')
  }

  // Быстрый выход: PID известен и ComfyUI уже не держит GPU
  if (comfyPid !== null && !procs0.has(comfyPid)) {
    console.log(`[vram] MiniMax выгружен: ComfyUI (PID ${comfyPid}) покинул GPU-процессы`)
    return { ok: true }
  }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    await freeComfy()
    const procs = await gpuProcs()
    if (procs === null) return { ok: false, error: VRAM_UNAVAILABLE }

    let used: number | null
    let threshold: number
    const mb = comfyPid !== null ? procs.get(comfyPid) : undefined
    if (mb !== undefined && mb >= 0) {
      // per-process объём доступен — точная проверка
      used = mb
      threshold = COMFY_EMPTY_MB
    } else {
      // WDDM [N/A] или PID не найден: /system_stats (реальное время),
      // fallback — глобальный nvidia-smi
      used = (await comfyVramUsedMb()) ?? (await gpuUsedMb())
      threshold = COMFY_GLOBAL_EMPTY_MB
    }
    if (used === null) return { ok: false, error: VRAM_UNAVAILABLE }

    if (used <= threshold) {
      console.log(`[vram] MiniMax выгружен (занято ${used} МБ${comfyPid === null ? ', без PID' : ''})`)
      return { ok: true }
    }
    if (Date.now() > deadline) {
      return { ok: false, error: `ComfyUI не освободил VRAM за ${timeoutMs / 1000} с (занято ${used} МБ > ${threshold} МБ)` }
    }
    await sleep(1500)
  }
}

/* ── Guard'ы (причина блокировки или null = разрешено) ── */

/** 409-причина запрета чата: идёт генерация (running или pending). */
export async function assertChatAllowed(): Promise<string | null> {
  return (await comfyBusy())
    ? 'Идёт генерация видео. Дождитесь окончания или остановите её.'
    : null
}

/** True, пока запрос чата живёт: грузит модель ИЛИ стримит ответ. */
let chatActive = false

/**
 * 409-причина запрета генерации: ассистент занят (грузится или отвечает).
 * chatActive закрывает холодный старт (до начала стрима), счётчик — сам ответ;
 * вместе они покрывают весь жизненный цикл чата БЕЗ ожидания mutex.
 */
export function assertGenerationAllowed(): string | null {
  return chatActive || llmStreaming()
    ? 'Ассистент отвечает. Дождитесь ответа или прервите его.'
    : null
}

/* ── Составные операции под mutex ── */

export type GateResult<T> = { ok: true; result: T } | { ok: false; error: string; status: number }

/**
 * Подготовить GPU к генерации и ОТПРАВИТЬ задачу под тем же mutex
 * (окно между проверкой и постановкой в очередь исключено):
 * guard → выгрузить LLM (verified) → submit().
 * 409 = конфликт состояний, 503 = не удалось выгрузить, 500 = ошибка submit.
 */
export async function runGeneration<T>(submit: () => Promise<T>): Promise<GateResult<T>> {
  try {
    return await withLock(async () => {
      const reason = assertGenerationAllowed()
      if (reason) {
        console.warn(`[vram] runGeneration BLOCKED: ${reason}`)
        return { ok: false, error: reason, status: 409 }
      }
      const ev = await evictLlmVerified()
      if (!ev.ok) {
        console.error(`[vram] runGeneration FAILED: ${ev.error}`)
        return { ok: false, error: ev.error, status: 503 }
      }
      try {
        const result = await submit()
        console.log(`[vram] runGeneration OK`)
        return { ok: true, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[vram] runGeneration SUBMIT ERROR: ${msg}`)
        return { ok: false, error: msg, status: 500 }
      }
    })
  } catch (err) {
    // (фикс Phase 4) withLock мог отклониться (не должно быть после фикса,
    // но страховка): возвращаем структурированную ошибку вместо unhandled rejection.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[vram] runGeneration UNEXPECTED ERROR: ${msg}`)
    return { ok: false, error: `Внутренняя ошибка диспетчера VRAM: ${msg}`, status: 500 }
  }
}

/**
 * Подготовить GPU к чату под mutex:
 * guard (генерация?) → выгрузить ComfyUI (verified) → start() (= ensureLlm,
 * держит mutex на всю загрузку модели — генерация корректно ждёт).
 *
 * КОНТРАКТ: если start() запускает стрим ответа, noteLlmStreaming(+1) нужно
 * вызвать ВНУТРИ start() — пока mutex ещё занят. Иначе между освобождением
 * mutex и началом стрима генерация успеет выгрузить только что загруженный LLM.
 */
export async function startChat<T>(start: () => Promise<T>): Promise<GateResult<T>> {
  chatActive = true
  try {
    try {
      return await withLock(async () => {
        const reason = await assertChatAllowed()
        if (reason) return { ok: false, error: reason, status: 409 }
        const ev = await evictComfyVerified()
        if (!ev.ok) return { ok: false, error: ev.error, status: 503 }
        try {
          return { ok: true, result: await start() }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err), status: 500 }
        }
      })
    } catch (err) {
      // (фикс Phase 4) Страховка: сиротная ошибка из mutex-цепочки.
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[vram] startChat UNEXPECTED ERROR: ${msg}`)
      return { ok: false, error: `Внутренняя ошибка диспетчера VRAM: ${msg}`, status: 500 }
    }
  } finally {
    chatActive = false
  }
}

/* ── Фоновая выгрузка после завершения всех генераций ── */

let lastDrainAt = 0

/**
 * Вызывается progress-tracker'ом, когда очередь ComfyUI опустела:
 * сразу выкидываем модели MiniMax из VRAM, чтобы GPU был свободен для LLM.
 * Минимум 5 с между попытками (защита от повторных status-событий).
 *
 * (фикс Phase 4) Раньше эта функция ДЕРЖАЛА mutex до 90 секунд
 * (evictComfyVerified(90_000)). Если пользователь нажал «Генерация» во время
 * фоновой выгрузки, его запрос ждал в очереди mutex до 90 с — а клиентский
 * AbortSignal.timeout(60_000) убивал запрос раньше. Теперь: проверка занятости
 * ComfyUI (быстрая) идёт под замком, а сама выгрузка — БЕЗ замка. Если
 * параллельно стартует генерация, она просто не найдёт ComfyUI «пустым» —
 * модели выгрузятся на лету при следующем free-запросе ComfyUI.
 */
export async function onQueueDrained(): Promise<void> {
  if (Date.now() - lastDrainAt < 5_000) return
  lastDrainAt = Date.now()
  console.log('[vram] очередь пуста — фоновая выгрузка моделей MiniMax')

  // Быстрая проверка под замком: не конкурируем со стартом чата/генерации.
  const shouldEvict = await withLock(async () => {
    if (await comfyBusy()) return false
    if (llmPid() !== null || chatActive) return false
    return true
  })
  if (!shouldEvict) return

  // Выгрузка БЕЗ замка: не блокируем генерацию на 90 секунд.
  // Если параллельно стартует генерация — ComfyUI сам выгрузит модели
  // при загрузке нового checkpoint (dynamic VRAM).
  try {
    const r = await evictComfyVerified(90_000)
    if (!r.ok) {
      console.log(`[vram] фоновая выгрузка: VRAM ещё не освободился (${r.error}) — повторится при следующем обращении к чату`)
    }
  } catch (err) {
    console.log(`[vram] фоновая выгрузка: ошибка — ${err instanceof Error ? err.message : err}`)
  }
}
