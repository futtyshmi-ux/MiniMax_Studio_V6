'use client'

/**
 * AssistantView — local LLM chat tab (правка 24; multi-chat in правка 30).
 *
 * Runs Gemma 4 12B (GGUF Q4, multimodal) through the ComfyUI embedded python
 * (llama-cpp-python) — see tools/llm_server.py and src/lib/llm-runner.ts.
 * The system prompt is the MiniMax H3 prompt guide (H3_OFFICIAL_PROMPT_SPEC
 * in src/lib/h3-prompt-spec.ts, sourced from src/lib/prompt-guide.md),
 * enriched with live session context (loaded references with their numbers +
 * the current prompt draft), so the assistant can emit correct <Picture N>
 * tags.
 *
 * Chats live in the persisted assistant-chats store: multiple named
 * conversations, the active one is restored on mount, and the model
 * "remembers" a chat because its (capped) history is replayed with every
 * request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  BotIcon,
  SendIcon,
  SquareIcon,
  DownloadIcon,
  ArrowDownToLineIcon,
  SparklesIcon,
  WandSparklesIcon,
  PlusIcon,
  MessageSquareIcon,
  XIcon,
  CopyIcon,
  CheckIcon,
  EyeOffIcon,
  PaperclipIcon,
  FilmIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getClipboardImageFiles, hasClipboardImage } from '@/lib/paste-utils'
import { useGenStore } from '@/lib/gen-store'
import { useAssistantChats, type AssistantChatMessage } from '@/lib/assistant-chats-store'
import {
  useAssistantStream,
  runAssistantCompletion,
  stopAssistantStream,
  stopStreamForChat,
  isStreamActive,
  type LlmStatusResp,
  type ChatAttachment,
} from '@/lib/assistant-stream'
import { uploadChatAttachment } from '@/lib/upload'
import { MentionTagWithPreview } from '@/components/h3/mention-preview'
import { VoiceInputButton } from '@/components/h3/voice-input-button'
import { parseFence, hasH3Field, extractInsertablePrompt } from '@/lib/assistant-fence'
import { MarkdownText } from '@/components/h3/assistant/markdown-text'

/** Live download state derived from /api/models/status. */
interface DlInfo {
  active: boolean
  received: number
  total: number | null
  speed: number
  error: string | null
}

export function AssistantView() {
  /* ── chats (persisted store; hydrated on mount to stay SSR-safe) ── */
  const chats = useAssistantChats((s) => s.chats)
  const [activeId, setActiveId] = useState<string | null>(null)

  const [input, setInput] = useState('')
  const [status, setStatus] = useState<LlmStatusResp | null>(null)
  const [dl, setDl] = useState<DlInfo>({ active: false, received: 0, total: null, speed: 0, error: null })
  // (правка 83) Фактический размер выбранной LLM-модели (из /api/models/status)
  // вместо хардкода «~5.7 ГБ» (у Qwen ~5.7 ГБ, у других квантов — свой размер).
  const [sizeLabel, setSizeLabel] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null)

  /* ── (правка 86) Вложение к сообщению чата (изображение / видео) ── */
  interface ChatAtt {
    file: File
    previewUrl: string
    name: string
    kind: 'image' | 'video'
  }
  const [attachment, setAttachment] = useState<ChatAtt | null>(null)
  const [attUploading, setAttUploading] = useState(false)
  const attFileRef = useRef<HTMLInputElement>(null)

  /* ── In-flight reply (правка 31: движок живёт на уровне модуля) ──
   * Стрим выполняется в src/lib/assistant-stream.ts и переживает
   * размонтирование этой вкладки (AnimatePresence). Здесь только
   * «переподключаемся»: пока ответ идёт в этом чате — рендерим живой
   * хвост; завершённый ответ появляется сам, т.к. сообщения ниже
   * выводятся реактивно из персист-стора чатов. */
  const streamChatId = useAssistantStream((s) => s.chatId)
  const streamText = useAssistantStream((s) => s.text)
  const streaming = streamChatId !== null
  const streamingHere = streamChatId === activeId

  // Live references (for hover previews on <Picture N>/<Video N> tags).
  const refs = useGenStore((s) => s.video.refs)

  // (правка 53) Видение видео ассистентом выключено? — показываем ненавязчивую
  // подсказку рядом с полем ввода, что модель не видит содержимое видео-рефов.
  const [videoVisionOn, setVideoVisionOn] = useState(false)
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.llm_video_vision === 'boolean') setVideoVisionOn(d.llm_video_vision)
      })
      .catch(() => {})
  }, [])

  /** Build a preview URL for a reference by (kind, 1-based index). */
  const previewFor = useCallback(
    (kind: 'image' | 'video', index: number): { url?: string; label?: string } => {
      const list = refs.filter((r) => r.kind === kind)
      const r = list[index - 1]
      if (!r) return {}
      const url =
        r.previewUrl ||
        (r.path ? `/api/comfy/file?filename=${encodeURIComponent(r.path)}&type=input` : undefined)
      return { url, label: r.name }
    },
    [refs],
  )

  /** Copy prompt to clipboard with visual feedback. */
  const copyPrompt = useCallback(
    async (prompt: string, id: string) => {
      try {
        await navigator.clipboard.writeText(prompt)
        setCopiedPrompt(id)
        toast.success('Промпт скопирован')
        setTimeout(() => setCopiedPrompt(null), 2000)
      } catch {
        toast.error('Не удалось скопировать')
      }
    },
    [],
  )

  /**
   * Render chat message content with hover previews on <Picture N>/<Video N>
   * tags (audio excluded). Plain text passes through unchanged. The tags are
   * highlighted the same way as the Learn guide (purple/cyan) so the user
   * can still read them as tags, but hovering now shows the asset preview.
   *
   * If the message contains a ```text / ``` code-fence, everything inside
   * the fence is treated as "the prompt" and rendered with a distinct
   * background so the user can visually separate the LLM's explanation
   * from the actual prompt to copy.
   */
  const renderChatContent = useCallback(
    (rawText: string): React.ReactNode => {
      if (!rawText) return null

      // Fence parsing — единый источник истины: src/lib/assistant-fence.ts
      // (правка 34). Fence в ответе ассистента = «промпт»; текст ПЕРЕД ним
      // (preamble) и ПОСЛЕ закрывающего fence (trailing) рендерится обычным
      // приглушённым текстом. parseFence также ловит только ОТКРЫВАЮЩИЙ
      // fence во время стрима — карточка появляется сразу и заполняется,
      // вместо того чтобы сырой «```text» мелькнул обычным текстом.
      const fence = parseFence(rawText)
      if (fence) {
        const fenceStreaming = fence.streaming
        const prompt = fence.prompt
        // Render preamble (if any) with muted style, then the prompt
        // as a modern code-block: dark bg, monospace, small label.
        // (правка 88) Preamble/trailing и ответы без fence рендерятся как
        // markdown (списки, жирный, заголовки…); сама карточка-промпт
        // остаётся моноширинным plain-текстом с подсветкой тегов.
        const preambleNodes = fence.preamble ? (
          <MarkdownText text={fence.preamble} previewFor={previewFor} />
        ) : null
        const trailingNodes = fence.trailing ? (
          <MarkdownText text={fence.trailing} previewFor={previewFor} />
        ) : null
        return (
          <div className="space-y-3">
            {preambleNodes && (
              <div className="text-[13px] leading-relaxed text-foreground/75">
                {preambleNodes}
              </div>
            )}
            <div className="rounded-xl overflow-hidden border border-violet-500/35 shadow-sm shadow-violet-950/20">
              {/* Header strip with label */}
              <div className="flex items-center justify-between px-3 py-1.5 bg-violet-500/15 border-b border-violet-500/30">
                <div className="flex items-center gap-1.5">
                  {fenceStreaming ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/80 animate-pulse" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80" />
                  )}
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Prompt</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground/70">
                    {fenceStreaming ? 'генерируется…' : `${prompt.length} chars`}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyPrompt(prompt, prompt.slice(0, 40))}
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)] transition-colors"
                    title="Скопировать промпт"
                  >
                    {copiedPrompt === prompt.slice(0, 40) ? (
                      <CheckIcon className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <CopyIcon className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>
              {/* Prompt body */}
              <div className="px-3.5 py-3 bg-violet-500/[0.07] text-[12.5px] leading-relaxed font-mono whitespace-pre-wrap break-words text-foreground/95">
                {renderHighlightedParts(prompt)}
                {fenceStreaming && (
                  <span className="inline-block w-[7px] h-[14px] align-middle ml-0.5 bg-cyan-400/80 animate-pulse" />
                )}
              </div>
            </div>
            {trailingNodes && (
              <div className="text-[13px] leading-relaxed text-foreground/75">
                {trailingNodes}
              </div>
            )}
          </div>
        )
      }

      // No fence — render the whole text as markdown.
      return <MarkdownText text={rawText} previewFor={previewFor} />

      function renderHighlightedParts(text: string): React.ReactNode[] {
        const parts = text.split(/(<(?:Picture|Video|Audio) \d+>|<d>[\s\S]*?<\/d>)/g)
        return parts.map((p, i) => {
          if (!p) return null
          const m = p.match(/^<(Picture|Video) (\d+)>$/)
          if (m) {
            const kind = m[1] === 'Picture' ? 'image' : 'video'
            const index = parseInt(m[2], 10)
            const { url, label } = previewFor(kind, index)
            const cls =
              kind === 'video'
                ? 'bg-cyan-500/15 text-cyan-300'
                : 'bg-purple-500/15 text-purple-300'
            return (
              <MentionTagWithPreview
                key={i}
                triggerText={p}
                previewUrl={url}
                label={label}
                kind={kind}
                className={cn('rounded', cls)}
              />
            )
          }
          if (/^<Audio \d+>$/.test(p)) {
            return (
              <span key={i} className="rounded bg-emerald-500/15 text-emerald-300">
                {p}
              </span>
            )
          }
          if (/^<d>[\s\S]*<\/d>$/.test(p)) {
            return (
              <span key={i} className="rounded bg-amber-500/15 text-amber-300">
                {p}
              </span>
            )
          }
          return <span key={i}>{p}</span>
        })
      }
    },
    [previewFor, copiedPrompt],
  )

  /** Activate the persisted chat (or create one) on first mount only. */
  useEffect(() => {
    const st = useAssistantChats.getState()
    let id = st.activeChatId && st.chats.some((c) => c.id === st.activeChatId)
      ? st.activeChatId
      : (st.chats[0]?.id ?? null)
    if (!id) id = st.createChat()
    setActiveId(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Auto-run a queued "improve prompt" request (правка 32): the user
   * message is appended to the active chat and the completion starts.
   * Правка 32: смена вкладки/чата больше НЕ обрывает идущий ответ — значит
   * при монтировании стрим может ещё жить. runAssistantCompletion() — no-op
   * при running, и запрос завис бы без ответа; поэтому, пока стрим активен,
   * запрос ЖДЁТ в сторе и стартует сразу после его завершения.
   */
  useEffect(() => {
    if (streaming || !activeId) return
    const pending = useAssistantChats.getState().pendingImprove
    if (!pending) return
    const st = useAssistantChats.getState()
    const id = st.chats.some((c) => c.id === activeId) ? activeId : st.createChat()
    if (id !== activeId) setActiveId(id)
    st.clearImprove()
    const userMsg: AssistantChatMessage = { role: 'user', content: pending }
    const history = [...(st.chats.find((c) => c.id === id)?.messages ?? []), userMsg]
    st.appendMessage(id, userMsg)
    runAssistantCompletion(id, history)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, activeId])

  const activeChat = chats.find((c) => c.id === activeId) ?? null
  /** Сообщения выведены РЕАКТИВНО из персист-стора: ответ, закоммиченный
   *  движком, пока мы были на другой вкладке, появляется здесь сам. */
  const messages = activeChat?.messages ?? []
  // Стабильные ключи (index сдвигается при обрезке >200 сообщений и
  // ре-анимирует все пузыри); одинаковые сообщения различаем счётчиком.
  const messageKeys = useMemo(() => {
    const seen = new Map<string, number>()
    return messages.map((m) => {
      const base = `${m.role}-${hashStr(m.content)}-${m.attachment?.path ?? ''}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return n === 0 ? base : `${base}-${n}`
    })
  }, [messages])

  /** Идёт генерация видео — отправка сообщений заблокирована (vram-arbiter). */
  const chatBlocked = status?.blockedByGeneration === true

  // Poll LLM status + download progress
  useEffect(() => {
    let cancelled = false
    // Факт использования ассистента в этой сессии: экран генерации
    // опрашивает /api/llm/status (для блокировки кнопки) только если он был
    sessionStorage.setItem('assistantUsed', '1')
    const tick = async () => {
      try {
        const r = await fetch('/api/llm/status', { signal: AbortSignal.timeout(4000) })
        const s = (await r.json()) as LlmStatusResp
        if (!cancelled) setStatus(s)
        if (s.modelReady) {
          if (!cancelled) setDl((d) => (d.active || d.error ? { active: false, received: 0, total: null, speed: 0, error: null } : d))
          return
        }
        const mr = await fetch('/api/models/status', { signal: AbortSignal.timeout(4000) })
        const md = await mr.json()
        const activeId = s.modelId || 'llm_assistant_qwen'
        const mine = (md.models ?? []).find((m: { id: string; sizeLabel?: string }) => m.id === activeId)
        if (!cancelled && mine) {
          if (mine.sizeLabel) setSizeLabel(mine.sizeLabel)
          if (mine.status === 'downloading') {
            setDl({
              active: true,
              received: mine.bytesReceived ?? 0,
              total: mine.totalBytes ?? null,
              speed: mine.speed ?? 0,
              error: null,
            })
          } else if (mine.status === 'error') {
            setDl({ active: false, received: 0, total: null, speed: 0, error: mine.error || 'Ошибка загрузки' })
          }
        }
      } catch {
        /* backend not up */
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Autoscroll on new content (use rAF to ensure DOM has updated)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [messages, streamText, activeId, status?.modelReady])

  /* ── Авто-растекание textarea (правка 38): до 8 строк, дальше скролл ── */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // text-sm = 14px, line-height ≈ 1.5 → ~21px/line; 8 lines = 168px + 20px padding
    el.style.height = Math.min(el.scrollHeight, 188) + 'px'
  }, [input])

  const clickTs = useRef(0)

  const startDownload = useCallback(async () => {
    clickTs.current = Date.now()
    setDl({ active: true, received: 0, total: null, speed: 0, error: null })
    try {
      const modelId = status?.modelId || 'llm_assistant_qwen'
      const r = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      })
      const d = await r.json()
      if (!d.ok) {
        setDl({ active: false, received: 0, total: null, speed: 0, error: d.error || 'Не удалось начать загрузку' })
        toast.error(d.error || 'Не удалось начать загрузку')
      } else {
        toast.success('Загрузка модели началась')
      }
    } catch {
      setDl({ active: false, received: 0, total: null, speed: 0, error: 'Ошибка запуска загрузки' })
      toast.error('Ошибка запуска загрузки')
    }
  }, [status?.modelId])

  // (правка 86) Обработка выбора файла для вложения
  const handleAttFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const isVideo = file.type.startsWith('video/')
    const isImage = file.type.startsWith('image/')
    if (!isVideo && !isImage) {
      toast.error('Поддерживаются только изображения и видео')
      return
    }
    setAttachment({
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      kind: isVideo ? 'video' : 'image',
    })
    e.target.value = '' // сброс, чтобы повторный выбор того же файла сработал
  }, [])

  const removeAttachment = useCallback(() => {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl)
    setAttachment(null)
  }, [attachment])

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      // chatBlocked: генерация идёт — vram-arbiter всё равно вернёт 409,
      // блокируем заранее (Enter и быстрые кнопки идут в обход disabled)
      if (!content || isStreamActive() || chatBlocked) return
      let id = activeId
      if (!id || !useAssistantChats.getState().chats.some((c) => c.id === id)) {
        id = useAssistantChats.getState().createChat()
        setActiveId(id)
      }

      // (правка 87; правка 108) Загружаем вложение ПЕРВЫМ, чтобы сохранить путь
      // в сообщение. (правка 108) Загрузка в ИЗОЛИРОВАННОЕ хранилище
      // data/chat-attachments/ (НЕ в ComfyUI/input/): файл существует только в
      // чате и используется только для LLM-описания — не попадает в референсы
      // генерации, галерею, upscale и «чистку input».
      let attInfo: { path: string; name: string; kind: 'image' | 'video'; src?: 'chat' | 'comfy' } | undefined
      let atts: ChatAttachment[] | undefined
      if (attachment) {
        setAttUploading(true)
        try {
          const { path } = await uploadChatAttachment(attachment.file)
          attInfo = { path, name: attachment.name, kind: attachment.kind, src: 'chat' }
          atts = [{ path, name: attachment.name, kind: attachment.kind }]
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Не удалось загрузить файл')
          setAttUploading(false)
          removeAttachment()
          return
        }
        setAttUploading(false)
        removeAttachment()
      }

      setInput('')
      const userMsg: AssistantChatMessage = { role: 'user', content, attachment: attInfo }
      // Persist the user message immediately (с вложением для отображения в чате)
      useAssistantChats.getState().appendMessage(id, userMsg)
      const history = [
        ...(useAssistantChats.getState().chats.find((c) => c.id === id)?.messages ?? []),
        userMsg,
      ]

      runAssistantCompletion(id, history, atts)
    },
    [input, activeId, chatBlocked, attachment, removeAttachment],
  )

  const stop = useCallback(() => {
    stopAssistantStream()
  }, [])

  /**
   * Switch to another chat (правка 32: стрим НЕ обрываем).
   * Ответ, который уже летит, продолжает генерироваться в СВОЁМ чате —
   * движок живёт на уровне модуля и переживает смену чата/вкладки.
   * Живой хвост виден только в том чате, где он начался (streamingHere),
   * «Стоп» доступен глобально у поля ввода.
   */
  const switchChat = useCallback(
    (id: string) => {
      useAssistantChats.getState().setActiveChat(id)
      setActiveId(id)
    },
    [],
  )

  /** Новый чат (правка 32: идущий в другом чате ответ не трогаем). */
  const newChat = useCallback(() => {
    const id = useAssistantChats.getState().createChat()
    setActiveId(id)
  }, [])

  const deleteChat = useCallback(
    (id: string) => {
      // Правка 32: если стрим идёт ИМЕННО в удаляемом чате — сначала его
      // останавливаем. Движок докоммитит частичный ответ в finally ПОСЛЕ
      // удаления чата, appendMessage не найдёт чат и молча отбросит —
      // как и надо (мусорный хвост не сохраняется), модель освобождается.
      // Для чужого чата — no-op.
      stopStreamForChat(id)
      const st = useAssistantChats.getState()
      st.deleteChat(id)
      const remaining = useAssistantChats.getState()
      if (id === activeId) {
        const nextId = remaining.activeChatId ?? remaining.createChat()
        setActiveId(nextId)
      }
    },
    [activeId],
  )

  /** Insert an assistant reply into the prompt editor.
   *  Извлечение промпта — единый источник: src/lib/assistant-fence.ts
   *  (правка 34): fence-контент → от маркера H3-поля → последний
   *  содержательный абзац; всегда с обрезкой по закрывающему fence, без
   *  хвоста модели и декоративных кавычек. */
  const insertIntoPrompt = useCallback((content: string) => {
    const clean = extractInsertablePrompt(content)
    if (!clean) return
    useGenStore.getState().setVideoPrompt(clean)
    // (правка 161) Кнопка видна только когда !streaming — стрим завершён.
    // Но серверный assistantBusy может ещё быть true (drain-насос не
    // завершился). GenerateView при монтировании poll'ит /api/llm/status
    // и блокирует «Сгенерировать». Снимаем лок: генерация не мешает
    // LLM (strim уже закончен), реальный gate — 409 от runGeneration.
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-generate'))
    toast.success('Промпт вставлен в редактор')
  }, [])

  /**
   * Does this assistant reply actually contain a structured prompt?
   * The "В промпт" button is rendered ONLY in that case — plain
   * conversational answers (greetings, Q&A, tips) have nothing to insert,
   * and a dead button there only confuses users.
   */
  const hasStructuredPrompt = useCallback((content: string): boolean => {
    if (!content.trim()) return false
    // A ``` code fence (the assistant wraps prompts in one)…
    if (/```/.test(content)) return true
    // …or an official H3 structural field marker.
    return hasH3Field(content)
  }, [])

  const modelReady = status?.modelReady
  const running = status?.running


  // SSR/hydration guard: persisted store (chats) differs between server and
  // first client render. Render a neutral placeholder until mounted.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-1)]">
        <div className="px-6 pt-5 pb-3 shrink-0">
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-amber-500/20">
              <BotIcon className="w-4.5 h-4.5 text-white" />
            </span>
            Ассистент
          </h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-muted-foreground">Загрузка…</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex-1 flex flex-row min-h-0 bg-[var(--surface-1)]"
      onPaste={(e) => {
        // (правка 123) Ctrl+V из буфера обмена — изображение становится
        // вложением чата (то же, что кнопка «скрепка»). Срабатывает при
        // фокусе в любом поле вкладки; text-вставку не трогаем —
        // перехватываем только если в буфере есть картинка.
        // preventDefault синхронно (до await).
        if (!hasClipboardImage(e.clipboardData)) return
        e.preventDefault()
        if (attUploading) {
          toast.error('Дождитесь отправки сообщения — текущее вложение загружается')
          return
        }
        void getClipboardImageFiles(e.clipboardData).then((files) => {
          if (files.length === 0) return
          const file = files[0]
          if (attachment) URL.revokeObjectURL(attachment.previewUrl)
          setAttachment({ file, previewUrl: URL.createObjectURL(file), name: file.name, kind: 'image' })
        })
      }}
    >
      {/* Left: main content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Header */}
      <div className="px-6 pt-5 pb-3 shrink-0 aurora-bg">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-amber-500/20">
                <BotIcon className="w-4.5 h-4.5 text-white" />
              </span>
              Ассистент
            </h1>
            <p className="text-xs text-muted-foreground mt-1.5">
              Локальная LLM (Qwen3.5 9B / Gemma 4 12B) · видит картинки · чаты сохраняются
            </p>
          </div>
          {modelReady && (
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] border',
                  running
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-border bg-[var(--surface-2)] text-muted-foreground',
                )}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full', running ? 'bg-emerald-400' : 'bg-muted-foreground/50')} />
                {running ? (status?.gpuMode === 'gpu' ? 'GPU' : 'CPU') : 'спит'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      {!modelReady ? (
        /* ── Model not downloaded yet ── */
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl gradient-creative flex items-center justify-center mx-auto shadow-lg shadow-amber-500/20">
              <BotIcon className="w-7 h-7 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Модель ассистента не скачана</h3>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                Локальная модель ассистента (Gemma 4 12B или Qwen3.5 9B, квант Q4_K_M, text + vision)
                — скачивается в <span className="font-mono text-[10px]">ComfyUI/models/llm/</span>. Работает
                локально, без интернета, прямо на вашем железе.
              </p>
            </div>
            {dl.error ? (
              <div className="space-y-2">
                <p className="text-xs text-red-400 break-words">Ошибка: {dl.error}</p>
                <Button variant="outline" size="sm" onClick={startDownload} className="gap-1.5">
                  <DownloadIcon className="w-3.5 h-3.5" />
                  Повторить
                </Button>
              </div>
            ) : dl.active ? (
              <div className="space-y-2">
                <div className="h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-all duration-500"
                    style={{
                      width: `${
                        dl.total && dl.total > 0
                          ? Math.min(100, Math.floor((dl.received / dl.total) * 100))
                          : 8
                      }%`,
                    }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground font-mono tabular-nums">
                  {dl.received > 0
                    ? `${(dl.received / 1024 / 1024 / 1024).toFixed(2)} / ${sizeLabel || '~5.7 ГБ'}` +
                      (dl.total && dl.total > 0 ? ` · ${Math.floor((dl.received / dl.total) * 100)}%` : '') +
                      (dl.speed > 0 ? ` · ${(dl.speed / 1024 / 1024).toFixed(1)} МБ/с` : '')
                    : 'Подключение к серверу загрузки…'}
                </p>
              </div>
            ) : (
              <Button
                onClick={startDownload}
                className="bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white border-0 font-semibold gap-2"
              >
                <DownloadIcon className="w-4 h-4" />
                Скачать модель ({sizeLabel || '~5.7 ГБ'})
              </Button>
            )}
            <p className="text-[10px] text-muted-foreground/60">
              После загрузки первый запуск занимает 1–2 минуты. Пока идёт генерация видео,
              модель при нехватке VRAM сама стартует в CPU-режиме.
            </p>
          </div>
        </div>
      ) : (
        /* ── Chat ── */
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-4 min-h-0">
            {messages.length === 0 && (
              <div className="h-full flex items-center justify-center">
                <div className="max-w-md text-center space-y-3">
                  <SparklesIcon className="w-8 h-8 text-amber-400/60 mx-auto" />
                  <p className="text-sm text-muted-foreground">
                    Опишите идею видео по-русски — ассистент соберёт готовый
                    промпт (на английском, с тегами ваших референсов) и запомнит диалог.
                  </p>
                </div>
              </div>
            )}
            <div className="space-y-3 max-w-3xl mx-auto">
              {messages.map((m, i) => (
                <motion.div
                  key={messageKeys[i]}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words',
                      // (правка 88) у ассистента текст рендерится маркдауном —
                      // pre-wrap там не нужен (двойные переносы), у юзера остаётся.
                      m.role === 'user' && 'whitespace-pre-wrap',
                      m.role === 'user'
                        ? 'bg-gradient-to-r from-slate-600/90 to-indigo-600/90 text-white rounded-br-sm'
                        : 'bg-[var(--surface-2)]/60 border border-border/60 text-foreground/95 rounded-bl-sm',
                    )}
                  >
                    {/* (правка 87) Вложение: изображение или видео в пузыре.
                        (правка 108) src='chat' → изолированное хранилище чата
                        (data/chat-attachments/); legacy (без src) → /api/comfy/file. */}
                    {m.attachment && (() => {
                      const attSrc = m.attachment.src === 'chat'
                        ? `/api/assistant/attachment?filename=${encodeURIComponent(m.attachment.path)}`
                        : `/api/comfy/file?filename=${encodeURIComponent(m.attachment.path)}&type=input`
                      return (
                        <div className="mb-2">
                          {m.attachment.kind === 'image' ? (
                            <img
                              src={attSrc}
                              alt={m.attachment.name}
                              className="max-h-48 max-w-full rounded-lg object-contain"
                            />
                          ) : (
                            <video
                              src={attSrc}
                              className="max-h-48 max-w-full rounded-lg"
                              controls
                              preload="metadata"
                            />
                          )}
                          <p className="mt-1 text-[10px] opacity-60">{m.attachment.name}</p>
                        </div>
                      )
                    })()}
                    {renderChatContent(m.content) || ''}
                    {m.role === 'assistant' && !streaming && hasStructuredPrompt(m.content) && (
                      <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => insertIntoPrompt(m.content)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                        >
                          <ArrowDownToLineIcon className="w-3 h-3" />
                          В промпт
                        </button>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
              {streamingHere && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words bg-[var(--surface-2)]/60 border border-border/60 text-foreground/95 rounded-bl-sm">
                    {streamText ? renderChatContent(streamText) : '…'}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Quick actions + input (правка 87: центрировано, max-width) */}
          <div className="shrink-0 border-t border-border px-4 py-3 bg-[var(--surface-0)]/90 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto space-y-2">
            {!streaming && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => {
                    const draft = useGenStore.getState().video.prompt.trim()
                    void send(
                      draft
                        ? `Улучши мой текущий промпт, сохранив смысл. Текущий промпт:\n\n${draft}`
                        : 'Предложи 3 разных идеи для короткого видео (по одной сцене на идею), я выберу и попрошу промпт.',
                    )
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11px] hover:bg-amber-500/20 transition-colors"
                >
                  <WandSparklesIcon className="w-3 h-3" />
                  {useGenStore.getState().video.prompt.trim() ? 'Улучшить мой промпт' : 'Предложить идеи'}
                </button>
              </div>
            )}
            {chatBlocked && (
              <p className="text-[11px] text-muted-foreground px-1">
                ⚙️ Идёт генерация видео — отправка сообщений заблокирована. Дождитесь окончания или остановите генерацию.
              </p>
            )}
            {/* (правка 53) ненавязчивая подсказка: модель не видит содержимое видео-рефов */}
            {!videoVisionOn && (
              <p className="text-[10px] text-muted-foreground/50 px-1 flex items-center gap-1.5 leading-snug">
                <EyeOffIcon className="w-3 h-3 shrink-0 opacity-70" />
                Модель не видит содержимое видео-референсов (экономия контекста) — включается в Настройках → LLM.
              </p>
            )}
            {/* (правка 86) Превью вложения */}
            {attachment && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10">
                {attachment.kind === 'image' ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="w-10 h-10 rounded-md object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-md bg-[var(--surface-3)] flex items-center justify-center shrink-0">
                    <FilmIcon className="w-5 h-5 text-amber-400" />
                  </div>
                )}
                <span className="text-xs text-foreground truncate flex-1 min-w-0">{attachment.name}</span>
                {attUploading ? (
                  <span className="text-[10px] text-amber-400 animate-pulse shrink-0">Загрузка…</span>
                ) : (
                  <button
                    type="button"
                    onClick={removeAttachment}
                    className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                    title="Убрать вложение"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              {/* (правка 86) Кнопка «+» — прикрепить изображение или видео */}
              <button
                type="button"
                onClick={() => attFileRef.current?.click()}
                disabled={streaming || attUploading}
                title="Прикрепить изображение или видео для анализа LLM"
                className={cn(
                  'shrink-0 inline-flex items-center justify-center rounded-xl border transition-colors',
                  'h-11 w-11',
                  'border-border bg-[var(--surface-2)] text-muted-foreground',
                  'hover:text-foreground hover:bg-[var(--surface-3)]',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                <PaperclipIcon className="w-4 h-4" />
              </button>
              <input
                ref={attFileRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={handleAttFile}
              />
              {/* Поле ввода + микрофон (правка 87: центрировано) */}
              <div className="relative flex-1 min-w-0">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      // Кнопка Send disabled во время загрузки вложения —
                      // Enter должен соблюдать тот же guard: иначе текст
                      // уходил БЕЗ вложения, а повторный send (по завершении
                      // загрузки) молча отбрасывался (running=true).
                      if (attUploading) {
                        toast.error('Дождитесь загрузки вложения')
                        return
                      }
                      void send()
                    }
                  }}
                  placeholder="Опишите идею сцены… (Enter — отправить, Shift+Enter — новая строка)"
                  rows={1}
                  className="w-full resize-none rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-2.5 pr-12 text-sm text-foreground placeholder:text-muted-foreground/50 placeholder:text-[11px] placeholder:whitespace-nowrap placeholder:overflow-hidden placeholder:text-ellipsis focus:outline-none focus:ring-1 focus:ring-amber-500/50 min-h-[44px] max-h-[188px] overflow-y-auto"
                />
                {/* (правка 139) Микрофон: явный flex-center контейнер h-11, чтобы кнопка 32px
                    гарантированно стояла ровно по вертикали поля (раньше inline-flex 32px в
                    absolutely-positioned div с top-1/2 визуально «прижимался» к низу) */}
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center">
                  <VoiceInputButton
                    variant="inline"
                    hotkey
                    onText={(t) => {
                      setInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${t}` : t))
                      textareaRef.current?.focus()
                    }}
                  />
                </div>
              </div>
              {streaming ? (
                <Button variant="outline" size="sm" onClick={stop} className="h-11 gap-1.5">
                  <SquareIcon className="w-4 h-4" />
                  Стоп
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => { void send() }}
                  disabled={!input.trim() || chatBlocked || attUploading}
                  title={chatBlocked ? '⚙️ Идёт генерация видео — отправка недоступна' : 'Отправить'}
                  className="h-11 px-4 gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 hover:border-amber-500/50 font-medium shadow-sm shadow-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <SendIcon className="w-4 h-4" />
                  Отправить
                </Button>
              )}
            </div>
          </div>
          </div>
        </>
      )}
      </div>

      {/* Right: chat list sidebar (правка 87) */}
      <div className="w-56 border-l border-border flex flex-col bg-[var(--surface-0)]/60 shrink-0">
        <div className="p-3 border-b border-border">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-xs justify-center"
            onClick={newChat}
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Новый чат
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {chats.map((c) => (
            <div
              key={c.id}
              onClick={() => switchChat(c.id)}
              className={cn(
                'group flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b border-border/40',
                c.id === activeId ? 'bg-amber-500/10' : 'hover:bg-white/5',
              )}
            >
              <MessageSquareIcon
                className={cn('w-3.5 h-3.5 shrink-0', c.id === activeId ? 'text-amber-400' : 'text-muted-foreground/60')}
              />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-foreground truncate">
                  {c.title}
                  {c.id === streamChatId && (
                    <span
                      className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-cyan-400/80 animate-pulse align-middle"
                      title="Ответ генерируется в этом чате"
                    />
                  )}
                </p>
                <p className="text-[9px] text-muted-foreground/60">
                  {c.id === streamChatId
                    ? 'ответ идёт…'
                    : `${c.messages.length} сообщ. · ${new Date(c.updatedAt).toLocaleDateString('ru-RU')}`}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteChat(c.id)
                }}
                className="shrink-0 w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Удалить чат"
              >
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
          {chats.length === 0 && (
            <p className="text-[10px] text-muted-foreground/50 text-center py-6 px-3">
              Нет чатов. Создайте новый.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** Короткий хэш строки (djb2). */
function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
