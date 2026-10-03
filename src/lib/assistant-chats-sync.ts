/**
 * assistant-chats-sync — синхронизация чатов ассистента с файлом проекта.
 *
 * Источники (приоритет):
 *   1. Сервер (data/assistant-chats.json) — переносимое хранилище
 *   2. localStorage браузера — кэш / фолбэк если сервер недоступен
 *
 * При каждом изменении стора — debounce-запись на сервер.
 * При старте — загрузка с сервера, если есть данные — перезапись стора.
 */
import { useAssistantChats, type AssistantChat } from './assistant-chats-store'

let initialized = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let prevChats: AssistantChat[] = []
/** (правка 108) true, пока PUT синхронизации в полёте — flush не дублирует его. */
let saving = false
/** Flush пришёл, пока PUT был в полёте — перезапустить сохранение по завершении. */
let pendingFlush = false
/** true после первой загрузки с сервера или первого изменения стора:
 *  только тогда допустимо слать ПУСТОЙ список (иначе закрытие вкладки до
 *  завершения loadFromServer затирало бы серверные чаты пустым массивом). */
let storeTouched = false
const SAVE_DEBOUNCE_MS = 1500

/** (правка 108) Захватить состояние чатов для передачи в тело запроса.
 *  Пустой список — ВАЛИДНОЕ состояние (пользователь удалил все чаты):
 *  возвращаем его как есть, иначе flush при закрытии вкладки ничего не
 *  слал и удалённые чаты «воскресали» из файла на сервере при следующем
 *  запуске. null — только если стор ещё не загружен/недоступен. */
function capturePayload(): string | null {
  try {
    const { chats, activeChatId } = useAssistantChats.getState()
    if (!Array.isArray(chats)) return null
    if (chats.length === 0 && !storeTouched) return null
    return JSON.stringify({ chats, activeChatId })
  } catch {
    return null
  }
}

/** (правка 108) Синхронный flush: завершает незапущенный debounce-tick и,
 *  если PUT ещё не в полёте, отправляет его с keepalive — доживёт до
 *  доставки даже при закрытии вкладки. sendBeacon — фолбэк, если fetch
 *  недоступен/отклонён (некоторые браузеры не умеют beacon с JSON-телом). */
function flushSave() {
  if (typeof window === 'undefined') return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saving) {
    // PUT уже в полёте — не дублируем, но помечаем: изменения, сделанные
    // ПОСЛЕ захвата его тела, надо сохранить ещё раз по завершении,
    // иначе они молча теряются (debounce-таймер уже очищен).
    pendingFlush = true
    return
  }
  const payload = capturePayload()
  if (!payload) return
  let done = false
  try {
    const r = fetch('/api/assistant/chats', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    })
    if (r && typeof (r as Promise<unknown>).catch === 'function') {
      void (r as Promise<unknown>).catch(() => { done = false })
      done = true
    }
  } catch {
    done = false
  }
  if (!done) {
    try {
      if (navigator.sendBeacon) navigator.sendBeacon('/api/assistant/chats', new Blob([payload], { type: 'application/json' }))
    } catch { /* beacon недоступен — данные останутся в localStorage */ }
  }
}

/**
 * Инициализирует синхронизацию. Вызывается один раз при маунте приложения.
 * 1. Загружает чаты с сервера (если есть) → в стор.
 * 2. Подписывается на изменения стора → debounce-save на сервер.
 */
export function initAssistantChatsSync() {
  if (initialized) return
  initialized = true

  // 1. Load from server
  void loadFromServer()

  // 2. Subscribe to changes → debounced save
  prevChats = useAssistantChats.getState().chats

  useAssistantChats.subscribe((state) => {
    // Only save if chats actually changed (not just activeChatId)
    if (state.chats === prevChats) return
    prevChats = state.chats
    storeTouched = true

    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveToServer()
    }, SAVE_DEBOUNCE_MS)
  })

  // (правка 108) Стабильность синхронизации: при закрытии/скрытии вкладки
  // незапущенный debounce-тикс (1.5 с) раньше терялся — чат пропадал с диска.
  // Теперь flush с keepalive (живёт до доставки) + sendBeacon-фолбэк.
  window.addEventListener('pagehide', flushSave)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave()
  })
}

/**
 * (правка 74) Перезагрузить чаты из файла проекта (data/assistant-chats.json).
 * Вызывается после переноса чатов из старой версии программы.
 */
export async function reloadAssistantChats(): Promise<void> {
  await loadFromServer()
}

async function loadFromServer() {
  try {
    const res = await fetch('/api/assistant/chats')
    if (!res.ok) return
    const data = await res.json()
    if (!data.found || !Array.isArray(data.chats) || data.chats.length === 0) {
      // Server has no data — keep whatever is in localStorage
      return
    }
    // Merge: per-chat by updatedAt. Раньше серверная копия затирала локальную
    // ВСЕГДА — если прошлый PUT потерялся (крах до debounce/flush), сообщения
    // из потерянного окна исчезали при следующем запуске. Теперь побеждает
    // более свежая копия; чаты только-локальные и только-серверные входят как есть.
    const store = useAssistantChats.getState()
    storeTouched = true
    const localById = new Map(store.chats.map((c) => [c.id, c]))
    const merged = data.chats.map((c: AssistantChat) => {
      const local = localById.get(c.id)
      if (!local) return c
      // нет updatedAt (старые записи) — считаем серверную копию актуальной
      if (typeof local.updatedAt !== 'number' || typeof c.updatedAt !== 'number') return c
      return local.updatedAt > c.updatedAt ? local : c
    })
    const serverIds = new Set(merged.map((c: AssistantChat) => c.id))
    const localOnly = store.chats.filter((c) => !serverIds.has(c.id))
    merged.push(...localOnly)
    const activeChatId =
      typeof data.activeChatId === 'string' && merged.some((c) => c.id === data.activeChatId)
        ? data.activeChatId
        : (merged[0]?.id ?? null)

    // Update store without triggering save loop
    useAssistantChats.setState({ chats: merged, activeChatId })
    prevChats = merged

    // Immediately persist to server (in case localStorage had more)
    void saveToServer()
  } catch {
    // Server unavailable — silently fall back to localStorage
  }
}

async function saveToServer() {
  // (правка 108) saving=true — flushSave() не дублирует уже идущий PUT.
  saving = true
  try {
    const { chats, activeChatId } = useAssistantChats.getState()
    const res = await fetch('/api/assistant/chats', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chats, activeChatId }),
    })
    if (!res.ok) {
      // Non-critical: log but don't crash
      console.warn('[assistant-chats-sync] save failed:', res.status)
    }
  } catch (err) {
    // Server unavailable — data stays in localStorage cache
    console.warn('[assistant-chats-sync] save error:', err)
  } finally {
    saving = false
    if (pendingFlush) {
      pendingFlush = false
      void saveToServer()
    }
  }
}
