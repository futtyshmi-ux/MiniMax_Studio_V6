'use client'

/**
 * Splash (правка 97) — экран-заставка на время загрузки ComfyUI.
 *
 * start.bat открывает браузер сразу после старта веб-сервера (не дожидаясь
 * ComfyUI) на /splash. Здесь: видео-заставка в центре (public/splash.mp4 —
 * кладётся вручную; пока файла нет, показывается анимированная заглушка),
 * подписи «by Evgen Rublev» / «Comfy UI» под видео, индикатор загрузки.
 *
 * Готовность ComfyUI опрашивается через /api/comfy/health; как только
 * сервер отвечает — плавный переход в приложение (router.replace('/')).
 *
 * Оформление строится на CSS-переменных темы (--surface-*, --foreground),
 * поэтому заставка автоматически следует светлой/тёмной теме приложения.
 *
 * (правка 115) Видео-заставка увеличена в 1,5 раза (900 → 1350 px);
 * заглушка, лого и строка подписей приведены к новой ширине.
 */
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const POLL_MS = 2000
/** Пауза на «Готово» перед переходом, мс. */
const EXIT_DELAY_MS = 700

/** (правка 129) Пауза перед стартом видео-заставки, мс — видео запускается
 * не сразу при открытии страницы, а через 2 секунды. */
const VIDEO_START_DELAY_MS = 2000

export default function SplashPage() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [videoMissing, setVideoMissing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(Date.now())

  /* (правка 129) Отсрочка старта видео: страница открывается → 2 с паузы →
   * video.play(). Если ComfyUI поднимется за это время, переход в студию
   * произойдёт раньше, чем видео успеет стартовать (play() не вызовется). */
  useEffect(() => {
    const id = setTimeout(() => {
      const v = videoRef.current
      if (v) {
        v.play().catch(() => { /* автоплей может быть заблокирован — молча игнорируем */ })
      }
    }, VIDEO_START_DELAY_MS)
    return () => clearTimeout(id)
  }, [])

  /* Опрос готовности ComfyUI. Ссылка на контроллер — чтобы таймеры не
   * стреляли после размонтирования при переходе в приложение. */
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const r = await fetch('/api/comfy/health', { signal: AbortSignal.timeout(8000) })
        if (!cancelled && r.ok) {
          const d = await r.json().catch(() => ({}))
          if (d.ok !== false) {
            setReady(true)
            setTimeout(() => router.replace('/'), EXIT_DELAY_MS)
            return
          }
        }
      } catch {
        /* ComfyUI ещё грузится (или веб-сервер сам ещё стартует) — ждём */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [router])

  /* Счётчик секунд загрузки — чтобы было видно, что всё живо. */
  useEffect(() => {
    if (ready) return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [ready])

  /* ComfyUI не поднялся за ~5 минут — честно сообщаем, но продолжаем ждать:
   * консоль стартового .bat тем временем печатает детали. */
  useEffect(() => {
    if (elapsed > 300 && !failed) setFailed(true)
  }, [elapsed, failed])

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden bg-[var(--surface-0)]">
      {/* ── Фон: «полярное сияние» из цветов темы, медленно дышит ── */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute -top-[30%] -left-[20%] w-[70%] h-[70%] rounded-full blur-[120px] opacity-25 animate-[splash-drift_14s_ease-in-out_infinite]"
          style={{ background: 'radial-gradient(circle, var(--splash-a, #f59e0b), transparent 70%)' }}
        />
        <div
          className="absolute -bottom-[35%] -right-[15%] w-[75%] h-[75%] rounded-full blur-[130px] opacity-25 animate-[splash-drift_18s_ease-in-out_infinite_reverse]"
          style={{ background: 'radial-gradient(circle, var(--splash-b, #8b5cf6), transparent 70%)' }}
        />
        <div
          className="absolute top-[20%] right-[10%] w-[40%] h-[40%] rounded-full blur-[100px] opacity-20 animate-[splash-drift_22s_ease-in-out_infinite]"
          style={{ background: 'radial-gradient(circle, var(--splash-c, #06b6d4), transparent 70%)' }}
        />
        {/* Тонкая сетка — глубина без визуального шума */}
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              'linear-gradient(var(--foreground) 1px, transparent 1px), linear-gradient(90deg, var(--foreground) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
          }}
        />
      </div>

      {/* ── Центр: видео-заставка (или заглушка, пока файла нет) ── */}
      <div className="relative z-10 flex flex-col items-center">
        <div
          className="relative rounded-2xl overflow-hidden border border-border/70 shadow-2xl"
          style={{ boxShadow: '0 0 60px -12px var(--splash-glow, rgba(245,158,11,0.35)), 0 24px 60px -20px rgba(0,0,0,0.6)' }}
        >
          {videoMissing ? (
            /* Болванка: видео ещё не положили — анимированный градиент с лого */
            <div className="w-[1350px] max-w-[94vw] aspect-[1952/800] flex items-center justify-center bg-[var(--surface-2)]">
              <div className="absolute inset-0 animate-[splash-shift_6s_ease-in-out_infinite] opacity-40"
                style={{ background: 'linear-gradient(120deg, var(--splash-a, #f59e0b), var(--splash-b, #8b5cf6), var(--splash-c, #06b6d4), var(--splash-a, #f59e0b))', backgroundSize: '300% 300%' }}
              />
              <img src="/logo.svg" alt="" className="relative w-[120px] h-[120px] opacity-90 animate-[splash-breathe_3s_ease-in-out_infinite]" />
            </div>
          ) : (
            /* Видео-заставка: ОДИН проход без звука; по окончании — стоп на
             * первом кадре (currentTime=0 + pause), кадр висит, пока грузится
             * программа. Повторного воспроизведения нет.
             * (правка 129) автоплей убран — запуск видео отложен на 2 секунды
             * (effect выше), до этого первый кадр лежит статично. */
            <video
              ref={videoRef}
              src="/splash.mp4"
              muted
              playsInline
              preload="auto"
              onEnded={() => {
                const v = videoRef.current
                if (!v) return
                v.currentTime = 0
                v.pause()
              }}
              onError={() => setVideoMissing(true)}
              className="w-[1350px] max-w-[94vw] bg-[var(--surface-2)]"
            />
          )}
        </div>

        {/* Подписи под видео: слева автор, справа движок */}
        <div className="w-[1350px] max-w-[94vw] flex items-center justify-between mt-2 px-1">
          <span className="text-[11px] text-muted-foreground/80 tracking-wide">by Evgen Rublev</span>
          <span className="text-[11px] text-muted-foreground/80 tracking-wide font-medium">Comfy UI</span>
        </div>

        {/* ── Статус загрузки ── */}
        <div className="mt-10 flex flex-col items-center gap-3">
          {ready ? (
            <>
              <div className="flex items-center gap-2 text-emerald-400">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span className="text-sm font-medium">Готово — открываем студию…</span>
              </div>
            </>
          ) : (
            <>
              {/* Бегущая полоска-шиммер */}
              <div className="w-64 h-1 rounded-full bg-[var(--surface-2)] overflow-hidden relative">
                <div
                  className="absolute inset-y-0 w-1/3 rounded-full animate-[splash-slide_1.6s_ease-in-out_infinite]"
                  style={{ background: 'linear-gradient(90deg, transparent, var(--splash-a, #f59e0b), transparent)' }}
                />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {failed
                  ? 'ComfyUI стартует дольше обычного — детали в окне консоли…'
                  : 'Идёт загрузка ComfyUI…'}
                {' · '}
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Ключевые кадры анимаций (tailwind arbitrary + <style>, чтобы не
          плодить классы в globals.css ради одной страницы) */}
      <style>{`
        @keyframes splash-drift {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(4vw, 3vh) scale(1.08); }
          66% { transform: translate(-3vw, -2vh) scale(0.95); }
        }
        @keyframes splash-slide {
          0% { left: -35%; }
          100% { left: 100%; }
        }
        @keyframes splash-shift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        @keyframes splash-breathe {
          0%, 100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.08); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
