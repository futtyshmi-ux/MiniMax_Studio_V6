'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { StudioSidebar, TabType } from '@/components/h3/sidebar'
import { GenerateView } from '@/components/h3/generate-view'
import { UpscaleView } from '@/components/h3/upscale-view'
import { GalleryView } from '@/components/h3/gallery-view'
import { LearnView } from '@/components/h3/learn/learn-view'
import { AssistantView } from '@/components/h3/assistant/assistant-view'
import { QueueIndicator } from '@/components/queue-indicator'
import { SettingsDialog } from '@/components/h3/settings-dialog'
// (правка 112) Всплывающее окно с краткой инструкцией при первом запуске
import { WelcomeDialog } from '@/components/h3/welcome-dialog'
import { ModelsWarningBanner } from '@/components/h3/models-warning-banner'
import { initAssistantChatsSync } from '@/lib/assistant-chats-sync'

const TAB_CONTENT = {
  generate: GenerateView,
  upscale: UpscaleView,
  gallery: GalleryView,
  learn: LearnView,
  assistant: AssistantView,
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabType>('generate')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // (правка 112) Приветственное окно при первом запуске.
  // (правка 113) Флаг «не показывать» пишется ТОЛЬКО если пользователь
  // поставил галочку; иначе окно появляется при каждом запуске.
  // Инициализируется в useEffect — SSR не читает localStorage.
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  useEffect(() => {
    try {
      if (!localStorage.getItem('h3_welcome_seen_v1')) setWelcomeOpen(true)
    } catch { /* приватный режим и т.п. — просто не показываем */ }
  }, [])
  const closeWelcome = (dontShowAgain: boolean) => {
    if (dontShowAgain) {
      try {
        localStorage.setItem('h3_welcome_seen_v1', '1')
      } catch { /* ignore */ }
    }
    setWelcomeOpen(false)
  }

  // (правка 116) «Показать окно приветствия» из Настройки → Общие:
  // компонент шлёт событие h3:show-welcome (флаг уже сброшен им),
  // мы просто открываем окно поверх.
  useEffect(() => {
    const showWelcome = () => setWelcomeOpen(true)
    window.addEventListener('h3:show-welcome', showWelcome)
    return () => window.removeEventListener('h3:show-welcome', showWelcome)
  }, [])

  // Cross-component navigation (e.g. MetaDialog's "→ В редактор" button,
  // or the prompt editor's "Улучшить промпт" → assistant tab)
  useEffect(() => {
    const gotoGenerate = () => setActiveTab('generate')
    const gotoUpscale = () => setActiveTab('upscale')
    const gotoAssistant = () => setActiveTab('assistant')
    window.addEventListener('h3:goto-generate', gotoGenerate)
    window.addEventListener('h3:goto-upscale', gotoUpscale)
    window.addEventListener('h3:goto-assistant', gotoAssistant)
    return () => {
      window.removeEventListener('h3:goto-generate', gotoGenerate)
      window.removeEventListener('h3:goto-upscale', gotoUpscale)
      window.removeEventListener('h3:goto-assistant', gotoAssistant)
    }
  }, [])

  // (правка 73) Синхронизация чатов ассистента с файлом проекта
  // (data/assistant-chats.json) — переносимое хранилище.
  useEffect(() => {
    initAssistantChatsSync()
  }, [])

  const ContentComponent = TAB_CONTENT[activeTab]

  return (
    <div className="h-screen w-screen flex overflow-hidden">
      {/* Sidebar */}
      <StudioSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main Content */}
      <main className="flex-1 min-w-0 relative flex flex-col">
        {/* Models not downloaded warning */}
        <ModelsWarningBanner onOpenSettings={() => setSettingsOpen(true)} />

        <div className="flex-1 min-h-0 relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="h-full flex"
          >
            <ContentComponent />
          </motion.div>
        </AnimatePresence>
        </div>

        {/* Queue indicator — bottom-right floating */}
        <QueueIndicator />
      </main>

      {/* Settings dialog (connection, GPU memory) — opened from the sidebar */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* (правка 112) Приветствие при первом запуске — поверх всего */}
      <AnimatePresence>
        {welcomeOpen && (
          <WelcomeDialog
            onClose={closeWelcome}
            onOpenSettings={(dontShowAgain) => {
              closeWelcome(dontShowAgain)
              setSettingsOpen(true)
            }}
            onGoLearn={(dontShowAgain) => {
              closeWelcome(dontShowAgain)
              setActiveTab('learn')
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
