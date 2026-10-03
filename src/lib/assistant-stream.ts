'use client'

/**
 * Assistant stream engine (правка 31) — lives at MODULE scope, NOT in a
 * component, so an in-flight LLM reply SURVIVES AssistantView unmount.
 *
 * Why this exists: switching app tabs unmounts AssistantView (page.tsx uses
 * AnimatePresence). Previously the SSE read loop was a fire-and-forget
 * closure inside the component (`void runCompletion(...)`): after unmount its
 * state updates no-oped, its only strong references were gone, and the
 * re-mounted view never reattached to the in-flight stream — so the model
 * answered "into the void" and the user had to resend.
 *
 * Now:
 *  • the async fetch/reader loop runs here, at module level, and completes
 *    regardless of component lifecycle;
 *  • on completion the reply is committed to the persisted chats store —
 *    a (re)mounted view renders it because it derives messages from the
 *    store reactively;
 *  • while streaming, any mounted view reattaches by subscribing to the
 *    tiny `useAssistantStream` store below and renders the live tail.
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { useAssistantChats, type AssistantChatMessage } from './assistant-chats-store'
import { useGenStore } from './gen-store'
import { H3_OFFICIAL_PROMPT_SPEC } from './h3-prompt-spec'

export interface LlmStatusResp {
  running: boolean
  starting: boolean
  gpuMode: 'gpu' | 'cpu' | null
  modelReady: boolean
  /** Активный ID модели LLM (зависит от выбранной квантизации). */
  modelId: string
  /** Ассистент сейчас стримит ответ (для блокировки генерации). */
  streaming: boolean
  /** Ассистент занят (грузится или отвечает). */
  assistantBusy: boolean
  /** Идёт генерация видео — чат заблокирован. */
  blockedByGeneration: boolean
}

/** Pre-cap on the wire; server does precise token-based trimming. */
const HISTORY_LIMIT = 60

/** System prompt: compact OFFICIAL H3 spec + live session context.
 * (правка 53) `videoVisionOn` — видит ли ассистент кадры видео-рефов (настройка
 * «Видение видео ассистентом», выкл по умолчанию). Без этого флага промпт
 * говорил модели «ты ВИДИШЬ кадры», хотя кадры не прикреплялись → выдумка.
 * (правка 150) Ассистент видит ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ (t2v/flf/ref) из gen-store
 * и строит system-промпт с учётом режима: в t2v/flf запрещает метки <Picture N>,
 * <Video N>, <Subject N> (нода MiniMaxH3ReferenceToVideo не используется),
 * <Audio N> остаётся разрешённым для аудио-референсов. */
function buildSystemMessage(videoVisionOn: boolean, chatMessageCount = 0): string {
  const v = useGenStore.getState().video
  const mode = v.mode // (правка 150) 'ref' | 't2v' | 'flf'
  const refs = v.refs
  // (правка 138) дефолт 124 → 60: минимум 2.5 с (60 кадров при 24 fps)
  const seconds = Math.max(2.5, Math.round((v.videoLength || 60) / 24))

  // (правка 150) В t2v/flf из рефов уходят ТОЛЬКО аудио (картинки/видео не используются нодой).
  // Ассистенту показываем только аудио-рефы, чтобы LLM не вписывала <Picture N>/<Video N>.
  // (правка 166) В НОВОМ чате (0–1 сообщение) НЕ показываем черновик промпта из формы
  // генерации и НЕ используем глобальные рефы/кадры из gen-store — это убирает
  // «перекрёстное поминание» между чатами: модель не видит чужой сессионный
  // контекст, если он не относится к этому чату.
  const isFreshChat = chatMessageCount <= 1
  const effectiveRefs = isFreshChat
    ? []
    : mode === 'ref' ? refs : refs.filter((r) => r.kind === 'audio')

  const images = effectiveRefs.filter((r) => r.kind === 'image')
  const videos = effectiveRefs.filter((r) => r.kind === 'video')
  const audios = effectiveRefs.filter((r) => r.kind === 'audio')

  // ── Explicit "attached references" block, numbered exactly like MiniMax ──
  // (images → <Picture N>, videos → <Video N>, audios → <Audio N>, each 1-based
  //  within its type — this is what MiniMax's ref_images/ref_videos/ref_audios expect)
  let attachedBlock: string

  // (правка 150) Режим-специфичный префикс для system-промпта
  const modeHint = mode === 't2v'
    ? '⚠️ ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ: «Текст» (t2v). Метки <Picture N>, <Video N>, <Subject N> ЗАПРЕЩЕНЫ — референсы картинок и видео не используются. <Audio N> ДОПУСКАЕТСЯ ТОЛЬКО если аудио-рефы прикреплены ниже. Формат — FORMAT A.'
    : mode === 'flf'
      ? '⚠️ ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ: «Кадры» (flf, первый/последний кадр → видео). Метки <Picture N>, <Video N>, <Subject N> ЗАПРЕЩЕНЫ — кадры задаются полями формы, не референсами. <Audio N> ДОПУСКАЕТСЯ ТОЛЬКО если аудио-рефы прикреплены ниже. Формат — FORMAT A. Описывай движение/переход между первым и последним кадрами.'
      : '⚠️ ТЕКУЩИЙ РЕЖИМ ГЕНЕРАЦИИ: «Референсы» (ref, Ref2VA).'

  // (правка 151) В flf-режиме кадры (startFrame/endFrame) — это НЕ refs, но они
  // прикреплены к LLM как изображения. Поэтому условие «нет референсов» должно
  // учитывать кадры: если есть кадры или аудио → идём в ветку flf, не в «нет».
  // (правка 166) В новом чате кадры из формы не считаем (см. isFreshChat выше).
  const hasFlfFrames = !isFreshChat && mode === 'flf' && (!!v.startFrame?.path || !!v.endFrame?.path)

  if (effectiveRefs.length === 0 && !hasFlfFrames) {
    attachedBlock =
      modeHint + '\n' +
      'Прикреплённых референсов НЕТ → это FORMAT A (text-to-video).\n' +
      'ЗАПРЕЩЕНО использовать любые метки <Picture N>, <Video N>, <Audio N>, <Subject N>.'
  } else if (mode === 'ref') {
    const lines: string[] = []
    // (правка 137) ЖЁСТКИЙ режим: референсы прикреплены → ТОЛЬКО FORMAT B
    // с метками. Модели регулярно «забывали» про референсы и выдавали
    // text-to-video промпт без единого тега — теперь это явно запрещено.
    lines.push('⚠️ РЕЖИМ ГЕНЕРАЦИИ: прикреплены РЕФЕРЕНСЫ → промпт ТОЛЬКО в FORMAT B (Ref2VA).')
    lines.push('ЗАПРЕЩЕНО выдавать FORMAT A (text-to-video) или промпт без меток, когда референсы прикреплены.')
    lines.push('Первое поле fence — subject_definitions (НЕ integrated_multimodal_description).')
    lines.push('Каждое ПРИКРЕПЛЁННОЕ ИЗОБРАЖЕНИЕ обязано попасть в промпт своей меткой <Picture N>: создай <Subject N> в subject_definitions, привяжи к <Picture N> и упомяни в описании кадра.')
    lines.push('<Video N> — проставь метку, если в кадре используется движение/сцена из видео-референса; <Audio N> — если голос/звучание из аудио-референса (реплики персонажа — через него).')
    lines.push('ПРОМПТ БЕЗ ЕДИНОЙ МЕТКИ РЕФЕРЕНСА при прикреплённых референсах = ОШИБКА. Перед выдачей проверь: каждая метка из списка ниже присутствует в промпте (или осознанно объяснено, почему референс не используется).')
    lines.push('')
    if (images.length) {
      lines.push('ИЗОБРАЖЕНИЯ — ты их ВИДИШЬ и описываешь по факту того, что на них:')
      images.forEach((r, i) => {
        lines.push(`  <Picture ${i + 1}> = ${r.name}${r.imageIntent ? ` (используется как: ${r.imageIntent})` : ''}`)
      })
    }
    if (videos.length) {
      if (videoVisionOn) {
        lines.push('ВИДЕО — ты ВИДИШЬ их КАДРЫ (видео прикреплено полностью, в уменьшенном разрешении):')
        videos.forEach((r, i) => lines.push(`  <Video ${i + 1}> = ${r.name}${r.includeAudio ? ' (есть звуковая дорожка — модель её НЕ слышит, см. правило по АУДИО)' : ''}`))
        lines.push('  Описывай по факту видео: сцену, персонажей, ДВИЖЕНИЕ и поведение камеры по ходу ролика, а не только первый кадр. Не выдумывай деталей, которых нет в кадре.')
      } else {
        // (правка 53) видение видео выключено: кадры НЕ прикреплены — модель
        // знает только о НАЛИЧИИ видео. Строго запрещаем описывать/выдумывать.
        lines.push('ВИДЕО — прикреплены ТОЛЬКО как теги (кадры НЕ прикреплены: видение видео ассистентом выключено, экономия контекста):')
        videos.forEach((r, i) => lines.push(`  <Video ${i + 1}> = ${r.name}${r.includeAudio ? ' (есть звуковая дорожка — модель её НЕ слышит, см. правило по АУДИО)' : ''}`))
        lines.push('  Ссылайся на <Video N> как на тег, когда пользователь просит (например, «motion from <Video 1>»). НЕ описывай, НЕ угадывай и НЕ выдумывай, что происходит внутри видео — ты его НЕ видишь.')
      }
    }
    if (audios.length) {
      lines.push('АУДИО — прикреплены как референсы ГОЛОСА/звучания для MiniMax (ref_audios). Модель НЕ МОЖЕТ их прослушать и НЕ знает, какие там реплики:')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}${r.audioIntent ? ` (${r.audioIntent})` : ''}`))
      lines.push('  В промпте ссылайся на <Audio N> как на референс голоса/звучания (MiniMax сам использует файл). Конкретную реплику бери ТОЛЬКО из текста запроса пользователя — не выдумывай то, что «слышно» в аудио.')
    }
    const forbidden: string[] = []
    if (!videos.length) forbidden.push('<Video N>')
    if (!audios.length) forbidden.push('<Audio N>')
    lines.push('')
    if (forbidden.length) {
      lines.push(`⚠️ ПРАВИЛО: в промпте ДОПУСКАЮТСЯ ТОЛЬКО метки из списка выше. Запрещено использовать ${forbidden.join(', ')} — таких референсов в этой сессии НЕТ, не выдумывай их.`)
    } else {
      lines.push('⚠️ ПРАВИЛО: в промпте используй ТОЛЬКО те метки, которые перечислены выше (например, если есть только <Audio 1> — пиши <Audio 1>, а не <Audio 2>).')
    }
    if (!audios.length) lines.push('Голоса и реплики пиши в <d>...</d> БЕЗ привязки к <Audio N> (аудио не прикреплено). Не описывай голос как «referenced from <Audio N>» / «voice timbre from <Audio N>» — просто укажи тон/пол/возраст словами.')
    if (!videos.length) lines.push('Движение и камеру описывай словами, а не как «from <Video N>» (видео не прикреплено).')
    attachedBlock = lines.join('\n')
  } else if (mode === 'flf') {
    // (правка 151) Режим «Кадры»: кадры (startFrame/endFrame) прикреплены как image-рефы —
    // LLM их ВИДИТ и описывает словами. <Picture N> ЗАПРЕЩЁН (кадры не являются ref2va-рефами).
    // Аудио-рефы также уходят (через MiniMaxH3AddGuide) — <Audio N> допустим.
    const lines: string[] = [modeHint, '']

    // (правка 151) Показываем кадры как «видимые изображения» (они прикреплены к LLM)
    const hasStartFrame = !!v.startFrame?.path
    const hasEndFrame = !!v.endFrame?.path
    if (hasStartFrame || hasEndFrame) {
      lines.push('КАДРЫ (прикреплены как изображения — ты их ВИДИШЬ):')
      if (hasStartFrame) {
        lines.push(`  ПЕРВЫЙ КАДР = ${v.startFrame!.name} — это стартовая точка видео. Опиши его содержимое словами (сцену, персонажей, композицию, освещение).`)
      }
      if (hasEndFrame) {
        lines.push(`  ПОСЛЕДНИЙ КАДР = ${v.endFrame!.name} — это финальная точка видео. Опиши его содержимое словами.`)
      }
      lines.push('  ⚠️ ЗАПРЕЩЕНО использовать метку <Picture N> для этих кадров — они НЕ являются ref2va-референсами.')
      lines.push('  В промпте описывай движение/переход МЕЖДУ первым и последним кадрами: что меняется, как камера движется, какие действия происходят.')
      lines.push('  Если пользователь говорит «на основе рефа» или «скажи что на кадре» — опиши то, что ВИДИШЬ на прикреплённых изображениях.')
      lines.push('')
    }

    if (audios.length) {
      lines.push('АУДИО-РЕФЕРЕНСЫ (прикреплены, <Audio N> ДОПУСКАЕТСЯ):')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}${r.audioIntent ? ` (${r.audioIntent})` : ''}`))
      lines.push('  Ссылайся на <Audio N> для голоса/звучания. Конкретную реплику бери ТОЛЬКО из текста запроса пользователя.')
      lines.push('')
    }

    const forbidden = ['<Picture N>', '<Video N>', '<Subject N>']
    lines.push(`⚠️ ЗАПРЕЩЕНО использовать метки ${forbidden.join(', ')} — кадры задаются полями формы, не референсами. Формат — FORMAT A.`)
    if (!audios.length) lines.push('Голоса и реплики пиши в <d>...</d> БЕЗ привязки к <Audio N> (аудио не прикреплено).')
    // (правка 166) В новом чате кадры из формы генерации не учитываем — только то, что пользователь опишет словами.
    if (isFreshChat && (hasStartFrame || hasEndFrame)) {
      lines.push('')
      lines.push('ℹ️ (правка 166) Кадров из формы генерации в этом НОВОМ чате НЕТ. Если пользователь не описал сцену словами — не подставляй старую сессию, а спроси, что нужно показать в начале/конце.')
    }
    attachedBlock = lines.join('\n')
  } else {
    // (правка 150) t2v: только аудио-рефы, формат A (кадров нет)
    const lines: string[] = [modeHint, '']
    if (audios.length) {
      lines.push('АУДИО-РЕФЕРЕНСЫ (прикреплены, <Audio N> ДОПУСКАЕТСЯ):')
      audios.forEach((r, i) => lines.push(`  <Audio ${i + 1}> = ${r.name}${r.audioIntent ? ` (${r.audioIntent})` : ''}`))
      lines.push('  Ссылайся на <Audio N> для голоса/звучания. Конкретную реплику бери ТОЛЬКО из текста запроса пользователя.')
    }
    const forbidden = ['<Picture N>', '<Video N>', '<Subject N>']
    lines.push('')
    lines.push(`⚠️ ЗАПРЕЩЕНО использовать метки ${forbidden.join(', ')} — в этом режиме референсы картинок и видео НЕ ИСПОЛЬЗУЮТСЯ. Если пользователь просит референс — скажи, что нужно переключить на режим «Референсы». Формат — FORMAT A.`)
    if (!audios.length) lines.push('Голоса и реплики пиши в <d>...</d> БЕЗ привязки к <Audio N> (аудио не прикреплено).')
    // (правка 166) В новом чате аудио-рефы из формы генерации не учитываем — только то, что пользователь опишет словами.
    if (isFreshChat && audios.length) {
      lines.push('')
      lines.push('ℹ️ (правка 166) Аудио-рефы из формы генерации в этом НОВОМ чате НЕ прикреплены. Если пользователь не упомянул аудио — не подставляй старую сессию, а спроси, какой голос/звучание нужен.')
    }
    attachedBlock = lines.join('\n')
  }

  // ── Visual anchor: lock characters/objects by what the model actually sees ──
  const anchorBlock = images.length
    ? '\n=== ВИЗУАЛЬНЫЙ ЯКОРЬ — зафиксируй то, что ВИДИШЬ на рефах ===\n' +
      'Ты ВИДИШЬ прикреплённые изображения. Для КАЖДОГО персонажа/объекта, который должен попасть в кадр:\n' +
      '1) Опиши конкретно по факту изображения: форму и черты лица, цвет/форму глаз, цвет/стиль/длину волос, цвет кожи, примерный возраст, телосложение, одежда (цвет, фасон, принты, детали), характерные признаки (шрамы, тату, очки, причёска, украшения).\n' +
      '2) Создай для него <Subject N>, привяжи к его <Picture N>, и в retention_analysis отметь fully_preserved с перечислением этих деталей.\n' +
      '3) В detailed_description ссылайся на <Subject N> и повторяй ключевые детали, чтобы MiniMax воспроизвёл именно этого персонажа (лицо, волосы, одежда), а не выдумал другого.\n' +
      'Если на рефе нет персонажа/лица (только локация или стиль) — якорь не нужен, описывай по смыслу.'
    : ''

  // ── Audio anchor: reference voice/tone for MiniMax (правки 36: модель НЕ слышит) ──
  // Аудио уходит в MiniMax как ref_audios (голос/звучание); LLM лишь расставляет
  // <Audio N> в тексте промпта. Модель НЕ МОЖЕТ прослушать аудио, поэтому
  // запрещаем «цитировать» его содержимое (это было источником выдумывания).
  const hasAudioRefs = audios.length > 0 || videos.some((r) => r.includeAudio)
  const audioAnchorBlock = hasAudioRefs
    ? '\n=== АУДИО-ЯКОРЬ — референсы голоса/звучания (для MiniMax) ===\n' +
      'Аудио-референсы (и звуковые дорожки видео) прикреплены для MiniMax (ref_audios) — они задают ГОЛОС/ЗВУЧАНИЕ в генерации. НО модель НЕ МОЖЕТ их прослушать и НЕ знает их содержимого (какие там слова/реплики). Поэтому:\n' +
      '1) В структурированном промпте ссылайся на <Audio N> (или звуковую дорожку <Video N>) как на референс голоса/звучания — MiniMax использует сам файл.\n' +
      '2) Конкретную РЕПЛИКУ/текст бери ТОЛЬКО из текста запроса пользователя. Если пользователь не дал текст реплики — НЕ придумывай её: укажи, что персонаж говорит, и привяжи <Audio N>, но не выдумывай слова.\n' +
      '3) Характер голоса (тон, пол, возраст, эмоция) указывай СЛОВАМИ, только если пользователь его описал или дал контекст; иначе не выдумывай.\n' +
      '4) СТРОГО: НИКОГДА не «цитируй» и не описывай реплики/звуки «из аудио» — ты их не слышал; любые такие формулировки = выдумка.'
    : ''

  // ── Anti-hallucination + «текущий набор рефов точен» (правки 36) ──
  // Фиксируем, что ТЕКУЩИЙ список рефов — единственный источник правды, и
  // запрещаем перетаскивать описания удалённых рефов из истории чата (баг #1)
  // и выдумывать несуществующие рефы/детали (баг #3).
  const truthRuleBlock =
    '\n=== СТРОГОЕ ПРАВИЛО: ЧЕСТНОСТЬ И ТОЧНОСТЬ РЕФЕРЕНСОВ (правки 36) ===\n' +
    '1) ТЕКУЩИЙ набор референсов — ТОЧНО тот, что перечислен в блоке «ПРИКРЕПЛЁННЫЕ РЕФЕРЕНСЫ» выше. Ни больше, ни меньше. Описывай ТОЛЬКО эти референсы и ТОЛЬКО то, что реально в них.\n' +
    '2) Если в прошлых репликах ЭТОГО ЧАТА упоминались референсы, которых НЕТ в текущем списке выше — их БОЛЬШЕ НЕ СУЩЕСТВУЕТ: полностью игнорируй все прежние описания их, не переноси их детали и не упоминай их в новом промпте. Текущий список — единственный источник правды о том, какие рефы есть СЕЙЧАС.\n' +
    '3) НИКОГДА не выдумывай содержимое референса, которого нет в текущем списке, и не выдумывай деталь, которую не видишь на изображении/видео. Если чего-то не видишь или не уверен — прямо скажи «не вижу / не уверен», а не домысливай.\n' +
    '4) АУДИО: ты НЕ слышишь его содержимое. Не «цитируй» и не описывай реплики/звуки «из аудио» — это выдумка. Ссылайся только как <Audio N>; реплики бери из текста пользователя.'

  // (правка 53) подсказка зависит от видения видео: при выключенном виде
  // модель не должна «смотреть» видео, а только ссылаться на тег <Video N>.
  const rescanHint = videoVisionOn
    ? 'look at images, watch videos'
    : 'look at images; videos are TAGS ONLY — you do NOT see their frames, so never describe, guess or invent their content'

  // (правка 108) Вложения из чата — изолированы от ген-рефов: существуют ТОЛЬКО
  // в чате, нужны ТОЛЬКО для описания/анализа. Модель не должна использовать их
  // как <Picture N>/<Video N>/<Audio N> — таких ген-рефов в сессии НЕТ.
  const chatAttachRule =
    'CHAT ATTACHMENTS (вложения из чата): существуют ТОЛЬКО в чате и нужны ТОЛЬКО для описания/анализа содержимого. '
    + 'Они НЕ входят в референсы генерации — НИКОГДА не ссылайся на них как <Picture N>, <Video N> или <Audio N> в промпте: таких ген-рефов в этой сессии НЕТ. '
    + 'Если такое вложение должно попасть в видео — скажи пользователю добавить его в референсы на вкладке «Генерация». Описывай содержимое вложения словами.'

  // (правка 166) Явное правило независимости чатов: модель НЕ видит сообщения других
  // чатов, и не должна переносить тему/контекст из прошлой сессии в новый чат.
  // Черновик промпта из формы генерации (Current prompt draft) и рефы gen-store —
  // это глобальное состояние вкладки «Генерация», а НЕ контекст конкретного чата.
  // В новом чате они вообще не подставляются (см. isFreshChat выше).
  const chatIndependenceRule =
    '\n=== НЕЗАВИСИМОСТЬ ЧАТОВ (правка 166) ===\n' +
    '1) Этот чат — НЕЗАВИСИМЫЙ диалог. Сообщения других чатов тебе НЕДОСТУПНЫ — ты их не видишь и не помнишь.\n' +
    '2) Если пользователь начал новую тему в этом чате — отвечай ТОЛЬКО по ней. Не переноси тему, персонажей, сцены, промпт или настройки из любой другой сессии.\n' +
    '3) Поля формы генерации (черновик промпта Current prompt draft, референсы, кадры, режим) — это состояние вкладки «Генерация», а НЕ контекст этого чата. Используй их ТОЛЬКО если пользователь прямо на них ссылается (например, «сгенерируй по текущему промпту»). Если пользователь задал новый вопрос/тему — не подставляй старую форму автоматически.\n' +
    '4) При переключении режима или чата — старая тема/старые рефы/старый черновик НЕ УЧИТЫВАЮТСЯ. Текущий режим и список референсов выше — единственный источник правды.'

  // (правка 166) В новом чате черновик промпта из формы генерации НЕ показываем,
  // чтобы модель не «подцепляла» тему из прошлого чата. В остальных чатах показываем,
  // но с явной маркировкой: это НЕ часть этого чата, а состояние вкладки «Генерация».
  const promptDraftLine = isFreshChat
    ? 'Current prompt draft: (скрыт — новый чат, не подтягивай тему из прошлых сессий; используй ТОЛЬКО если пользователь прямо на него ссылается)'
    : `Current prompt draft (состояние вкладки «Генерация», НЕ часть этого чата — используй ТОЛЬКО если пользователь прямо на него ссылается): ${v.prompt.trim() || '(пусто)'}`

  return `${H3_OFFICIAL_PROMPT_SPEC}

=== SESSION CONTEXT ===
Clip duration: ~${seconds} s (shot timecodes must fit inside it).

=== ПРИКРЕПЛЁННЫЕ РЕФЕРЕНСЫ (available references) ===
${attachedBlock}
${anchorBlock}
${audioAnchorBlock}
${truthRuleBlock}
${promptDraftLine}
${chatIndependenceRule}

Chat behaviour:
- Small talk / questions → brief Russian reply. Do NOT output the structured prompt.
- Format selection is NOT optional: references attached → FORMAT B ONLY, with
  the reference tags placed in the prompt (see «РЕЖИМ ГЕНЕРАЦИИ» above);
  no references → FORMAT A, tags forbidden.
- Before EVERY prompt: re-scan the CURRENT references above (${rescanHint}).
  Ignore references from earlier turns NOT in the current list.
  Audio: CANNOT hear it — only reference as <Audio N>.
- ${chatAttachRule}
- DURATION: use ~${seconds} s. Shot timecodes must fit within it. Last cut ≤ duration − 2 s.
  Do NOT ask about duration.
- Prompt → ONLY in \`\`\`text fence (first line = first field name, last line = closing fence).
  A short Russian note BEFORE the fence is OK. Never output prompt as plain text.`
}

/** Ensure roles alternate: merge consecutive same-role, and ensure first is user.
 *  Merge, NOT replace: два подряд user-сообщения появляются, когда прошлый
 *  запрос упал без ответа (409/503/сеть) — при замене терялся первый вопрос
 *  вместе с его контекстом; модель видела только последний. */
function sanitizeRoles(msgs: AssistantChatMessage[]): AssistantChatMessage[] {
  const out: AssistantChatMessage[] = []
  for (const m of msgs) {
    if (out.length && out[out.length - 1].role === m.role) {
      const prev = out[out.length - 1]
      const merged = typeof prev.content === 'string' && typeof m.content === 'string'
        ? `${prev.content}\n\n${m.content}`
        : m.content
      out[out.length - 1] = { ...prev, content: merged }
    } else {
      out.push(m)
    }
  }
  // LLM requires the first non-system message to be 'user'
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

/**
 * Build the multimodal reference list for the LLM: images, videos AND audios.
 * - images  → sharp-resized 512px JPEG  ({"type":"image"})
 * - videos  → whole downscaled video + its audio track when includeAudio
 * - audios  → 16 kHz mono WAV           ({"type":"audio"})
 * The server prepares the media (see src/lib/llm-media.ts).
 */
function getReferences(): Array<{
  path: string
  trigger: string
  intent?: string
  kind: 'image' | 'video' | 'audio'
  includeAudio?: boolean
}> {
  const v = useGenStore.getState().video
  // (правка 150) В t2v из рефов уходят ТОЛЬКО аудио (картинки/видео не используются нодой).
  // (правка 151) В flf: кадры (startFrame/endFrame) прикрепляются как image-рефы,
  // чтобы LLM их ВИДЕЛА и описала словами (запрет <Picture N> — см. system-промпт).
  // Аудио-рефы также уходят в flf (через MiniMaxH3AddGuide).
  const refs = v.mode === 'ref' ? v.refs : v.refs.filter((r) => r.kind === 'audio')
  const out: Array<{
    path: string
    trigger: string
    intent?: string
    kind: 'image' | 'video' | 'audio'
    includeAudio?: boolean
  }> = []
  const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }

  // (правка 151) В flf-режиме кадры идут ПЕРВЫМИ (они главные), затем аудио.
  // LLM должна их увидеть и описать словами; <Picture N> запрещён в system-промпте.
  if (v.mode === 'flf') {
    if (v.startFrame?.path) {
      out.push({ path: v.startFrame.path, trigger: 'Первый кадр', intent: 'first_frame', kind: 'image' })
      counters.image++
    }
    if (v.endFrame?.path) {
      out.push({ path: v.endFrame.path, trigger: 'Последний кадр', intent: 'last_frame', kind: 'image' })
      counters.image++
    }
  }

  for (const r of refs) {
    if (r.kind === 'image') {
      out.push({ path: r.path, trigger: `Picture ${++counters.image}`, intent: r.imageIntent || 'identity', kind: 'image' })
    } else if (r.kind === 'video') {
      out.push({ path: r.path, trigger: `Video ${++counters.video}`, kind: 'video', includeAudio: r.includeAudio })
    } else if (r.kind === 'audio') {
      out.push({ path: r.path, trigger: `Audio ${++counters.audio}`, intent: r.audioIntent || 'voice', kind: 'audio' })
    }
  }
  return out
}

/* ── Live stream state (subscribed by mounted views) ────────────────── */

interface StreamState {
  /** Chat id of the in-flight reply, or null when idle. */
  chatId: string | null
  /** Accumulated assistant text of the in-flight reply. */
  text: string
}

export const useAssistantStream = create<StreamState>(() => ({
  chatId: null,
  text: '',
}))

let activeAbort: AbortController | null = null
let running = false

/** True while a reply is in flight (for guards from non-reactive code). */
export function isStreamActive(): boolean {
  return useAssistantStream.getState().chatId !== null
}

/**
 * Send history[] to the LLM, stream the reply, commit to the store.
 * Module-level: keeps running after AssistantView unmounts.
 * No-op while another reply is already in flight (one at a time).
 */
/** (правка 86; обновлено правкой 108) Вложение к сообщению чата:
 *  изображение или видео. (правка 108) Хранится в изолированном каталоге
 *  data/chat-attachments/ — файл существует ТОЛЬКО в чате и используется
 *  ТОЛЬКО для LLM-анализа/описания. НЕ смешивается с референсами генерации
 *  (<Picture N>/<Video N>), не лежит в ComfyUI/input/, не попадает в галерею,
 *  upscale и «чистку input». */
export interface ChatAttachment {
  /** Имя файла в хранилище вложений (data/chat-attachments/, или legacy ComfyUI/input/). */
  path: string
  /** Изначальное имя файла (для отображения). */
  name: string
  /** Тип медиа. */
  kind: 'image' | 'video'
  /** (правка 108) Legacy-вложение (правки 86–87) лежит в ComfyUI/input/ —
   *  сервер читает его из input/, но оно ТОЖЕ не является ген-рефом. */
  legacyComfy?: boolean
}

export function runAssistantCompletion(
  chatId: string,
  history: AssistantChatMessage[],
  attachments?: ChatAttachment[],
): void {
  if (running) return
  running = true
  const ac = new AbortController()
  activeAbort = ac
  useAssistantStream.setState({ chatId, text: '' })

  void (async () => {
    let final = ''
    // false = сервер ответил ошибкой на сам POST (409/503/...): показываем
    // ЭТУ ошибку; true = стрим начался и оборвался посередине
    let streamStarted = false
    // (клиентский idle-watchdog) объявлены ДО try: catch читает их даже если
    // throw случился до открытия стрима.
    let idleTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    try {
      const refs = getReferences()
      // (правка 108) Вложения чата — ОТДЕЛЬНО от рефов генерации: они существуют
      // ТОЛЬКО в чате и нужны ТОЛЬКО для LLM-описания/анализа. В references
      // (<Picture N>/<Video N>) они НЕ попадают — сервер получает их отдельным
      // полем chatAttachments, прикрепляет как «Chat N» и запрещает тегирование
      // в промпте (раньше они пушались в refs → LLM вписывала <Picture N> →
      // MiniMax подтягивал файл из input/ в генерацию).
      const chatAttachments = attachments?.length
        ? attachments.map((a) => ({
            path: a.path,
            name: a.name,
            kind: a.kind,
            legacyComfy: a.legacyComfy === true,
          }))
        : undefined
      // (правка 53) Свежее значение «видение видео» из конфига — системный
      // промпт должен совпадать с тем, что сервер реально прикрепит.
      // Лёгкий локальный GET; при ошибке остаёмся по умолчанию (выкл).
      let videoVisionOn = false
      try {
        const cfgRes = await fetch('/api/config')
        if (cfgRes.ok) {
          const cfg = await cfgRes.json()
          videoVisionOn = cfg.llm_video_vision === true
        }
      } catch { /* ignore — default OFF */ }
      const res = await fetch('/api/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            // (правка 166) Передаём длину истории, чтобы в новом чате (0–1 сообщ.)
            // НЕ подставлялись черновик промпта и рефы gen-store — они глобальны
            // и «подтекали» в новый чат, создавая ощущение, что ассистент помнит
            // другие чаты. В старых чатах показываем, но с явной маркировкой.
            { role: 'system', content: buildSystemMessage(videoVisionOn, history.length) },
            // Replay the (capped) chat history so the model "remembers"
            ...sanitizeRoles(history.slice(-HISTORY_LIMIT)),
          ],
          // Send image references so the server can inject them as vision
          ...(refs.length > 0 ? { references: refs } : {}),
          // (правка 108) Вложения чата — отдельное поле (НЕ references):
          // сервер читает их из data/chat-attachments/ (или legacy input/)
          // и прикрепляет к LLM как «Chat N» с запретом тегов <Picture N>.
          ...(chatAttachments ? { chatAttachments } : {}),
        }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '')
        let msg = `HTTP ${res.status}`
        try {
          msg = (JSON.parse(errText) as { error?: string }).error || msg
        } catch {
          /* keep */
        }
        throw new Error(msg)
      }
      const reader = res.body.getReader()
      streamStarted = true
      const decoder = new TextDecoder()
      let buf = ''
      // (клиентский idle-watchdog) Half-open соединение (сон/гибернация ПК,
      // сдохший прокси) не разрешает reader.read() никогда — стрим висел
      // вечно, чат блокировался до перезагрузки страницы. Зеркалим серверный
      // сторож: 5 мин без единого чанка = принудительный abort с тостом.
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        ac.abort()
      }, 5 * 60_000)
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleTimedOut = true
          ac.abort()
        }, 5 * 60_000)
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          buf += decoder.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          const line = ev.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          // JSON.parse — в ОТДЕЛЬНОМ try: раньше фильтр «не JSON в сообщении»
          // глотал и payload.error, если текст ошибки сервера упоминал JSON
          // (например, исключения llama-cpp) — стрим «завершался» как успешный
          // с обрезанным ответом.
          let payload: { delta?: string; error?: string } | null = null
          try {
            payload = JSON.parse(line.slice(6))
          } catch {
            continue // битый/незавершённый чанк — ждём следующий
          }
          if (!payload) continue
          if (payload.error) throw new Error(payload.error)
          if (payload.delta) {
            final += payload.delta
            const s = useAssistantStream.getState()
            if (s.chatId === chatId) useAssistantStream.setState({ text: final })
          }
        }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError' || idleTimedOut) {
        // Ошибка ДО старта стрима = структурированный ответ сервера
        // (409 «идёт генерация», 503 «не освободил VRAM», ...) — показываем
        // её как есть, БЕЗ маскирующих «дружелюбных» подмен.
        // Обрыв уже начавшегося ответа — отдельный случай.
        let msg = err instanceof Error ? err.message : String(err)
        if (idleTimedOut) {
          msg = 'Ответ ассистента завис (нет данных 5 мин) — соединение прервано. Отправьте сообщение ещё раз.'
        } else if (streamStarted) {
          try {
            const s = (await fetch('/api/llm/status').then((r) => r.json())) as LlmStatusResp
            if (s && !s.running) {
              msg = 'Соединение с ассистентом оборвалось (сервер остановился). Отправьте сообщение ещё раз — ассистент поднимется заново.'
            }
          } catch {
            /* status unavailable — показываем исходную ошибку */
          }
        }
        toast.error('Ассистент', { description: msg })
        if (idleTimedOut) void fetch('/api/llm/abort', { method: 'POST' }).catch(() => {})
      }
    } finally {
      // Commit the finished assistant reply to the persisted chat. This runs
      // even when the view is UNMOUNTED — exactly what makes the answer
      // survive tab switches.
      if (final.trim()) {
        useAssistantChats.getState().appendMessage(chatId, { role: 'assistant', content: final })
      }
      running = false
      activeAbort = null
      // Reset the live store only if WE are still the active stream (a new
      // stream could have started in the meantime after an abort).
      if (useAssistantStream.getState().chatId === chatId) {
        useAssistantStream.setState({ chatId: null, text: '' })
      }
    }
  })()
}

/** Stop the in-flight reply (user pressed «Стоп»). */
export function stopAssistantStream(): void {
  activeAbort?.abort()
  void fetch('/api/llm/abort', { method: 'POST' }).catch(() => {})
}

/**
 * Stop the in-flight reply ONLY if it belongs to `chatId` (правка 32).
 *
 * Used when deleting the chat that owns the stream: the engine's `finally`
 * runs its `appendMessage` AFTER the chat is already gone, so the partial
 * reply is dropped (the store map finds no such chat) — exactly what we want
 * — and the model is freed via the abort POST. No-op when the stream is
 * owned by another chat or when idle.
 */
export function stopStreamForChat(chatId: string): void {
  if (useAssistantStream.getState().chatId !== chatId) return
  stopAssistantStream()
}
