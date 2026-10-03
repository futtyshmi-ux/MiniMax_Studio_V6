'use client'

/**
 * useImprovePrompt — single entry point for "Улучшить промпт".
 *
 * Queues the improve-prompt request in the assistant-chats store (so it
 * survives a tab switch), then asks the app shell to switch to the
 * assistant tab. AssistantView picks it up on mount and auto-runs the
 * completion.
 */
import { useCallback } from 'react'
import { useAssistantChats } from '@/lib/assistant-chats-store'

/** Build the user-facing prompt text. */
export function buildImprovePrompt(currentPrompt: string): string {
  const trimmed = currentPrompt.trim()
  return trimmed
    ? `Улучши мой текущий промпт, сохранив смысл. Текущий промпт:\n\n${trimmed}`
    : 'Предложи 3 разных идеи для короткого видео (5–8 секунд) с референсами, которые я прикреплю.'
}

/**
 * Queue an improve-prompt request and switch to the assistant tab.
 * Safe to call from anywhere (the store is a module singleton).
 */
export function requestImprovePrompt(currentPrompt: string): void {
  if (typeof window === 'undefined') return

  const content = buildImprovePrompt(currentPrompt)
  // Create a fresh chat so the improve request is isolated from the user's
  // ongoing conversation, then queue the auto-run for the view to pick up.
  useAssistantChats.getState().createChat()
  useAssistantChats.getState().queueImprove(content)

  // Ask the app shell to switch to the assistant tab.
  window.dispatchEvent(new CustomEvent('h3:goto-assistant'))
}

/**
 * Hook wrapper (so callers can memoize if needed). Returns a stable callback.
 */
export function useImprovePrompt() {
  return useCallback(
    (currentPrompt: string) => {
      requestImprovePrompt(currentPrompt)
    },
    [],
  )
}
