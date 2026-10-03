'use client'

/**
 * Learn tab content: step definitions for the beginner tutorial.
 * Each step = a mockup of the relevant screen area (learn-mockups.tsx)
 * with numbered <Hl> highlights + callouts explaining "what / why / how".
 * INVARIANT: every callout number n has exactly one matching <Hl n> zone.
 *
 * (правка 114) Полная актуализация тура под текущий функционал программы:
 *   + окно приветствия (правки 112–113),
 *   + диктофон в поле промпта (правки 65/74),
 *   + горячая клавиша R/К на диктовку (правка 118),
 *   + вложения чата живут только в чате (правка 108), KV-кэш LLM (правка 109),
 *   + ручной ввод значений у слайдеров (правка 107),
 *   + два режима Upscale и метки в галерее (правки 74/77/78),
 *   + отдельный шаг по LoRA: турбо-лора в списке, сила, триггеры (правки 44/95/96),
 *   + вкладка «Внешний вид» и 8 вкладок настроек (правка 111),
 *   + шаги pass 1: 2–30, по умолчанию 4, ручной ввод 1–128 (правки 63–77).
 *
 * (правка 163) Актуализация под правки 136–162:
 *   + 3 режима генерации: Текст / Кадры / Референсы (правка 146),
 *   + Bonsai 2 27B — LLM по умолчанию (правка 162),
 *   + Ассистент видит видео-кадры на Bonsai (правка 162),
 *   + RTX VSR: HDR убран (правка 162), DLSS 1.5× работает (правка 162),
 *   + Bonsai light — optional, баннер не требует (правка 162),
 *   + Соотношение сторон в режиме «Кадры» из первого кадра (правка 152),
 *   + Ассистент знает режим и не ломает промпт при переключении (правка 150).
 */
import type { ReactNode } from 'react'
import {
  Hl,
  MockSidebar,
  MockRefDropzone,
  MockRefCard,
  MockPrompt,
  MockCtaButton,
  MockSelect,
  MockSlider,
  MockToggle,
  MockBar,
  MockLabel,
  MockQueuePill,
  MockGalleryTile,
  MockLightbox,
  MockMetaDialog,
  MockStats,
  MockWarningBanner,
  MockModelsList,
  MockSettingsGeneral,
  MockSettingsAppearance,
  MockSettingsLlm,
  MockSettingsDanger,
  MockSettingsComfyLinks,
  MockSettingsVoice,
  MockSettingsOpt,
  MockLoraList,
  MockUpscalePanel,
  MockWelcomeDialog,
} from './learn-mockups'

export interface LearnCallout {
  n: number
  title: string
  text: string
}

export interface LearnStep {
  id: string
  title: string
  /** One-line teaser shown in the "Что дальше" strip. */
  short: string
  mock: ReactNode
  callouts: LearnCallout[]
  tip?: string
}

/* ── helper: wrapper for mockup areas ── */
function Stage({ children }: { children: ReactNode }) {
  return <div className="w-full flex items-center justify-center gap-3 flex-wrap">{children}</div>
}

export const LEARN_STEPS: LearnStep[] = [
  /* ═══════════════ ЧАСТЬ 1. СТАРТ ═══════════════ */
  {
    id: 'welcome',
    title: 'Добро пожаловать — что это за программа',
    short: 'Локальная студия: нейросеть MiniMax H3 на вашем ПК и start.bat.',
    mock: (
      <Stage>
        <Hl n={1}><MockWelcomeDialog /></Hl>
        <Hl n={2}><MockSidebar /></Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[11px] font-mono text-cyan-300 font-semibold">start.bat</p>
            <p className="text-[9px] text-muted-foreground leading-relaxed">Один клик — и запускается всё:</p>
            <div className="space-y-1 pt-1">
              <p className="text-[9px] text-foreground/80">• ComfyUI (нейросеть, порт 8188)</p>
              <p className="text-[9px] text-foreground/80">• веб-интерфейс</p>
              <p className="text-[9px] text-foreground/80">• браузер</p>
            </div>
          </div>
        </Hl>
        <Hl n={4}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[11px] text-foreground font-semibold">🖥 Всё на вашем ПК</p>
            <p className="text-[9px] text-muted-foreground leading-relaxed">
              Нейросеть работает на вашей видеокарте, а не в облаке. Для генерации интернет не нужен — только для первичной загрузки моделей.
            </p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Окно приветствия', text: 'Появляется при каждом запуске программы — пока вы не поставите галочку «Больше не показывать это окно». Внутри краткая инструкция из трёх шагов: скачать модели → сгенерировать первое видео → посмотреть результат. Из окна можно сразу открыть настройки или этот тур. Если окно «потерялось» — верните его: Настройки → Общие → «Показать окно приветствия».' },
      { n: 2, title: 'Пять вкладок', text: '«Генерация» — рабочее место (3 режима: Текст / Кадры / Референсы), «Ассистент» — локальная LLM-помощница (Bonsai 2 27B), «Upscale» — апскейл видео (DLSS 5 и RTX VSR 1×–4×), «Галерея» — готовые видео, «Обучение» — этот тур. Сайдбар можно свернуть.' },
      { n: 3, title: 'start.bat — ваш пульт', text: 'Единственная точка запуска: поднимает нейросеть ComfyUI, интерфейс и открывает браузер. Если что-то пошло не так — просто перезапустите его.' },
      { n: 4, title: 'Локально и офлайн', text: 'Видео генерируется на вашей видеокарте. После единоразовой загрузки моделей интернет больше не нужен.' },
    ],
    tip: 'При первом запуске интерфейс может ждать, пока ComfyUI загрузится — это нормально, дождитесь зелёного индикатора.',
  },
  /* (правка 132) Системные требования — файл подкачки, частая причина ошибок */
  {
    id: 'sys-reqs',
    title: 'Системные требования — файл подкачки',
    short: 'Увеличьте файл подкачки до 32 ГБ, иначе будет ошибка «не хватает памяти».',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-xl border border-amber-400/40 bg-amber-500/10 p-3.5 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                <svg className="w-4.5 h-4.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
                  <path d="M12 9v4"/>
                  <path d="M12 17h.01"/>
                </svg>
              </span>
              <div>
                <p className="text-[13px] font-semibold text-amber-300">Файл подкачки</p>
                <p className="text-[10px] text-muted-foreground">Virtual Memory / Page File</p>
              </div>
            </div>
            <p className="text-[11px] text-foreground/80 leading-relaxed">
              Программа потребляет много оперативной памяти. Если файл подкачки небольшой — Windows выдаст ошибку «не хватает памяти».
            </p>
            <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[10px] text-foreground/70 leading-relaxed space-y-1">
              <p className="font-medium text-foreground">Минимум: 32 ГБ (32768 МБ)</p>
              <p>Рекомендуется: 64 ГБ (65536 МБ)</p>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-xl border border-border bg-[var(--surface-1)] p-3.5 space-y-2">
            <p className="text-[11px] font-semibold text-foreground">Как увеличить (Windows):</p>
            <div className="space-y-1.5 text-[10px] text-muted-foreground leading-relaxed">
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold text-center leading-4">1</span> Win + R → <code className="font-mono bg-[var(--surface-2)] px-1 rounded">sysdm.cpl</code> → Enter</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold text-center leading-4">2</span> Вкладка «Дополнительно»</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold text-center leading-4">3</span> «Быстродействие» → «Параметры» → «Изменить...»</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold text-center leading-4">4</span> Снять галочку «Автоматически определять размер»</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold text-center leading-4">5</span> Выбрать диск (обычно C:)</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold text-center leading-4">6</span> Поставить «Максимальный размер» = <b className="text-foreground">32768</b></p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[9px] font-bold text-center leading-4">7</span> «Установить» → «ОК» → <b className="text-foreground">перезагрузить ПК</b></p>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-red-400/30 bg-red-500/5 p-3 space-y-1.5">
            <p className="text-[10px] font-semibold text-red-400">❌ Без этого:</p>
            <p className="text-[9px] text-muted-foreground leading-relaxed">
              Ошибка «Not enough memory» / «CUDA out of memory» / программа падает при генерации.
            </p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Почему это важно', text: 'Программа (ComfyUI + нейросеть MiniMax H3) потребляет 10–20+ ГБ оперативной памяти во время генерации. Файл подкачки (virtual memory) — это «дополнительная память» на диске, которая подстраховывает, когда RAM не хватает. Если он маленький (Windows по умолчанию ставит 1–4 ГБ) — программа выдаст ошибку.' },
      { n: 2, title: 'Как увеличить', text: 'Win + R → sysdm.cpl → «Дополнительно» → «Быстродействие» → «Параметры» → «Изменить». Снять галочку «Автоматически», выбрать диск, «Максимальный размер» = 32768 (или больше), «Установить» → «ОК» → перезагрузить. Это займёт 30 секунд.' },
      { n: 3, title: 'Симптомы', text: 'Если вы видите ошибки «Not enough memory», «CUDA out of memory», «Page file» или программа просто падает при генерации — скорее всего, файл подкачки слишком маленький. Увеличьте его и перезагрузите ПК.' },
    ],
    tip: 'Это нужно сделать один раз. После увеличения файла подкачки проблема с памятью уходит навсегда.',
  },
  {
    id: 'first-run',
    title: 'Первый запуск — скачиваем модели',
    short: 'Жёлтый баннер → Настройки → скачать. Одноразово, ~50 ГБ.',
    mock: (
      <Stage>
        <Hl n={1}><MockWarningBanner /></Hl>
        <Hl n={2}><MockModelsList /></Hl>
        <Hl n={3}>
          <div className="w-[190px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Статусы моделей</p>
            <p className="text-[9px] text-muted-foreground">✓ — готово</p>
            <p className="text-[9px] text-muted-foreground">○ — не скачано</p>
            <p className="text-[9px] text-cyan-300">⬇ — качается (% и скорость)</p>
            <p className="text-[9px] text-red-400">! — ошибка (повторите)</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Баннер вверху экрана', text: 'Появляется, когда нужные модели ещё не скачаны, — без них генерация будет работать некорректно. Кнопка «Скачать в настройках» открывает настройки, ✕ временно скрывает баннер.' },
      { n: 2, title: 'Две группы моделей', text: '«Minimax H3 (генерация)» — движок видео: диффузионная модель, текстовый энкодер, VAE, Turbo LoRA, апскейлер и др. (суммарно ~46 ГБ). «LLM ассистент» — модель чата: Bonsai 2 27B (по умолчанию, ~7.8 ГБ, тернарная, vision), Gemma 4 12B (Q3/Q4/Q5) или Qwen3.5 9B. Достаточно выбрать ОДНУ LLM-модель — по умолчанию Bonsai.'},
      { n: 3, title: 'Загрузка — фоновая', text: 'Жмёте ⬇ рядом с моделью — видите процент и скорость. Закрыть окно настроек можно в любой момент: скачивание НЕ прервётся и продолжится в фоне, статус будет виден в баннере. Через ✕ загрузку можно остановить и продолжить позже. Скачанные модели остаются в папке models и никуда не денутся.' },
    ],
    tip: 'Уже скачивали модели старой версией программы? Настройки → Общие → «Перенос моделей из старой версии»: выбираете папку со старой сборкой, и программа перенесёт их сама.',
  },
  {
    id: 'interface',
    title: 'Интерфейс — где что находится',
    short: 'Вкладки, датчики, индикатор ComfyUI и настройки.',
    mock: (
      <Stage>
        <Hl n={1}><MockSidebar active="generate" /></Hl>
        <Hl n={2}>
          <div className="w-[210px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Вкладка «Генерация»</MockLabel>
            <div className="border-2 border-dashed border-border rounded-lg py-2.5 text-center">
              <p className="text-[9px] text-muted-foreground">референсы (необязательно)</p>
            </div>
            <MockPrompt withMention />
            <MockSelect value="1280×704 · 720p" />
            <MockCtaButton label="Сгенерировать видео" />
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-[9px] text-muted-foreground">ComfyUI подключен</span>
            </div>
            <MockStats />
          </div>
        </Hl>
        <Hl n={4}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">⚙ Настройки — 8 вкладок</p>
            <p className="text-[9px] text-muted-foreground">Общие · Внешний вид · LLM · Голос</p>
            <p className="text-[9px] text-muted-foreground">Оптимизация · ComfyUI · Ссылки · Сброс</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Сайдбар', text: 'Пять вкладок — «Генерация», «Ассистент», «Upscale», «Галерея», «Обучение». Внизу — индикатор ComfyUI (зелёная точка = нейросеть на ногах) и шестерёнка настроек.' },
      { n: 2, title: 'Рабочее место «Генерация»', text: 'Вся цепочка в одном месте: режим (Текст / Кадры / Референсы) → промпт → рефы (зависит от режима) → разрешение и длительность → «Сгенерировать видео». Ниже — карточка статуса и галерея последних видео.' },
      { n: 3, title: 'Индикатор и датчики', text: 'Красная точка — ComfyUI не запущен: генерация невозможна (галерея и настройки доступны). Датчики VRAM / GPU / RAM — по ним видно, не упёрся ли вы в память видеокарты.' },
      { n: 4, title: 'Настройки — 8 вкладок', text: 'Всё, что программа умеет: модели и LoRA, внешний вид, ассистент, голосовой ввод, оптимизация памяти, состояние ComfyUI, ссылки для ручной загрузки и «Сброс» (опасная зона). Разберём каждую в последних шагах тура.' },
    ],
    tip: 'Сайдбар сворачивается — если хочется больше места под промпт.',
  },
  /* ═══════════════ ЧАСТЬ 2. ПУТЬ К ВИДЕО ═══════════════ */
  {
    id: 'modes',
    title: 'Шаг 1 — Режим генерации',
    short: 'Три режима: Текст · Кадры · Референсы — подберите под свои данные.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <MockLabel>Режим генерации</MockLabel>
          <div className="grid grid-cols-3 gap-1.5">
            <Hl n={1}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Текст</p>
                <p className="text-[7px] text-muted-foreground mt-0.5">только описание</p>
              </div>
            </Hl>
            <Hl n={2}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Кадры</p>
                <p className="text-[7px] text-muted-foreground mt-0.5">1–2 картинки → видео</p>
              </div>
            </Hl>
            <Hl n={3}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Референсы</p>
                <p className="text-[7px] text-muted-foreground mt-0.5">до 15 файлов</p>
              </div>
            </Hl>
          </div>
          <div className="rounded-md bg-[var(--surface-2)] px-2 py-1.5 space-y-1">
            <p className="text-[8px] text-muted-foreground"><b>Текст:</b> промпт + аудио-рефы (голос/озвучка). Картинки и видео не используются.</p>
            <p className="text-[8px] text-muted-foreground"><b>Кадры:</b> первый и (необязат.) последний кадр + аудио. Соотношение сторон из кадра. Скриншот — Ctrl+V.</p>
            <p className="text-[8px] text-muted-foreground"><b>Референсы:</b> до 15 файлов — 9 картинок, 3 видео, 3 аудио. Полный контроль.</p>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Текст (T2V)', text: 'Чистый text-to-video: только промпт описывает сцену. Аудио-референсы можно приложить для голоса/озвучки (WAV, MP3…), но картинки и видео-рефы в этом режиме не используются — модель создаёт всё с нуля по тексту.' },
      { n: 2, title: 'Кадры (FL2VA)', text: 'Первый кадр (обязательный) задаёт старт видео, последний (необязательный) — финиш. Промпт описывает переход между ними. Скриншот можно просто вставить по Ctrl+V. Соотношение сторон автоматически берётся из первого кадра — селектор заблокирован. Аудио-рефы для голоса/озвучки.' },
      { n: 3, title: 'Референсы (Ref2VA)', text: 'Полный режим: до 15 файлов — 9 картинок (персонажи, объекты, стиль), 3 видео (движение, сцены), 3 аудио (голос, звук). У каждого файла — роль. Это самый гибкий режим, как раньше.' },
    ],
    tip: 'Ассистент знает выбранный режим и не добавит в промпт теги, которые не поддерживаются: при переключении на «Текст» метки &lt;Picture N&gt; и &lt;Video N&gt; автоматически уберутся.',
  },
  {
    id: 'refs',
    title: 'Шаг 2 — Референсы (режим «Референсы»)',
    short: 'До 15 файлов: 9 картинок, 3 видео, 3 аудио. Или ноль — тоже можно.',
    mock: (
      <Stage>
        <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <MockLabel>Референсы</MockLabel>
            <span className="text-[9px] text-muted-foreground">1/9 img · 1/3 vid · 0/3 aud</span>
          </div>
          <Hl n={1}><MockRefDropzone /></Hl>
          <Hl n={2}><MockRefCard /></Hl>
          <Hl n={3}>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2">
              <div className="w-9 h-9 rounded bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center shrink-0">
                <span className="text-[7px] text-cyan-300 font-bold">VID</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-foreground truncate font-mono">scene_walk.mp4</p>
                <p className="text-[9px] text-muted-foreground">сцена · движение</p>
              </div>
              <span className="flex items-center gap-1 text-[8px] text-muted-foreground shrink-0">
                <span className="w-3 h-3 rounded-sm border border-cyan-500/50 bg-cyan-500/30 inline-flex items-center justify-center text-[7px] text-cyan-200">✓</span>
                использовать звук
              </span>
            </div>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Можно вообще без них', text: 'В режиме «Референсы» генерация запускается и по одному только промпту. Референсы — точность: до 15 файлов — 9 картинок, 3 видео, 3 аудио. Картинки — кто/что, видео — как двигается, аудио — голос и звук. Скриншот можно просто вставить по Ctrl+V. В режиме «Текст» картинки и видео-рефы не используются — только аудио; в режиме «Кадры» картинки задаются полями «Первый кадр» / «Последний кадр».' },
      { n: 2, title: 'Роль референса', text: 'У каждого файла задаётся роль: «персонаж / объект», «сцена», «стиль», «композиция». Это подсказка модели, ЧТО брать из файла: лицо, фон, палитру или ракурс.' },
      { n: 3, title: 'Видео и аудио', text: 'У видео-референса можно галкой включить «использовать звук» — модель возьмёт звук прямо из клипа. Аудио-файлы привязываются к намерению: «Голос», «Темп / ритм» или «Стиль» — что именно должен влиять звук.' },
    ],
    tip: 'Лучше всего работают лица/объекты крупным планом при хорошем освещении. Для речей — чистая запись голоса.',
  },
  {
    id: 'prompt',
    title: 'Шаг 3 — Пишем описание (промпт)',
    short: 'Слова решают всё: теги @, озвучка <d>…</d>, диктовка голосом.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <Hl n={1}><MockPrompt withMention /></Hl>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground">Введите <span className="font-mono text-foreground/70">@</span> — появится список референсов</span>
            <Hl n={2}>
              <div className="flex items-center gap-1.5">
                <span className="w-6 h-6 rounded-full bg-red-500/20 border border-red-400/40 flex items-center justify-center text-[10px]">🎙</span>
              </div>
            </Hl>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground">Голосовой ввод: нажмите → говорите → нажмите снова</span>
            <Hl n={3} className="shrink-0"><div className="p-1.5 rounded-lg border border-border bg-[var(--surface-2)] text-[9px] text-muted-foreground">⛶</div></Hl>
          </div>
          <div className="flex justify-end"><Hl n={4}><MockCtaButton label="Сгенерировать видео" /></Hl></div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Поле промпта и теги', text: 'Опишите сцену словами: кто, где, что делает. Модель заметно лучше понимает АНГЛИЙСКИЙ — идею можно набросать по-русски, но финальный промпт лучше перевести (кнопка «Примеры» даёт готовые английские промпты). Символ @ вставляет тег <Picture 1> — «использовать вот этот референс здесь». Реплики героев оборачивайте в <d>…</d> — они будут озвучены.' },
      { n: 2, title: 'Голосовой ввод (диктофон)', text: 'Круглый микрофон внутри поля промпта: нажали — описываете сцену голосом — нажали ещё раз, и распознанный текст вставится прямо в промпт. Та же кнопка есть в полноэкранном редакторе и в чате Ассистента. Горячая клавиша: R (англ.) / К (рус.) — одна и та же физическая клавиша в обеих раскладках: нажмите, когда фокус НЕ в поле ввода (например, кликните в пустое место рядом) — запись стартует, нажмите ещё раз — стоп и вставка текста. Если диктовка уже идёт — клавиша всегда доводит её до конца. Включается и настраивается в Настройки → Голос.' },
      { n: 3, title: 'Полноэкранный редактор', text: 'Раскрывает поле ввода на весь экран — удобно для длинных сценариев.' },
      { n: 4, title: 'Запуск', text: 'Кнопка активна, когда введён промпт. Ctrl+Enter запускает генерацию прямо из поля ввода.' },
    ],
    tip: 'Пишите кинематографично: «slow camera push-in», «warm sunset light», «speaks in a whisper» — детали улучшают результат.',
  },
  {
    id: 'llm-assistant',
    title: 'Ассистент — напишет промпт за вас',
    short: 'Локальная LLM (Bonsai 2 27B) видит рефы и выдаёт готовый промпт.',
    mock: (
      <Stage>
        <div className="w-[310px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
              <span className="text-[10px] text-violet-300 font-bold">AI</span>
            </div>
            <div>
              <p className="text-[10px] font-medium text-foreground">Ассистент · Bonsai 2 27B (по умолчанию)</p>
              <p className="text-[8px] text-emerald-400">● локально · видит картинки И видео-кадры</p>
            </div>
          </div>
          <Hl n={1}>
            <div className="rounded-lg border border-border bg-[var(--surface-2)] p-2 space-y-1">
              <p className="text-[9px] text-muted-foreground">Вы: Опиши сцену: девушка с рефа идёт по рынку, говорит привет</p>
              <p className="text-[9px] text-foreground/90 leading-relaxed">A girl with <span className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[8px]">&lt;Picture 1&gt;</span> walks through the evening market, string lights… She says: <span className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[8px] font-mono">&lt;d&gt;Hi there!&lt;/d&gt;</span> Smooth pan, warm light.</p>
            </div>
          </Hl>
          <Hl n={2}>
            <div className="rounded-lg border border-dashed border-violet-500/30 bg-violet-500/5 p-2 flex items-center gap-2">
              <div className="w-7 h-7 rounded bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shrink-0">
                <span className="text-[7px] text-purple-300 font-bold">IMG</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] text-foreground/90 font-mono truncate">photo_girl.png</p>
                <p className="text-[7px] text-muted-foreground">виден только Ассистенту — в референсы генерации не попадает</p>
              </div>
              <span className="text-[8px] text-muted-foreground shrink-0">✕</span>
            </div>
          </Hl>
          <Hl n={3}>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-lg border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-[9px] text-muted-foreground">Опишите идею сцены…</div>
              <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-violet-300 text-[10px]">➤</div>
            </div>
          </Hl>
          <div className="flex items-center justify-between gap-2">
            <Hl n={4}>
              <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-[9px] text-violet-300 font-medium text-center">✨ Улучшить промпт (из редактора)</div>
            </Hl>
            <Hl n={5}>
              <div className="rounded-lg border border-border bg-[var(--surface-2)] px-2 py-1.5 flex items-center gap-1.5">
                <span className="text-[8px] text-muted-foreground">KV-кэш:</span>
                <span className="px-1 py-0.5 rounded text-[7px] border border-border text-muted-foreground">Выкл</span>
                <span className="px-1 py-0.5 rounded text-[7px] border border-border text-muted-foreground">Q8</span>
                <span className="px-1 py-0.5 rounded text-[7px] border border-border text-muted-foreground">Q5</span>
                <span className="px-1 py-0.5 rounded text-[7px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium">Q4</span>
              </div>
            </Hl>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Локальная модель', text: 'По умолчанию — Bonsai 2 27B (тернарная, ~7.8 ГБ, vision). Альтернативы: Gemma 4 12B (Q3/Q4/Q5) или Qwen3.5 9B. Всё работает на вашей видеокарте — ничего не уходит в облако. Ассистент видит прикреплённые картинки И видео-кадры, описывает то, что на них, и фиксирует персонажей в промпте — MiniMax не выдумает другие лица.' },
      { n: 2, title: 'Вложения — только в чате', text: 'Картинки и видео, прикреплённые в чате Ассистента, живут ТОЛЬКО в чате: они не попадают в список референсов генерации, в галерею и в Upscale. Их единственная цель — помочь Ассистенту описать сцену и собрать промпт. Картинку можно прикрепить скрепкой или просто вставить по Ctrl+V. Для генерации рефы добавляются отдельно, во вкладке «Генерация».' },
      { n: 3, title: 'Опишите идею по-русски', text: 'Ассистент знает полный гайд MiniMax H3, подберёт правильные теги (<Picture N>, <Video N>, <Audio N>) и выдаст готовый промпт на английском. В шапке полноэкранного редактора есть «Улучшить промпт» — отправит текущий черновик в LLM и переключит на чат.' },
      { n: 4, title: 'Видение видео', text: 'Ассистент видит видео-референсы: понимает, что происходит в кадре, как двигаются объекты и меняется сцена — а не только первый кадр. Флаг «Видение видео» в Настройки → LLM управляет этим: по умолчанию включено, можно выключить для экономии памяти.' },
      { n: 5, title: 'Память длинного чата — KV-кэш', text: 'Долгие диалоги «съедают» память. Квантизация KV-кэша (Настройки → LLM: Q8 / Q5 / Q4) заметно снижает потребление памяти чата с потерей качества, почти неощутимой в ответах. По умолчанию включена Q4 — самый экономный режим; «Выкл» ставят, только если хочется максимальной точности и памяти хватает.' },
    ],
    tip: 'Ассистент не выдумывает теги: если референсов нет — не использует <Picture N>; если есть — привязывает только существующие номера.',
  },
  {
    id: 'resdur',
    title: 'Шаг 4 — Разрешение и длительность',
    short: '480p для проб, 1080p для финала; до ~30 секунд. В режиме «Кадры» — из кадра.',
    mock: (
      <Stage>
        <div className="w-[290px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-3">
          <div className="space-y-1.5">
            <MockLabel>Разрешение</MockLabel>
            <Hl n={1}>
              <div className="space-y-1.5">
                <MockSelect value="1280×704 · 720p" />
                <div className="flex gap-1 flex-wrap">
                  {['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((a) => (
                    <span key={a} className={a === '16:9' ? 'px-1.5 py-0.5 rounded text-[8px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium' : 'px-1.5 py-0.5 rounded text-[8px] border border-border text-muted-foreground'}>{a}</span>
                  ))}
                </div>
              </div>
            </Hl>
          </div>
          <div className="space-y-1.5">
            <MockLabel>Свободное разрешение</MockLabel>
            <Hl n={2}>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="px-2 py-1 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[9px] font-medium">Свободное разрешение · вкл</span>
                  <span className="text-[9px] font-mono text-cyan-300/90">0.70 MP (1280×704)</span>
                </div>
                <MockSlider value={40} max={100} />
                <p className="text-[8px] text-muted-foreground/70">ползунок: 0.2–3 МП · <span className="text-cyan-300/80">ручной ввод: до 16 MP</span></p>
              </div>
            </Hl>
          </div>
          <div className="space-y-1.5">
            <MockLabel>Длительность</MockLabel>
            <Hl n={3}>
              <div className="space-y-1">
                <MockSlider value={45} />
                <p className="text-[9px] text-muted-foreground/60">60–719 кадров · выравнивание 17n+5 · ≈ 2.5–30 с · <span className="text-cyan-300/80">ручной ввод кадров</span></p>
              </div>
            </Hl>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Пресеты и формат кадра', text: 'Качество финального видео: 480p — быстро, 720p — баланс, 1080p — детально, но дольше. Формат кадра выбирается отдельно: 16:9, вертикальное 9:16, квадрат 1:1, 4:3, 3:4 или кинематографичное 21:9. В режиме «Кадры» соотношение сторон автоматически берётся из первого кадра — селектор заблокирован, чтобы не растягивать оригинал.' },
      { n: 2, title: 'Свободное разрешение + ручной ввод', text: 'Выключает пресеты: задаёте итоговый размер в мегапикселях — ширина и высота считаются сами из выбранного формата. Ползунок идёт от 0.2 до 3 МП, а поле ручного ввода позволяет выйти за его рамки — до 16 MP (выше 3 MP — заметно больше VRAM и времени рендера).' },
      { n: 3, title: 'Длительность', text: 'От 2.5 до 30 секунд. Модель работает фиксированными «ступенями» кадров (17n+5), поэтому ползунок прыгает дискретно — это нормально, а не баг. Есть и ручной ввод кадров: значение подстраивается под сетку и границы модели (60–719 кадров). Длинные ролики (20–30 с) генерируются заметно дольше — держите это в уме.' },
    ],
    tip: 'Первые пробы делайте на 480p и короткой длительности — быстрее увидите результат и подберёте промпт.',
  },
  {
    id: 'queue',
    title: 'Запуск и очередь задач',
    short: 'Ставьте несколько видео подряд — очередь всё сделает.',
    mock: (
      <div className="w-full flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap justify-center">
          <Hl n={1}><MockCtaButton label="Сгенерировать видео" /></Hl>
          <Hl n={2}><MockCtaButton label="Ещё в очередь" /></Hl>
        </div>
        <Hl n={3}><MockQueuePill expanded /></Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Запуск', text: 'Одна кнопка — одна задача. Во время генерации подпись меняется на «Ещё в очередь» — так ставят несколько видео подряд.' },
      { n: 2, title: 'Несколько задач', text: 'Задачи выполняются по очереди: первая считается, вторая ждёт. Можно уйти в галерею или перезагрузить страницу — очередь продолжит работать.' },
      { n: 3, title: 'Плавающая очередь (правый нижний угол)', text: 'Статусы, проценты и счётчик задач. Клик — список; ✕ у задачи — отмена (выполняемая остановится, готовые файлы не пострадают).' },
    ],
    tip: 'Отмена — это не ошибка: вы увидите спокойное уведомление «Генерация отменена», а не красный алерт.',
  },
  {
    id: 'progress',
    title: 'Прогресс генерации',
    short: 'Общий прогресс 0→100% через оба прохода, живой черновик кадра.',
    mock: (
      <Stage>
        <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-1)] p-3 w-full max-w-[280px]">
          <Hl n={1}>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-cyan-400 font-medium">Генерация… 42%</span>
                <span className="text-muted-foreground font-mono">0:47</span>
              </div>
              <MockBar pct={42} />
            </div>
          </Hl>
          <Hl n={2}>
            <div className="rounded-lg border border-cyan-500/20 bg-black/40 h-20 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-cyan-950/60 to-blue-950/40" />
              <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[9px] text-cyan-300 font-medium">Pass 1 · шаг 2/3</div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-9 rounded bg-[var(--surface-3)]/60 border border-cyan-500/30 creative-pulse" />
              </div>
            </div>
          </Hl>
          <Hl n={3}>
            <p className="text-[10px] text-red-400/70 text-center py-0.5">Остановить</p>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Статус-карточка (низ левой панели)', text: 'Фаза («В очереди» → «Генерация… 42%» → «Готово ✓»), таймер и полоса прогресса.' },
      { n: 2, title: 'Живое превью и общий прогресс', text: 'Черновой кадр прямо во время генерации — и на первом, и на втором проходе. Полоса прогресса показывает ОБЩЕЕ выполнение (0→100%) через оба прохода — не сбрасывается между ними. Подпись «Pass 1 · шаг 2/3» — текущий проход внутри.' },
      { n: 3, title: 'Остановить', text: 'Прерывает ВСЕ активные видео-задачи; частичного файла не будет.' },
    ],
    tip: 'Видео ~5 секунд на 480p обычно занимает 1–3 минуты, на 1080p — заметно дольше.',
  },
  {
    id: 'gallery',
    title: 'Галерея готовых видео',
    short: 'Все ролики: hover-проигрывание, метки Upscale и DLSS 5.',
    mock: (
      <div className="w-full max-w-[330px]">
        <div className="flex items-center justify-between mb-1.5">
          <span className="px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-border text-[9px] text-foreground">5 видео</span>
          <span className="text-[10px] text-muted-foreground">↻</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <Hl n={1}><MockGalleryTile index={5} /></Hl>
          <Hl n={2}><MockGalleryTile hovered index={4} /></Hl>
          <Hl n={3}><MockGalleryTile index={3} /></Hl>
          <Hl n={4}><MockGalleryTile upscaled index={2} /></Hl>
          <MockGalleryTile index={1} />
          <MockGalleryTile index={0} />
        </div>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Постеры и порядок', text: 'Каждое видео — карточка с кадром-постером, новые сверху. Наведите курсор — ролик заиграет прямо в сетке (без звука).' },
      { n: 2, title: 'Действия при наведении', text: 'Шесть кнопок: открыть в плеере (⤢), скачать (⬇), метаданные (ⓘ), повторить генерацию (↻) — восстановит все параметры, отправить на апскейл (✦) и удалить (🗑).' },
      { n: 3, title: 'Бейдж времени', text: 'Светящаяся подпись «1 мин 12 сек» — сколько заняла ГЕНЕРАЦИЯ видео (не его длина), число берётся из метаданных.' },
      { n: 4, title: 'Метки апскейла', text: 'Вверху слева на карточке может гореть метка: «DLSS 5» (розовая) — результат нейрорендеринга, или «Upscale» (голубая) — результат RTX Video Super Resolution. Метка видна всегда, не только при наведении, — так не перепутаете апскейл-копию с исходным видео.' },
    ],
    tip: 'Стрелка ↻ обновляет список вручную — обычно он обновляется сам.',
  },
  /* (правка 91/122) Папки проектов — организация галереи, в туре не было */
  {
    id: 'folders',
    title: 'Папки проектов — порядок в галерее',
    short: 'Группируйте видео по проектам: создание, drag&drop, переименование.',
    mock: (
      <Stage>
        <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <MockLabel>Галерея · папки</MockLabel>
            <span className="text-[9px] text-muted-foreground">+ Новая папка</span>
          </div>
          <Hl n={1}>
            <div className="flex gap-1 flex-wrap">
              {['Все видео', 'Реклама', 'Отпуск', 'Тесты'].map((f, i) => (
                <span
                  key={f}
                  className={
                    i === 0
                      ? 'px-2 py-1 rounded-md text-[8px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium'
                      : 'px-2 py-1 rounded-md text-[8px] border border-border text-muted-foreground'
                  }
                >
                  {f}
                </span>
              ))}
            </div>
          </Hl>
          <Hl n={2}>
            <div className="grid grid-cols-3 gap-1.5">
              <MockGalleryTile index={5} />
              <MockGalleryTile index={4} />
              <div className="rounded-md border border-dashed border-cyan-500/40 bg-cyan-500/5 aspect-video flex items-center justify-center">
                <span className="text-[8px] text-cyan-300">↔ перетащите видео сюда</span>
              </div>
            </div>
          </Hl>
        </div>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Вкладка «Генерация»</p>
            <div className="rounded-md border border-border bg-[var(--surface-2)] px-2 py-1.5 text-[9px] text-foreground/80">
              📁 Папка проекта: <span className="text-cyan-300">Отпуск</span> ▾
            </div>
            <p className="text-[9px] text-muted-foreground leading-relaxed">Новые видео лягут в выбранную папку</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Папки в галерее', text: 'Кнопка «Новая папка» создаёт подпапку в output — группируйте видео по проектам («Реклама», «Отпуск»…). Клик по папке фильтрует сетку; «Все видео» показывает всё подряд. Пустую папку можно удалить, непустую — сначала очистить.' },
      { n: 2, title: 'Перетаскивание и переименование', text: 'Видео перетаскивается в папку drag-and-drop прямо по карточке. Имя папки можно поменять — видео внутри останутся на месте. Файлы не копируются, а переезжают, поэтому метаданные и бейджи времени никуда не теряются.' },
      { n: 3, title: 'Папка на вкладке «Генерация»', text: 'Рядом с кнопкой генерации есть выбор папки проекта (появляется, когда папки уже созданы): все новые видео этой сессии лягут в неё. Выбор папки на вкладке «Генерация» не зависит от фильтра в «Галерее» — у каждой вкладки свой актив.' },
    ],
    tip: 'Метаданные и бейджи времени переезжают вместе с видео — ничего не теряется.',
  },
  {
    id: 'player',
    title: 'Видеоплеер',
    short: 'Клик по видео — пауза, клик по чёрному — закрыть.',
    mock: (
      <div className="w-full max-w-[320px] space-y-2">
        <Hl n={1}><MockLightbox /></Hl>
        <Hl n={2}>
          <div className="flex items-center justify-center gap-3 text-[9px] text-muted-foreground border border-border rounded-lg py-1.5 bg-[var(--surface-2)]/60">
            <span>Space — пауза</span><span>M — звук</span><span>←→ — видео</span><span>Esc — выход</span>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="flex items-center justify-center gap-3 text-[10px]">
            <span className="p-1.5 rounded-lg bg-white/10 text-white">⬇ Скачать</span>
            <span className="p-1.5 rounded-lg bg-red-500/40 text-white">🗑 Удалить</span>
          </div>
        </Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Плеер на весь экран', text: 'Открывается из галереи (⤢ или клик по карточке). Клик по САМОМУ ВИДЕО — пауза/воспроизведение, клик по чёрной области вокруг — закрыть плеер. Полоса внизу — перемотка.' },
      { n: 2, title: 'Горячие клавиши', text: 'Space — пауза, M — звук, стрелки ← → — следующее/предыдущее видео, Esc — выход.' },
      { n: 3, title: 'Скачивание и удаление', text: '⬇ сохраняет файл на диск (имя начинается с Minimax_Studio). Корзина удаляет видео из папки вывода после подтверждения — файл пропадёт и с диска.' },
    ],
    tip: 'Звук генерируется тоже: модель озвучивает реплики из <d>…</d> и учитывает аудио-референсы.',
  },
  {
    id: 'upscale',
    title: 'Upscale — сделать видео чётче',
    short: 'Два режима: Neural Rendering (DLSS 5) и RTX VSR 1×–4× (HDR отключён).',
    mock: (
      <Stage>
        <Hl n={1}><MockUpscalePanel /></Hl>
        <Hl n={2}>
          <div className="w-[220px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <p className="text-[10px] font-semibold text-foreground">Результат — в общей галерее</p>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-1.5 space-y-1">
                <span className="inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[7px] font-semibold text-sky-300 border border-sky-400/40">✦ Upscale</span>
                <p className="text-[7px] text-muted-foreground">RTX VSR</p>
              </div>
              <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-1.5 space-y-1">
                <span className="inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[7px] font-semibold text-fuchsia-300 border border-fuchsia-400/40">✦ DLSS 5</span>
                <p className="text-[7px] text-muted-foreground">Neural Rendering</p>
              </div>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[180px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1">
            <p className="text-[10px] font-semibold text-foreground">Требования</p>
            <p className="text-[9px] text-muted-foreground">• видеокарта NVIDIA RTX</p>
            <p className="text-[9px] text-muted-foreground">• только видео (MP4 / MOV / MKV…)</p>
            <p className="text-[9px] text-muted-foreground">• обработка — на вашей GPU</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Два режима обработки', text: 'Neural Rendering (DLSS 5) — нейросеть «перерисовывает» кадр: настраиваются шум, тон, структура и выбирается пресет — качество растёт, но скорость падает. RTX Video Super Resolution — ускорение 1×–4× (включая 1.5×; HDR отключён — H.264 не поддерживает HDR-вывод) — быстрее и легче для GPU. Режим выбирается прямо на вкладке, кнопка запуска меняется под него.' },
      { n: 2, title: 'Куда попадает результат', text: 'Апскейл-видео сохраняется в общую «Галерею» вместе с остальными роликами и получает метку: «Upscale» (голубая) — RTX VSR или «DLSS 5» (розовая) — Neural Rendering. Метка видна на карточке всегда — исходник и улучшенную копию не перепутать.' },
      { n: 3, title: 'Требования', text: 'Нужна видеокарта NVIDIA RTX; обрабатываются только видеофайлы (MP4 / MOV / MKV и др.). Всё считается локально, на вашей GPU — файл никуда не отправляется.' },
    ],
    tip: 'Не уверены, какой режим выбрать — начните с RTX VSR 2×: быстрее всего и обычно достаточно для «зерна» и размытия.',
  },
  {
    id: 'meta',
    title: 'Метаданные — рецепт видео',
    short: 'Промпт + seed = точное повторение удачного видео.',
    mock: (
      <Stage>
        <div className="flex items-center gap-4 flex-wrap justify-center">
          <Hl n={1}><MockMetaDialog /></Hl>
          <Hl n={2}>
            <div className="w-[120px] aspect-video rounded-lg border border-border bg-[var(--surface-2)] relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-violet-900/30 to-cyan-900/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="p-1.5 rounded-lg bg-white/20 text-[10px] text-white">ⓘ</span>
              </div>
            </div>
          </Hl>
        </div>
        <Hl n={3}>
          <div className="flex items-center gap-2 justify-center rounded-lg border border-border bg-[var(--surface-2)]/60 px-4 py-1.5 text-[10px] text-muted-foreground">
            📋 Скопировать промпт и seed → повторить генерацию
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Что внутри', text: 'Промпт, seed, разрешение, шаги (pass 1 + pass 2), референсы и их роли, время генерации и дата — полный рецепт того, КАК получено видео.' },
      { n: 2, title: 'Как открыть', text: 'Кнопка ⓘ на карточке в галерее (при наведении).' },
      { n: 3, title: 'Повторить результат', text: 'Понравилось? Скопируйте промпт и seed из метаданных и выставьте те же параметры — генерация воспроизведётся почти идентично.' },
    ],
    tip: 'Метаданные лежат рядом с видео в файле <имя>.meta.json — при переносе папки копируйте и его.',
  },
  /* ═══════════════ ЧАСТЬ 3. ГЛУБЖЕ ═══════════════ */
  {
    id: 'advanced',
    title: 'Дополнительные параметры генерации',
    short: 'Два прохода, шаги (2–30, ручные до 128), seed. Можно смело пропустить.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2.5">
          <p className="text-[10px] text-muted-foreground">▼ Дополнительные параметры</p>
          <Hl n={1}>
            <div className="space-y-2">
              <div className="space-y-1">
                <MockLabel>Pass 1: Low-res (MP)</MockLabel>
                <MockSlider value={20} max={200} />
                <p className="text-[8px] text-muted-foreground/70">ползунок 0.2–0.5 МП · <span className="text-cyan-300/80">не больше финального разрешения</span></p>
              </div>
              <div className="space-y-1">
                <MockLabel>Pass 1: Шаги сэмплера</MockLabel>
                <MockSlider value={13} max={100} />
                <p className="text-[8px] text-muted-foreground/70">ползунок 2–30 · по умолчанию 4 · <span className="text-cyan-300/80">ручной ввод: 1–128</span></p>
              </div>
              <div className="space-y-1">
                <MockLabel>Pass 1: Сэмплер / Планировщик · Рефы</MockLabel>
                <MockSelect value="euler · simple · Match (быстро)" />
              </div>
              <div className="space-y-1">
                <MockLabel>Pass 2: Sigma-профиль (шаги)</MockLabel>
                <MockSelect value="3 шага (быстрее) · 4–7 — качество" />
              </div>
            </div>
          </Hl>
          <Hl n={2}>
            <div className="space-y-1.5">
              <MockToggle on label="Low VRAM Attention" />
              <p className="text-[8px] text-muted-foreground/70 -mt-0.5">и Chunk FeedForward — в Настройки → Оптимизация</p>
            </div>
          </Hl>
          <Hl n={3}>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <MockLabel>Seed</MockLabel>
                <span className="text-[10px] font-mono text-muted-foreground">-1 (случайный)</span>
              </div>
              <p className="text-[8px] text-muted-foreground/70">сила турбо-лоры настраивается в Настройки → Общие → LoRAs</p>
            </div>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Два прохода + ручной ввод', text: 'Сначала Pass 1 — дешёвый черновик в низком разрешении (0.2–0.5 МП; потолок автоматически не выше финального разрешения — черновик не бывает крупнее финала). Затем Pass 2 — финальная доработка качества (Sigma-профиль 3–7 шагов, по умолчанию 3). Шаги pass 1: ползунок 2–30, по умолчанию 4, ручной ввод 1–128. Сэмплер и планировщик для обоих проходов по умолчанию — euler/simple, у референсов есть режим размера Match/Max. Больше шагов — точнее и дольше.' },
      { n: 2, title: 'Оптимизации памяти', text: 'Low VRAM Attention и Chunk FeedForward экономят видеопамять — стоят в Настройки → Оптимизация, а не в форме генерации. Если генерация падает с нехваткой VRAM — оставьте их включёнными или снизьте разрешение.' },
      { n: 3, title: 'Seed', text: '«Зерно» случайности: -1 = каждый раз новое. Понравился результат — возьмите seed из метаданных и повторите с ним.' },
    ],
    tip: 'Новичку этот блок можно не открывать — значения по умолчанию подобраны для быстрого старта.',
  },
  {
    id: 'lora',
    title: 'LoRA-модели — стиль и скорость',
    short: 'Турбо-лора (4 шага), кастомные LoRA: сила 0.1–2.0, триггеры.',
    mock: (
      <Stage>
        <Hl n={1}><MockLoraList /></Hl>
        <Hl n={2}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Зачем LoRA</p>
            <p className="text-[9px] text-muted-foreground leading-relaxed">LoRA — «надстройка» над основной моделью: добавляет стиль, персонажа или режим работы (турбо).</p>
            <p className="text-[9px] text-foreground/80">Сила 0.1–2.0 · триггеры подставляются в промпт автоматически</p>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[190px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Где живут</p>
            <p className="text-[9px] text-muted-foreground">Настройки → Общие → LoRAs</p>
            <p className="text-[9px] text-muted-foreground">Файл копируется в папку LoRA программы</p>
            <p className="text-[9px] text-muted-foreground">Прогресс копирования виден в списке</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Список LoRA', text: 'Первая строка — встроенная турбо-лора (бейдж «Турбо», 1.5 ГБ): ускоряет генерацию, работает в связке с 4 шагами pass 1. У каждой LoRA: переключатель вкл/выкл и ползунок силы 0.1–2.0. Кастомные LoRA дополнительно имеют поле триггерных слов — при включённой LoRA они автоматически добавляются к промпту.' },
      { n: 2, title: 'Зачем LoRA', text: 'LoRA — небольшая «надстройка» поверх основной модели: может добавлять стиль, персонажа, предмет или режим работы (как турбо). Сила регулируется ползунком: 0.1 — едва заметно, 2.0 — максимально выраженно. У турбо-лоры триггеров нет — она не влияет на промпт.' },
      { n: 3, title: 'Добавить свою LoRA', text: 'Кнопка «Добавить» (Настройки → Общие → LoRAs): выбираете файл — он копируется в папку LoRA программы, прогресс копирования виден в списке. Закрыть окно настроек можно в любой момент — копирование продолжится в фоне.' },
    ],
    tip: 'Если LoRA работает, но картинка «разваливается» — вероятно, несовместимость с базовой моделью: переключите основную модель на альтернативную (Настройки → Общие).',
  },
  /* ═══════════════ ЧАСТЬ 4. НАСТРОЙКИ ═══════════════ */
  {
    id: 'settings-general',
    title: 'Настройки → Общие и Внешний вид',
    short: 'Модели, перенос, основная модель + тема и звук.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsGeneral /></Hl>
        <Hl n={2}><MockSettingsAppearance /></Hl>
        <Hl n={3}>
          <div className="w-[210px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Список вкладок настроек</p>
            <p className="text-[9px] text-muted-foreground">Общие · Внешний вид · LLM · Голос</p>
            <p className="text-[9px] text-muted-foreground">Оптимизация · ComfyUI · Ссылки · Сброс</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Модели и перенос', text: '«Перенос моделей из старой версии» — выбираете папку со старой сборкой, программа сама найдёт папку models и перенесёт содержимое. «Основная модель» — базовая (MiniMax H3 FastVideo int8), а рядом — переключатель альтернативной модели из папки diffusion_models: пригодится, если с LoRA базовая модель «разваливает» картинку. Скачивание моделей (и копирование LoRA) не прерывается закрытием окна настроек. Bonsai light (маленькая версия) — optional, баннер не требует.' },
      { n: 2, title: 'Внешний вид', text: 'Отдельная вкладка: тема оформления — Серая (по умолчанию) или Чёрная, — и звуковой сигнал при завершении генерации (можно выключить).' },
      { n: 3, title: 'Восемь вкладок', text: 'Полный список: Общие, Внешний вид, LLM, Голос, Оптимизация, ComfyUI, Ссылки, Сброс. Каждая — свой инструмент: от моделей до опасной зоны.' },
    ],
    tip: 'Если LoRA работает, но картинка разваливается — вероятно, несовместимость с базовой моделью: переключите основную модель на альтернативную.',
  },
  {
    id: 'settings-llm-voice',
    title: 'Настройки → LLM и Голос',
    short: 'Модель ассистента, контекст, KV-кэш + диктовка голосом.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsLlm /></Hl>
        <Hl n={2}><MockSettingsVoice /></Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Ассистент и память', text: 'Модель ассистента: по умолчанию Bonsai 2 27B (тернарная, ~7.8 ГБ, vision). Альтернативы: Gemma 4 12B (Q3/Q4/Q5) или Qwen3.5 9B — выбирайте под свою видеокарту. Устройство: Авто / GPU / CPU. Контекст: 8K–100K токенов, по умолчанию 25K. «Видение видео» по умолчанию ВКЛЮЧЕНО — ассистент видит кадры видео; можно выключить для экономии контекста. Квантизация KV-кэша (Выкл / Q8 / Q5 / Q4) — экономит память длинных диалогов, по умолчанию Q4.' },
      { n: 2, title: 'Голосовой ввод', text: 'Whisper-распознавание работает на CPU и не трогает видеопамять. Вкл/выкл, модель распознавания (small/medium — лучше для русского), язык. Живой тест: запись → распознанный текст. Кнопка микрофона появляется в поле промпта, полноэкранном редакторе и чате Ассистента. Горячая клавиша: R (англ.) / К (рус.) — одна физическая клавиша в обеих раскладках; диктовку можно запустить и остановить клавишей, не трогая мышку. Не срабатывает во время набора текста в полях (чтобы не ломать ввод R/К) и с зажатыми Ctrl/Alt/Meta.' },
    ],
    tip: 'Если на 8–12 ГБ VRAM генерация «лагает» — оставьте Bonsai 2 27B (~7.8 ГБ) или поставьте Qwen3.5 9B / Gemma Q3 и поднимите резерв VRAM (вкладка «Оптимизация»).',
  },
  {
    id: 'settings-opt-comfy',
    title: 'Настройки → Оптимизация, ComfyUI, Ссылки, Сброс',
    short: 'VRAM, диагностика, ручные загрузки и опасная зона.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsOpt /></Hl>
        <Hl n={2}><MockSettingsComfyLinks /></Hl>
        <Hl n={3}><MockSettingsDanger /></Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Оптимизация памяти', text: 'Резерв VRAM (1–8 ГБ, по умолчанию 3) и Dynamic VRAM управляют видеопамятью ComfyUI — применяются после перезапуска ComfyUI. Low VRAM Attention и Chunk FeedForward экономят память прямо во время генерации — действуют сразу на новые генерации, без перезапуска. Если генерация падает с нехваткой VRAM — включите оба и/или снизьте разрешение.' },
      { n: 2, title: 'ComfyUI и Ссылки', text: 'Вкладка ComfyUI: статус, версия, Python, видеокарта, свободная VRAM — кнопка «Перепроверить». Вкладка Ссылки: прямые URL на каждую модель для ручной загрузки (копирование в один клик) + подсказка про зеркало hf-mirror.com, если Hugging Face недоступен.' },
      { n: 3, title: 'Сброс (опасная зона)', text: '«Сброс настроек» — все параметры к значениям по умолчанию. «Очистить кэш» — папка input ComfyUI (референсы и временные файлы). «Удалить контент» — папка output со всеми видео + чаты ассистента + история промптов. Каждое действие требует подтверждения.' },
    ],
    tip: 'После «Сбросить настройки» ассистенту стоит дать полный контекст — дефолтных 25K токенов достаточно для инструкций.',
  },
  /* ═══════════════ ФИНАЛ ═══════════════ */
  {
    id: 'checklist',
    title: 'Чек-лист первой генерации',
    short: 'Семь пунктов с нуля — и первое видео готово.',
    mock: (
      <div className="w-full max-w-[400px] space-y-3">
        <Hl n={1}>
          <div className="rounded-xl border border-cyan-500/20 bg-[var(--surface-2)]/60 p-4 space-y-2.5 w-full">
            {[
              'Скачайте модели (окно приветствия → Настройки → скачать; загрузка — в фоне)',
              'Выберите режим: Текст / Кадры / Референсы',
              'Загрузите референсы (если режим «Референсы») — или сразу без них',
              'Опишите сцену в промпте — текст, голосом (🎙) или через Ассистента (Bonsai 2 27B)',
              'Привяжите референсы через @, реплики — в <d>…</d>',
              'Поставьте 480p и короткую длительность',
              'Нажмите «Сгенерировать видео» и следите за превью',
              'Готово: смотрите в галерее, рецепт — под ⓘ, чётче — «Upscale» (DLSS 5 / RTX VSR)',
            ].map((t, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <span className="w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                <span className="text-xs text-foreground/90">{t}</span>
              </div>
            ))}
          </div>
        </Hl>
        <Hl n={2}>
          <div className="flex items-center gap-2 justify-center rounded-lg border border-border bg-[var(--surface-2)]/60 px-4 py-2 text-[10px] text-muted-foreground">
            ▶ Если что-то не так — перезапустите start.bat
          </div>
        </Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Поздравляем — тур пройден!', text: 'Сделайте первую генерацию по чек-листу, а в метаданных смотрите, какие настройки на что влияют. Вернуться к туру можно в любой момент через вкладку «Обучение».' },
      { n: 2, title: 'Если что-то пошло не так', text: 'Красный индикатор ComfyUI или ошибка генерации → перезапустите start.bat. «ComfyUI недоступен» во время генерации — обычно сам проходит, не прерывайте. Не нравится результат — смените seed (поставьте -1) или попросите Ассистента переписать промпт.' },
    ],
  },
]
