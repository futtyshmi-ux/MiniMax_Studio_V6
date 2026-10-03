/**
 * Assistant chats store (Zustand, persisted to localStorage) — правка 30.
 *
 * Multiple named conversations with the local LLM assistant:
 *   - chats survive reloads / tab switches;
 *   - the active chat is restored on mount;
 *   - the title auto-derives from the first user message;
 *   - the model "remembers" a chat because the whole (capped) message
 *     history is replayed with every request — see assistant-view.tsx.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AssistantChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** (правка 87) Вложение к сообщению (изображение/видео для LLM-анализа). */
  attachment?: {
    path: string
    name: string
    kind: 'image' | 'video'
    /** (правка 108) Местоположение файла:
     *  'chat'  = data/chat-attachments/ (изолированное хранилище чата — новое);
     *  'comfy' = ComfyUI/input/ (legacy, правки 86–87) — подаётся через /api/comfy/file.
     *  Поля без src (старые сообщения) рендерятся как legacy. */
    src?: 'chat' | 'comfy'
  }
}

export interface AssistantChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: AssistantChatMessage[]
}

const MAX_CHATS = 20
const MAX_MESSAGES_PER_CHAT = 200

interface AssistantChatsState {
  chats: AssistantChat[]
  activeChatId: string | null
  /**
   * Pending user message to auto-run when the view mounts (e.g. the
   * "Улучшить промпт" flow from the prompt editor). Cleared after run.
   */
  pendingImprove: string | null

  /** Create a new empty chat, make it active, return its id. */
  createChat: () => string
  deleteChat: (id: string) => void
  setActiveChat: (id: string) => void
  /** Append a message; auto-titles the chat from the first user message. */
  appendMessage: (id: string, msg: AssistantChatMessage) => void
  clearAll: () => void
  /** Queue an auto-run for the next AssistantView mount. */
  queueImprove: (content: string) => void
  /** Clear the queued auto-run. */
  clearImprove: () => void
}

function newId(): string {
  return `ac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function capChats(chats: AssistantChat[]): AssistantChat[] {
  return [...chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS)
}

export const useAssistantChats = create<AssistantChatsState>()(
  persist(
    (set) => ({
      chats: [],
      activeChatId: null,
      pendingImprove: null,

      createChat: () => {
        const id = newId()
        set((s) => ({
          chats: capChats([
            { id, title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), messages: [] },
            ...s.chats,
          ]),
          activeChatId: id,
        }))
        return id
      },

      deleteChat: (id) =>
        set((s) => {
          const chats = s.chats.filter((c) => c.id !== id)
          let activeChatId = s.activeChatId
          if (activeChatId === id) {
            activeChatId = chats[0]?.id ?? null
          }
          // (правка 108) Файлы вложений удалённого чата существуют только в чате —
          // удаляем их с диска (best-effort, fire-and-forget). Legacy-файлы
          // в ComfyUI/input/ НЕ трогаем: они могут быть референсами генерации.
          const doomed = s.chats.find((c) => c.id === id)
          if (doomed && typeof window !== 'undefined') {
            for (const m of doomed.messages) {
              const a = m.attachment
              if (a && a.src === 'chat' && typeof a.path === 'string' && a.path) {
                void fetch(
                  `/api/assistant/attachment?filename=${encodeURIComponent(a.path)}`,
                  { method: 'DELETE' },
                ).catch(() => {})
              }
            }
          }
          return { chats, activeChatId }
        }),

      setActiveChat: (id) =>
        set((s) => (s.chats.some((c) => c.id === id) ? { activeChatId: id } : s)),

      appendMessage: (id, msg) =>
        set((s) => ({
          chats: capChats(
            s.chats.map((c) => {
              if (c.id !== id) return c
              const title =
                (c.title === 'Новый чат' || !c.title) && msg.role === 'user'
                  ? msg.content.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Чат'
                  : c.title
              return {
                ...c,
                title,
                updatedAt: Date.now(),
                messages: [...c.messages, msg].slice(-MAX_MESSAGES_PER_CHAT),
              }
            }),
          ),
        })),

      clearAll: () =>
        set((s) => {
          // (правка 108) «Очистить контент» в настройках = удаление ВСЕХ чатов:
          // удаляем и их файлы вложений из изолированного хранилища
          // (best-effort, как в deleteChat) — иначе останутся сироты на диске.
          if (typeof window !== 'undefined') {
            for (const c of s.chats) {
              for (const m of c.messages) {
                const a = m.attachment
                if (a && a.src === 'chat' && typeof a.path === 'string' && a.path) {
                  void fetch(
                    `/api/assistant/attachment?filename=${encodeURIComponent(a.path)}`,
                    { method: 'DELETE' },
                  ).catch(() => {})
                }
              }
            }
          }
          return { chats: [], activeChatId: null }
        }),

      queueImprove: (content) => set({ pendingImprove: content }),
      clearImprove: () => set({ pendingImprove: null }),
    }),
    {
      name: 'h3-assistant-chats',
      version: 1,
      partialize: (state) => ({
        chats: state.chats,
        activeChatId: state.activeChatId,
        pendingImprove: state.pendingImprove,
      }),
      merge: (persisted, current) => {
        const raw = persisted as AssistantChatsState | null
        let chats: AssistantChat[] = Array.isArray(raw?.chats)
          ? raw.chats.filter(
              (c) =>
                c &&
                typeof c.id === 'string' &&
                Array.isArray(c.messages) &&
                c.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'),
            )
          : []
        chats = capChats(chats)
        const activeChatId =
          typeof raw?.activeChatId === 'string' && chats.some((c) => c.id === raw.activeChatId)
            ? raw.activeChatId
            : (chats[0]?.id ?? null)
        const pendingImprove = typeof raw?.pendingImprove === 'string' ? raw.pendingImprove : null
        return { ...current, chats, activeChatId, pendingImprove }
      },
    },
  ),
)
