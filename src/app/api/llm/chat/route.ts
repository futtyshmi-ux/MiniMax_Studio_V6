import { NextRequest } from 'next/server'
import { ensureLlm, LLM_PORT, actualLlmContextSize, activeLlmModelId, llmBackend, noteLlmActivity } from '@/lib/llm-runner'
import { samplingForModel } from '@/lib/llm-sampling'
import { startChat, noteLlmStreaming } from '@/lib/vram-arbiter'
import { getAppConfig } from '@/lib/app-config'
import { prepVideoForLlm, extractVideoFrames } from '@/lib/llm-media'
import { toOpenAiMessages, openAiSseToDelta } from '@/lib/llm-bonsai'
import { LLM_STOP_TOKENS, probeAudioAnswer } from '@/lib/llm-audio-guard'
import { existsSync, mkdirSync, unlinkSync, rmdirSync, readdirSync, statSync } from 'fs'
import path, { join } from 'path'
import sharp from 'sharp'

/* ─── Token estimation & context trimming ─── */

/** Rough token estimate: ~0.4 tokens per character (safe overestimate for mixed RU/EN). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.4)
}

/** Estimate tokens for a message (string or multimodal array). */
function estimateMessageTokens(content: string | unknown[]): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (Array.isArray(content)) {
    let tokens = 0
    for (const part of content) {
      if (typeof part === 'string') {
        tokens += estimateTokens(part)
      } else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (p.type === 'image') {
          // A 512px JPEG ≈ ~256-512 tokens for Gemma vision. Use 384 as midpoint.
          tokens += 384
        } else if (p.type === 'audio') {
          // A 16 kHz WAV clip ≈ 80-150 tokens per second of audio.
          tokens += 256
        } else if (p.type === 'video') {
          // (правка 162/163) Bonsai: video_frames — массив JPEG-кадров (8 fps, 256px, до 48 кадров).
          // Каждый 256px кадр ≈ ~256 vision-токенов; оценка 384 — консервативная.
          if (Array.isArray(p.video_frames)) {
            tokens += (p.video_frames as unknown[]).length * 384
          } else {
            tokens += 15_000
          }
        } else if (p.type === 'text' && typeof p.text === 'string') {
          tokens += estimateTokens(p.text)
        }
      }
    }
    return tokens
  }
  return 0
}

/**
 * True when the message carries multimodal parts (image/video/audio).
 * Such messages must NEVER be trimmed — that silently strips the LLM's
 * view of the attached references (правки 35).
 */
function hasMediaParts(content: string | unknown[]): boolean {
  if (!Array.isArray(content)) return false
  const mediaTypes = new Set(['image', 'video', 'audio'])
  return content.some(
    (p) => typeof p === 'object' && p !== null &&
      typeof (p as { type?: unknown }).type === 'string' && mediaTypes.has((p as { type: string }).type),
  )
}

/**
 * Trim messages from the BEGINNING (oldest first) until total estimated
 * tokens fit within the budget. Always preserves the system message (index 0)
 * and at least the last message. Never drops a media-carrying message.
 */
function trimToContext(
  messages: Array<{ role: string; content: string | unknown[]; images?: string[] }>,
  ctxSize: number,
  outputReserve: number,
): Array<{ role: string; content: string | unknown[]; images?: string[] }> {
  const budget = ctxSize - outputReserve
  if (budget <= 0 || messages.length === 0) return messages

  const totalTokens = () => messages.reduce((sum, m) => sum + estimateMessageTokens(m.content), 0)

  if (totalTokens() <= budget) return messages

  // messages[0] is always the system prompt — never drop it. Its tokens
  // always count against the budget, so the remaining-history check below
  // includes it.
  const sys = messages[0]
  const sysTokens = estimateMessageTokens(sys.content)
  let start = 1
  while (start < messages.length - 1) {
    if (hasMediaParts(messages[start].content)) break
    const remaining = sysTokens + messages
      .slice(start)
      .reduce((sum, m) => sum + estimateMessageTokens(m.content), 0)
    if (remaining <= budget) break
    start++
  }

  // Ensure we don't drop ALL history — always keep at least the last message.
  // System prompt stays at index 0 in ANY case: без него модель теряет весь
  // H3-спек, контекст сессии и правила (и ломается n_keep в llm_server).
  start = Math.min(start, messages.length - 1)
  return [sys, ...messages.slice(start)]
}

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/chat
 * Body: {
 *   messages: [{role, content}],
 *   references?: [{ path: "file.png", trigger: "Picture 1", intent: "identity" }],
 *   chatAttachments?: [{ path, name, kind: 'image'|'video', legacyComfy?: boolean }] — (правка 108)
 *   вложения чата из data/chat-attachments/ (или legacy input/): ТОЛЬКО для
 *   LLM-описания, НЕ ген-рефы — прикрепляются как «Chat N» с запретом тегов.
 *   maxTokens?, temperature?
 * }
 * Lazily starts the local LLM server, then proxies the SSE stream.
 * If references are provided, image files are read and injected as
 * vision content into the first user message.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const messages = body?.messages as Array<{ role: string; content: string | unknown[]; images?: string[] }> | undefined
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'messages required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Cleanup temp vision files (idempotent; called on error paths and at stream end)
    // (правка 162) Папки с кадрами (Bonsai видео-видение) удаляем rmdirSync.
    const tempFiles: string[] = []
    const cleanup = () => { tempFiles.forEach((f) => { try { unlinkSync(f) } catch { try { rmdirSync(f, { recursive: true }) } catch {} } }) }

    // (правка 108) Sweep орфанов: temp-файлы _tmp_vision старше 1 часа — остаток
    // после краха процесса (свой cleanup уже не сработал). Свежие НЕ трогаем
    // (они могут принадлежать активному стриму, завершённому позже).
    const cfg = getAppConfig()
    // (правка 136) Активный бэкенд ассистента: 'standard' (llm_server.py)
    // или 'bonsai' (prism llama-server, OpenAI-протокол).
    const backend = llmBackend()
    try {
      // (правка 108) ВАЖНО: путь берётся из cfg.comfyRoot — реальный корень
      // ComfyUI конфигурируемый (по умолчанию ./ComfyUI-Easy-Install), а не cwd.
      const sweepDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
      const now = Date.now()
      for (const f of readdirSync(sweepDir)) {
        try {
          const st = statSync(join(sweepDir, f))
          if (st.isFile() && now - st.mtimeMs > 3600_000) unlinkSync(join(sweepDir, f))
        } catch { /* файл мог исчезнуть — игнорируем */ }
      }
    } catch { /* папки нет — ок */ }

    // Guard + выгрузка MiniMax (verified) под mutex. Вся подготовка запроса и
    // открытие upstream-соединения происходят ТОЛЬКО под тем же mutex, а
    // счётчик стриминга включается до его освобождения (контракт startChat):
    // с этого момента генерация получает 409 до конца ответа ассистента.
    const gate = await startChat(async () => {
      const started = await ensureLlm()
      if (!started.ok) {
        return { kind: 'start-error' as const, error: started.error ?? 'LLM сервер не отвечает' }
      }

      // Inject references as multimodal CONTENT PARTS (llama-cpp-python 0.3.46
      // mtmd format — the legacy `images` message field is NOT read by this
      // version and would be silently dropped):
      //   {"type":"image"} — sharp-resized JPEG
      //   {"type":"video"} — whole MP4 (≤512px, 8 fps) — the MTMD video helper
      //                      (lazy bitmap, patched into llama_multimodal.py)
      //                      decodes it frame-by-frame during tokenization;
      //                      + optional {"type":"audio"} part for the track
      //   {"type":"audio"} — 16 kHz mono WAV
      const references = body?.references as Array<{
        path: string
        trigger: string
        intent?: string
        kind?: 'image' | 'video' | 'audio'
        includeAudio?: boolean
      }> | undefined
      // ПРАВКА 36: аудио в LLM не отправляется (модель не может его слышать),
      // поэтому hasAudioParts всегда false и аудио-проба (llm-audio-guard) —
      // no-op safety net. Оставлено на случай, если поддержку аудио в LLM
      // вернут: тогда прогон на надёжность снова заработает автоматически.
      let hasAudioParts = false
      if (references?.length) {
        const inputDir = path.join(cfg.comfyRoot, 'ComfyUI', 'input')
        const tmpDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
        mkdirSync(tmpDir, { recursive: true })
        const mediaParts: Array<Record<string, unknown>> = []
        const textParts: string[] = []
        // (правка 53) true, если к запросу прикреплены кадры хотя бы одного видео-рефа
        let videoAttached = false
        const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        for (const ref of references) {
          const absPath = path.join(inputDir, ref.path)
          if (!existsSync(absPath)) {
            // ПРАВКА 36: файл рефа отсутствует на диске — явно сообщаем модели,
            // чтобы она НЕ выдумывала его содержимое. Раньше тихий `continue`
            // давал расхождение: системный промпт реф перечислял, а медиа не
            // было прикреплено → модель конфабулировала (баг #3).
            textParts.push(`[${ref.trigger}] file="${ref.path}" (COULD NOT ATTACH — file not found on disk; do NOT describe, reference, or invent its content; if it matters, ask the user to re-attach it)`)
            continue
          }
          const safeName = ref.path.replace(/[^a-zA-Z0-9.]/g, '_')

          if (ref.kind === 'video') {
            // (правка 53) По умолчанию ассистент НЕ смотрит кадры видео —
            // экономия контекста: модель знает только о НАЛИЧИИ видео-рефа и
            // НЕ описывает/не выдумывает его содержимое. Полное видение включается
            // галочкой «Видение видео ассистентом» в настройках (llm.video_vision).
            if (!cfg.llmVideoVision) {
              textParts.push(
                `[${ref.trigger}] file="${ref.path}" (video reference — its frames are NOT attached: assistant video-vision is OFF. You only know the video EXISTS. Reference it as <Video N> when the user asks to use it; do NOT describe, guess or invent what happens inside it. If the user wants you to "see" the video, tell them to enable «Видение видео ассистентом» in Settings → LLM)`,
              )
              continue
            }
            // (правка 162) Bonsai: целые видео не принимает — извлекаем кадры
            // ffmpeg'ом в JPEG и отправляем как image_url (OpenAI-формат).
            if (backend === 'bonsai') {
              const stamp = uid()
              const framesDir = path.join(tmpDir, `llmvidframes_${stamp}`)
              const frames = await extractVideoFrames(absPath, framesDir)
              if (frames) {
                mediaParts.push({ type: 'video', video_frames: frames })
                videoAttached = true
                tempFiles.push(...frames, framesDir)
                textParts.push(
                  `[${ref.trigger}] file="${ref.path}" (video frames attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference as <Video N> and do NOT invent what is "heard" in it' : ''})`,
                )
              } else {
                textParts.push(`[${ref.trigger}] file="${ref.path}" (video reference — could NOT extract frames to attach, ask user if visual details matter; do NOT describe it as if you saw it)`)
              }
              continue
            }
            // Whole video as ONE {"type":"video"} part: the MTMD video helper
            // (patched into llama_multimodal.py via lazy bitmap) decodes it
            // frame-by-frame during tokenization. We only downscale (≤512px)
            // and cap the rate at 8 fps so the frame count — and hence the
            // vision tokens — stay small.
            //
            // ПРАВКА 36: звуковую дорожку видео НЕ отправляем в LLM — модель
            // НЕ может прослушать аудио (в тестах отвечает «unable to hear»),
            // а старый промпт говорил «ты её слышишь» → выдумывала реплики.
            // Аудио уходит в MiniMax напрямую (ref_video_audio); LLM лишь
            // расставляет <Video N> в тексте промпта.
            const stamp = uid()
            const baseName = ref.path.replace(/[^a-zA-Z0-9]/g, '_')
            const videoOut = path.join(tmpDir, `llmvid_${stamp}_${baseName}.mp4`)
            const audioOut = path.join(tmpDir, `llmvidaud_${stamp}_${baseName}.wav`)
            const prepared = await prepVideoForLlm(absPath, videoOut, audioOut)
            if (prepared) {
              mediaParts.push({ type: 'video', video: prepared.videoPath })
              videoAttached = true
              tempFiles.push(prepared.videoPath)
              if (prepared.audioPath) tempFiles.push(prepared.audioPath) // создаётся для MiniMax, но в LLM не идёт
              textParts.push(
                `[${ref.trigger}] file="${ref.path}" (whole video attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames${ref.includeAudio !== false ? '; it has an audio track for MiniMax — reference as <Video N> and do NOT invent what is "heard" in it' : ''})`,
              )
            } else {
              textParts.push(`[${ref.trigger}] file="${ref.path}" (video reference — could NOT transcode it to attach, ask user if visual details matter; do NOT describe it as if you saw it)`)
            }
            continue
          }

          if (ref.kind === 'audio') {
            // ПРАВКА 36: аудио НЕ отправляем в LLM. Модель НЕ может его
            // прослушать (в тестах: «I'm unable to hear or process the audio»),
            // а старый промпт утверждал «ты их СЛЫШИШЬ» → модель либо отказывала,
            // либо ВЫДУМЫВАЛА содержимое (баги #2 и #3). Аудио уходит в MiniMax
            // как ref_audios напрямую (см. use-video-gen.ts), LLM лишь расставляет
            // <Audio N> в тексте промпта. WAV для LLM не генерируем вообще.
            textParts.push(
              `[${ref.trigger}] file="${ref.path}" (audio reference for MiniMax voice/tone, intent: ${ref.intent || 'voice'} — the model CANNOT hear it; reference it as <Audio N> and do NOT describe or quote its content)`,
            )
            continue
          }

          // Image: resize to max 512px longest side — keeps vision tokens low
          const outPath = path.join(tmpDir, `vision_${uid()}_${safeName}`)
          try {
            await sharp(absPath)
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(outPath)
            mediaParts.push({ type: 'image', image: outPath })
            tempFiles.push(outPath)
          } catch {
            // Fallback: use original (might be slow)
            mediaParts.push({ type: 'image', image: absPath })
          }
          textParts.push(`[${ref.trigger}] file="${ref.path}" (intent: ${ref.intent || 'identity'})`)
        }

        // (правка 53) прикрепляем не только при наличии медиа: textParts могут
        // содержать «tag-only» заметки (видео с выключенным видением, аудио).
        // Раньше такие заметки молча терялись, и модель не знала о рефах.
        if (mediaParts.length > 0 || textParts.length > 0) {
          // Привязываем к ПОСЛЕДНЕМУ user-сообщению (текущий ход), а не к
          // первому (правки 35): модель отвечает именно на последний ход —
          // референсы должны стоять рядом с ним; а trimToContext режет
          // историю с начала, и старое первое сообщение (с медиа) улетало
          // первым — видение тихо терялось в длинных чатах.
          // (правка 53) интро зависит от того, прикреплены ли кадры видео
          const introText = videoAttached
            ? 'Attached references (you can SEE the images and WATCH the video frames; you CANNOT hear the audios — this model has no reliable audio input). Images: describe faces, hair, clothing, colors, distinguishing details — ONLY what is actually visible, do not invent details. Videos: attached as whole short clips (≤512px, 8 fps) — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames. Audios: attached for MiniMax voice/tone ONLY — the model CANNOT hear them, so reference them as <Audio N> and do NOT describe or quote their content.'
            : 'Attached references (you can SEE the attached images — describe faces, hair, clothing, colors, distinguishing details — ONLY what is actually visible, do not invent details; video references are TAGS ONLY — their frames are NOT attached to save context, so you only know they EXIST: use their <Video N> tags when the user asks, and do NOT describe, guess or invent what happens inside them). You CANNOT hear the audios — reference them as <Audio N> and do NOT describe or quote their content.'
          let lastUserIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { lastUserIdx = i; break }
          }
          if (lastUserIdx >= 0) {
            const existingText = typeof messages[lastUserIdx].content === 'string'
              ? messages[lastUserIdx].content
              : ''
            messages[lastUserIdx] = {
              role: 'user',
              // Text part first, media parts in reference order — the chat
              // template renders media markers exactly in part order.
              content: [
                {
                  type: 'text',
                  text: `${introText} ${textParts.join('; ')}. 

${existingText}`,
                },
                ...mediaParts,
              ],
            }
          }
        }
      }

      // (правка 108) Вложения чата — ИЗОЛИРОВАНЫ от референсов генерации.
      // Файлы лежат в data/chat-attachments/ (новое хранилище) или legacy
      // ComfyUI/input/ (правки 86–87, legacyComfy). Они нужны ТОЛЬКО для
      // LLM-описания/анализа:
      //   • прикрепляются к LLM как «Chat N» (НЕ «Picture N»/«Video N»);
      //   • модели явно запрещено использовать их как <Picture N>/<Video N> в
      //     промпте — они НЕ являются ген-референсами (MiniMax не должен их
      //     подтягивать из input/ в генерацию);
      //   • видео-вложения ВСЕГДА прикрепляются как кадры (пользователь явно
      //     приложил их в чат ради описания) — НЕ зависят от llmVideoVision
      //     (тот флаг управляет только видео-реферами генерации).
      const chatAttachments = body?.chatAttachments as Array<{
        path: string
        name?: string
        kind: 'image' | 'video'
        legacyComfy?: boolean
      }> | undefined
      if (chatAttachments?.length) {
        const attachDir = path.resolve(process.cwd(), 'data', 'chat-attachments')
        const caInputDir = path.join(cfg.comfyRoot, 'ComfyUI', 'input')
        const caTmpDir = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'llm', '_tmp_vision')
        mkdirSync(caTmpDir, { recursive: true })
        const caMediaParts: Array<Record<string, unknown>> = []
        const caTextParts: string[] = []
        const caUid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        let caNum = 0
        for (const att of chatAttachments) {
          caNum++
          // (правка 117) att.path — имя файла в хранилище вложений АС-ЕСТЬ.
          // Эндпоинт загрузки уже генерирует безопасное имя из basename
          // оригинала (например mtyx1rqu-j776gm-photo.jpg — С ДЕФИСАМИ).
          // Раньше мы повторно «обезвреживали» имя
          // (replace(/[^a-zA-Z0-9.]/g, '_')), и дефисы превращались в
          // подчёркивания → файл «не находился» у КАЖДОГО нового вложения
          // (модель получала COULD NOT ATTACH). Теперь берём basename как есть
          // (traversal-безопасно: разделителей в имени нет по построению).
          const attName = String(att.path).split(/[\\/]/).pop() || ''
          const safeName = (attName || 'attachment').replace(/[^a-zA-Z0-9.]/g, '_')
          const absPath = att.legacyComfy
            ? path.join(caInputDir, att.path)
            : attName && attName !== '.' && attName !== '..'
              ? path.resolve(attachDir, attName)
              : null
          const missing =
            !absPath ||
            (att.legacyComfy ? !existsSync(absPath) : !absPath.startsWith(attachDir) || !existsSync(absPath))
          if (missing) {
            caTextParts.push(
              `[Chat ${caNum}] file="${att.path}" (COULD NOT ATTACH — file not found in the chat-attachments store; do NOT describe or invent its content; ask the user to re-attach it)`,
            )
            continue
          }
          if (att.kind === 'video') {
            // (правка 162) Bonsai: извлекаем кадры → отправляем как картинки.
            if (backend === 'bonsai') {
              const stamp = caUid()
              const framesDir = path.join(caTmpDir, `llmvidcaframes_${stamp}`)
              const frames = await extractVideoFrames(absPath, framesDir)
              if (frames) {
                caMediaParts.push({ type: 'video', video_frames: frames })
                tempFiles.push(...frames, framesDir)
                caTextParts.push(
                  `[Chat ${caNum}] file="${att.path}" (chat video frames attached — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames, do NOT invent details; it is NOT a generation reference: NEVER reference it as <Video N> in the prompt)`,
                )
              } else {
                caTextParts.push(
                  `[Chat ${caNum}] file="${att.path}" (chat video — could NOT extract frames to attach; ask the user if visual details matter; do NOT describe it as if you saw it; it is NOT a generation reference)`,
                )
              }
              continue
            }
            // (правка 108) видео-вложение чата ВСЕГДА как кадры (не зависит
            // от llmVideoVision — он только для ген-рефов).
            const stamp = caUid()
            const videoOut = path.join(caTmpDir, `llmvidca_${stamp}_${safeName}.mp4`)
            const audioOut = path.join(caTmpDir, `llmvidaudca_${stamp}_${safeName}.wav`)
            const prepared = await prepVideoForLlm(absPath, videoOut, audioOut)
            if (prepared) {
              caMediaParts.push({ type: 'video', video: prepared.videoPath })
              tempFiles.push(prepared.videoPath)
              if (prepared.audioPath) tempFiles.push(prepared.audioPath)
              caTextParts.push(
                `[Chat ${caNum}] file="${att.path}" (chat video attached as frames — describe the scene, motion and camera behaviour over time, ONLY what is actually in the frames, do NOT invent details; it is NOT a generation reference: NEVER reference it as <Video N> in the prompt)`,
              )
            } else {
              caTextParts.push(
                `[Chat ${caNum}] file="${att.path}" (chat video — could NOT transcode it to attach; ask the user if visual details matter; do NOT describe it as if you saw it; it is NOT a generation reference)`,
              )
            }
            continue
          }
          // Image: resize to max 512px longest side — keeps vision tokens low
          const outPath = path.join(caTmpDir, `visionca_${caUid()}_${safeName}`)
          try {
            await sharp(absPath)
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toFile(outPath)
            caMediaParts.push({ type: 'image', image: outPath })
            tempFiles.push(outPath)
          } catch {
            // Fallback: use original (might be slow)
            caMediaParts.push({ type: 'image', image: absPath })
          }
          caTextParts.push(
            `[Chat ${caNum}] file="${att.path}" (chat attachment — attached ONLY for your description/analysis; it is NOT a generation reference: NEVER reference it as <Picture N>, <Video N> or <Audio N> in the prompt)`,
          )
        }
        if (caTextParts.length > 0) {
          // (правка 108) Прикрепляем к ТОМУ ЖЕ последнему user-сообщению (текущий
          // ход) — модель отвечает именно на него; trimToContext не режет
          // медиа-сообщения, а история режется с начала (правки 35, 53, 108).
          const caIntro =
            'CHAT ATTACHMENTS (isolated from generation references — they exist ONLY in this chat and are used ONLY for your description/analysis; they are NOT <Picture N>/<Video N>/<Audio N> — do NOT reference them as such in any prompt):'
          let caLastIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { caLastIdx = i; break }
          }
          if (caLastIdx >= 0) {
            const existing = messages[caLastIdx].content
            const existingText = typeof existing === 'string'
              ? existing
              : (Array.isArray(existing)
                  ? (existing as Array<{ type?: string; text?: string }>)
                      .filter((p) => p && typeof p.text === 'string')
                      .map((p) => p.text)
                      .join(' ')
                  : '')
            const existingMedia = Array.isArray(existing)
              ? (existing as Array<Record<string, unknown>>) : []
            messages[caLastIdx] = {
              role: 'user',
              // Текст первыми, затем медиа в порядке «Chat N» — шаблон чата
              // рендерит маркеры строго в порядке частей.
              content: [
                { type: 'text', text: `${caIntro} ${caTextParts.join('; ')}.\n\n${existingText}` },
                ...existingMedia,
                ...caMediaParts,
              ],
            }
          }
        }
      }

      // Автозаполнение остатка контекста, но не больше ручной настройки
      // [llm] max_output_tokens (UI «Max output tokens»). Floor: 256 токенов
      // (минимально полезный ответ даже при почти полном контексте).
      // ВАЖНО: считаем вход по УЖЕ обрезанной истории — иначе в длинном чате
      // необрезанный объём прижимал maxTokens к floor 256, и ответы
      // обрубались даже там, где трим освобождал кучу контекста.
      const ctxSize = actualLlmContextSize()
      const preTrimmed = trimToContext(messages, ctxSize, cfg.llmMaxOutputTokens)
      const inputTokens = preTrimmed.reduce((sum, m) => sum + estimateMessageTokens(m.content), 0)
      const maxTokens = Math.max(256, Math.min(cfg.llmMaxOutputTokens, ctxSize - inputTokens - 128))
      const trimmed = trimToContext(messages, ctxSize, maxTokens)

      // (правка 135) Тонкая настройка сэмплинга: набор подбирается под
      // семейство АКТИВНОЙ модели (Gemma 4 12B vs Qwen3.5 9B) — см.
      // src/lib/llm-sampling.ts. До этой правки в llm_server уходил только
      // temperature, а top_p/top_k/min_p/penalty шли дефолтами llama-cpp
      // (top_k=40, top_p=0.95, min_p=0.05), что хуже под наши модели →
      // периодическое зацикливание и дегенерация thought-канала.
      // Приоритет — стабильность (меньше глючей), а не креативность.
      const sampling = body.sampling ?? samplingForModel(activeLlmModelId())

      // Аудио-надёжность (без Whisper): модель нестабильна на «сыром» аудио —
      // часть прогонов дегенерирует в зацикливание (<|channel>thought × N и
      // повтор одной фразы × N). Если в запросе есть аудио — делаем короткий
      // не-стриминговый прогон (~48 токенов) с возрастающей температурой и
      // берём первый НЕ-дегенеративный: его температура пойдёт в основной
      // ответ. Stop-токены (LLM_STOP_TOKENS) в любом случае обрезают
      // thought-канал на лету. Проба не падает ассистента: любой сбой —
      // продолжаем с исходной температурой.
      let finalTemperature = body.temperature ?? sampling.temperature
      if (hasAudioParts) {
        try {
          const probe = await probeAudioAnswer({
            baseUrl: `http://127.0.0.1:${LLM_PORT}`,
            messages: trimmed,
            baseTemperature: finalTemperature,
            sampling, // (правка 135) — проба идёт с тем же top_p/top_k/penalty, что и основной ответ
            log: (m) => console.log('[llm] audio-probe:', m),
          })
          finalTemperature = probe.temperature
          console.log('[llm] audio-probe:', probe.note)
        } catch (e) {
          console.warn('[llm] audio-probe failed, continuing:', e)
        }
      }

      // Таймаут только на установку соединения (см. комментарий у fetch).
      const headerTimeout = {
        controller: new AbortController(),
        timer: setTimeout(() => headerTimeout.controller.abort(), 120_000),
      }
      // (правка 136) Bonsai-бэкенд: OpenAI /v1/chat/completions + конвертация
      // медиа-частей в data-URI, ответ заворачивается в наш SSE-формат.
      noteLlmActivity()
      let upstream: Response
      let upstreamBody: ReadableStream<Uint8Array> | null = null
      if (backend === 'bonsai') {
        const oaiMessages = await toOpenAiMessages(trimmed)
        upstream = await fetch(`http://127.0.0.1:${LLM_PORT}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: oaiMessages,
            max_tokens: maxTokens,
            stream: true,
            // (фикс) Выключаем «думание» на уровне ШАБЛОНА — флаг запуска
            // --reasoning-budget 0 у форка не работает, и с включённым
            // thinking ответы деградировали (уезжали не на ту тему, а при
            // малых max_tokens не успевали родиться вовсе — finish:length
            // внутри reasoning). enable_thinking=false — параметр шаблона
            // Qwen-семейства: <think> закрывается сразу, отвечает мгновенно.
            chat_template_kwargs: { enable_thinking: false },
            temperature: finalTemperature,
            top_p: sampling.top_p,
            top_k: sampling.top_k,
            min_p: sampling.min_p,
            presence_penalty: sampling.presence_penalty,
            frequency_penalty: sampling.frequency_penalty,
            repeat_penalty: sampling.repeat_penalty,
            // stop-токены НЕ шлём: <|channel|> — специфичный маркер Qwen3.5,
            // для Bonsai-шаблона не нужен (EOS обрабатывает llama-server).
          }),
          signal: headerTimeout.controller.signal,
        })
        if (upstream.ok && upstream.body) {
          upstreamBody = openAiSseToDelta(upstream.body)
        }
      } else {
        upstream = await fetch(`http://127.0.0.1:${LLM_PORT}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: trimmed,
            max_tokens: maxTokens,
            // (правка 135) — передаём весь набор сэмплинга; llm_server.py читает
            // каждый ключ и передаёт в llama-cpp-python create_chat_completion.
            temperature: finalTemperature,
            top_p: sampling.top_p,
            top_k: sampling.top_k,
            min_p: sampling.min_p,
            presence_penalty: sampling.presence_penalty,
            frequency_penalty: sampling.frequency_penalty,
            repeat_penalty: sampling.repeat_penalty,
            stop: LLM_STOP_TOKENS,
          }),
          // Страховка от зависшего llm_server: таймаут действует ТОЛЬКО на
          // установку соединения (заголовки SSE приходят сразу, поэтому в норме
          // fetch разрешается за миллисекунды). Как только ответ получен,
          // таймер снимается — AbortSignal.timeout здесь нельзя: он абортирует
          // и body-стрим, обрывая любой ответ длиннее 2 минут. От зависания
          // самого стрима защищает idle-watchdog ниже.
          signal: headerTimeout.controller.signal,
        })
        if (upstream.ok && upstream.body) {
          upstreamBody = upstream.body
        }
      }
      clearTimeout(headerTimeout.timer)
      if (!upstream.ok || !upstreamBody) {
        const errText = await upstream.text().catch(() => '')
        cleanup()
        return { kind: 'upstream-error' as const, error: `LLM error: ${errText || upstream.status}` }
      }
      // Счётчик стриминга включается под mutex (контракт startChat): с этого
      // момента и до конца ответа генерация получает 409.
      noteLlmStreaming(1)
      return { kind: 'ok' as const, body: upstreamBody }
    })

    if (!gate.ok) {
      cleanup()
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const v = gate.result
    if (v.kind === 'start-error') {
      cleanup()
      return new Response(JSON.stringify({ error: v.error }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (v.kind === 'upstream-error') {
      return new Response(JSON.stringify({ error: v.error }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Виден в catch ниже (переменные try-блока там не в скоупе).
    let finishRef: (() => void) | null = null

    // Проксируем SSE вручную (reader → writer): во-первых, сервер ЗНАЕТ момент
    // конца ответа (включая обрыв соединения) и снимает блокировку генерации;
    // во-вторых, idle-сторож прерывает ЗАВИСШИЙ стрим — иначе счётчик
    // стриминга завис бы навсегда и генерация навечно получила бы 409.
    // temp-файлы: safety net. 60 с мало — ленивое декодирование видео и
    // сама генерация идут ПОСЛЕ старта стрима и могут длиться минутами;
    // normally finish() чистит файлы сразу по концу ответа.
    // 15 минут = граница finishWatchdog: temp-файлы удаляются не раньше,
    // чем стрим гарантированно завершён (при 10 мин живой стрим мог
    // остаться без своих видео-файлов в разгар ленивой токенизации).
    const safetyTimer = setTimeout(cleanup, 15 * 60_000)
    // (правка 110) Сторож finish(): если drain-насос завис (зависший
    // writer.write/close на half-open сокете клиента), finish() из finally
    // никогда бы не выполнился и счётчик стриминга держал блокировку генерации
    // ВЕЧНО (кнопка 409 навсегда). Здорогому стриму не жить 15 минут —
    // idle-сторож прерывает LLM после 5 мин тишины.
    let finishWatchdog: ReturnType<typeof setTimeout> | null = null
    try {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const reader = v.body.getReader()
      const writer = writable.getWriter()

      // Правка 31: чтение модели и подача клиенту ДЕКОУПЛЕНЫ через буфер.
      // Старый насос был последовательным (read → await writer.write): медленный
      // клиент (фоновая вкладка) создавал back-pressure на llm_server, и
      // idle-сторож мог сработать из-за «клиент не читает», а не из-за
      // зависшей модели. Теперь: upstream-цикл только читает модель в буфер,
      // drain-цикл только кормит клиента — ни один не ждёт другого.
      const buffer: Uint8Array[] = []
      let bufferedBytes = 0
      let upstreamDone = false
      let upstreamFailed = false
      let clientGone = false
      const MAX_BUFFERED = 8 * 1024 * 1024 // не копим в памяти больше 8 МБ

      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const armIdleWatchdog = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          console.log('[llm] стрим завис (нет данных 5 мин) — прерываю')
          upstreamFailed = true
          void reader.cancel().catch(() => {})
        }, 5 * 60_000)
      }

      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (idleTimer) clearTimeout(idleTimer)
        clearTimeout(safetyTimer)
        if (finishWatchdog) clearTimeout(finishWatchdog) // (правка 110)
        noteLlmStreaming(-1)
        cleanup()
      }
      finishRef = finish

      // (правка 110) Форсируем finish() даже если drain-цикл завис навсегда.
      finishWatchdog = setTimeout(() => {
        if (!finished) {
          console.warn('[llm] (правка 110) finish-сторож: 15 мин без finish() — форсирую снятие блокировки')
          finish()
        }
      }, 15 * 60_000)

      // Upstream: читаем модель в буфер независимо от клиента. Если клиент
      // сильно отстал — ждём, пока буфер стечёт (back-pressure на модель, а
      // не на вкладку).
      void (async () => {
        try {
          armIdleWatchdog()
          for (;;) {
            if (clientGone) break
            const { done, value } = await reader.read()
            if (done) break
            armIdleWatchdog()
            buffer.push(value)
            bufferedBytes += value.length
            while (bufferedBytes > MAX_BUFFERED && !clientGone) {
              // Медленный клиент ≠ зависшая модель: перезапускаем idle-сторож,
              // иначе 8 МБ буфера, стекающие дольше 5 мин, ложно убивали
              // здоровый стрим.
              armIdleWatchdog()
              await new Promise((r) => setTimeout(r, 20))
            }
          }
          upstreamDone = true
        } catch {
          upstreamFailed = true
        }
      })()

      // Drain: кормим клиента, пока буфер не опустеет и upstream не завершён.
      void (async () => {
        try {
          for (;;) {
            const chunk = buffer.shift()
            if (chunk) {
              bufferedBytes -= chunk.length
              await writer.write(chunk)
              continue
            }
            if (upstreamDone || upstreamFailed || clientGone) break
            await new Promise((r) => setTimeout(r, 10))
          }
          if (upstreamFailed && !clientGone) {
            try { await writer.abort() } catch { /* уже закрыт */ }
          } else if (!clientGone) {
            try { await writer.close() } catch { /* уже закрыт */ }
          }
        } catch {
          // клиент отключился (вкладка закрыта, сеть) — останавливаем и чтение
          // upstream, чтобы не держать соединение с llm_server
          clientGone = true
          void reader.cancel().catch(() => {})
        } finally {
          finish()
        }
      })()

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    } catch (err) {
      // Гатчина между «стрим начат» и «насос запущен»: снимаем счётчик и
      // перебрасываем во внешний catch (500), не оставляя блокировку.
      // Через finish() — он идемпотентен (guard `finished`); прямой
      // noteLlmStreaming(-1) здесь дал бы двойное декрементирование, если
      // насосы уже успели запланировать свой finish().
      if (finishRef) {
        finishRef()
      } else {
        // throw случился до создания finish — сырой откат
        noteLlmStreaming(-1)
        cleanup()
        clearTimeout(safetyTimer)
        if (finishWatchdog) clearTimeout(finishWatchdog) // (правка 110)
      }
      throw err
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
