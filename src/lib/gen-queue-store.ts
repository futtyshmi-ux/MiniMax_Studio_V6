/**
 * Global generation queue store (Zustand, persisted to localStorage).
 *
 * Tracks all active/recent generations across all tabs so that:
 *   - The QueueIndicator can show overall status
 *   - Multiple generations can run concurrently
 *   - Each item has its own progress tracking
 *   - Auto-cleanup removes finished items after a timeout
 *
 * Persisted so the queue (and its ComfyUI prompt_ids) survives a page
 * reload — useVideoGen re-attaches polling for active items on mount.
 * On rehydrate, finished items and anything older than MAX_AGE_MS are
 * dropped (their auto-remove timers don't survive the reload).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/* ──────────────────── Types ──────────────────── */

export type QueueItemType = 'image' | 'music' | 'sound' | 'video'
export type QueueItemStatus = 'submitting' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface QueueItem {
  id: string
  type: QueueItemType
  label: string
  promptId: string | null
  status: QueueItemStatus
  progressValue: number
  progressMax: number
  error: string | null
  /** Real-time status message from the backend (e.g. "Downloading model..."). */
  message: string | null
  createdAt: number
  completedAt: number | null
}

/* ──────────────────── Accent colors ──────────────────── */

export const TYPE_ACCENT: Record<QueueItemType, string> = {
  image: '#8B5CF6',
  music: '#10B981',
  sound: '#14B8A6',
  video: '#06B6D4',
}

export const TYPE_LABEL: Record<QueueItemType, string> = {
  image: 'Изображение',
  music: 'Музыка',
  sound: 'Звук',
  video: 'Видео',
}

/* ──────────────────── Auto-cleanup ──────────────────── */

const AUTO_REMOVE_DONE_MS = 30000
// (фикс Phase 4) 10 с → 30 с: ошибка исчезала мгновенно, пользователь не
// успевал прочитать сообщение. 30 с — достаточно, чтобы увидеть причину.
const AUTO_REMOVE_ERROR_MS = 30000
/** Rehydrated items older than this are dropped (stale across sessions). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Drop finished + stale items when rehydrating from localStorage. */
function rehydrateItems(persisted: unknown): QueueItem[] {
  const items = (persisted as { items?: QueueItem[] } | null)?.items
  if (!Array.isArray(items)) return []
  const now = Date.now()
  return items.filter(
    (i) =>
      now - i.createdAt < MAX_AGE_MS &&
      i.status !== 'done' &&
      i.status !== 'error' &&
      i.status !== 'cancelled',
  )
}

/* ──────────────────── ID generator ──────────────────── */

let nextId = 1
function genId(): string {
  return `q_${nextId++}_${Date.now().toString(36)}`
}

/* ──────────────────── Store ──────────────────── */

interface GenQueueState {
  items: QueueItem[]

  /** Add a new item to the queue, returns the queue item ID. */
  enqueue: (type: QueueItemType, label: string) => string

  /** Set the ComfyUI prompt_id for a queue item. */
  setPromptId: (id: string, promptId: string) => void

  /** Update the status of a queue item. Triggers auto-cleanup for done/error. */
  setStatus: (id: string, status: QueueItemStatus, error?: string) => void

  /** Update the progress of a queue item. */
  setProgress: (id: string, value: number, max: number) => void

  /** Update the real-time status message for a queue item. */
  setMessage: (id: string, message: string | null) => void

  /** Remove a specific item from the queue. */
  remove: (id: string) => void

  /** Remove all done/error/cancelled items. */
  clearFinished: () => void
}

export const useGenQueue = create<GenQueueState>()(
  persist(
    (set) => ({
      items: [],

      enqueue: (type, label) => {
        const id = genId()
        const item: QueueItem = {
          id,
          type,
          label: label.length > 40 ? label.slice(0, 37) + '…' : label,
          promptId: null,
          status: 'submitting',
          progressValue: 0,
          progressMax: 0,
          error: null,
          message: null,
          createdAt: Date.now(),
          completedAt: null,
        }
        set((s) => ({ items: [...s.items, item] }))
        return id
      },

      setPromptId: (id, promptId) => {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id ? { ...item, promptId } : item
          ),
        }))
      },

      setStatus: (id, status, error) => {
        const finished = status === 'done' || status === 'error' || status === 'cancelled'
        const completedAt = finished ? Date.now() : null
        
        // (фикс) Диагностика: логируем все переходы состояний для отладки
        const currentItem = useGenQueue.getState().items.find((i) => i.id === id)
        const previousStatus = currentItem?.status
        if (currentItem) {
          console.log(`[queue-store] ${id}: ${previousStatus} → ${status}`, error || '')
        }
        
        // (фикс) BLOCK terminal → non-terminal transitions (resurrection).
        // Это последний рубеж защиты: если предыдущие guards не сработали
        // (race condition), store сам откажет в переводе error/done/cancelled
        // обратно в submitting/queued/running.
        const TERMINAL: QueueItemStatus[] = ['done', 'error', 'cancelled']
        const NON_TERMINAL: QueueItemStatus[] = ['submitting', 'queued', 'running']
        if (currentItem && TERMINAL.includes(currentItem.status) && NON_TERMINAL.includes(status)) {
          console.warn(`[queue-store] BLOCKED resurrection: ${id} (${currentItem.status}) → ${status}`)
          return
        }
        
        // (фикс) Запускаем таймер удаления ТОЛЬКО если статус изменился с предыдущего.
        // Это предотвращает race condition: если элемент уже был 'done',
        // повторный setStatus('done') не запустит новый таймер.
        const shouldStartTimer = previousStatus !== status && finished
        
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id
              ? { ...item, status, error: error ?? item.error, completedAt }
              : item
          ),
        }))

        // (фикс) Auto-remove finished items after a delay
        if (shouldStartTimer) {
          if (status === 'done' || status === 'cancelled') {
            setTimeout(() => {
              console.log(`[queue-store] auto-removing ${id}`)
              set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
            }, AUTO_REMOVE_DONE_MS)
          } else if (status === 'error') {
            setTimeout(() => {
              console.log(`[queue-store] auto-removing ${id} (error)`)
              set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
            }, AUTO_REMOVE_ERROR_MS)
          }
        }
      },

      setProgress: (id, value, max) => {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id ? { ...item, progressValue: value, progressMax: max } : item
          ),
        }))
      },

      setMessage: (id, message) => {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === id ? { ...item, message } : item
          ),
        }))
      },

      remove: (id) => {
        set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
      },

      clearFinished: () => {
        set((s) => ({
          items: s.items.filter(
            (i) => i.status !== 'done' && i.status !== 'error' && i.status !== 'cancelled'
          ),
        }))
      },
    }),
    {
      name: 'h3-gen-queue',
      version: 1,
      partialize: (state) => ({ items: state.items }),
      merge: (persisted, current) => ({
        ...current,
        items: rehydrateItems(persisted),
      }),
    }
  )
)
