import { NextResponse } from 'next/server'
import { llmStatus, activeLlmModelId, llmModelPath, llmBackend, llmBonsaiPaths } from '@/lib/llm-runner'
import { llmStreaming, comfyBusy, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { existsSync, statSync } from 'fs'

export const dynamic = 'force-dynamic'

/** GET /api/llm/status — runner state + model presence (for the chat tab). */
export async function GET() {
  const s = llmStatus()
  // (правка 136) Для Bonsai «модель» — GGUF во внешней папке сборки.
  const modelFile = llmBackend() === 'bonsai' ? llmBonsaiPaths().model : llmModelPath()
  let modelBytes = 0
  try {
    modelBytes = statSync(modelFile).size
  } catch {
    modelBytes = 0
  }
  return NextResponse.json({
    ...s,
    // Ассистент сейчас стримит ответ (блокировка генерации)
    streaming: llmStreaming(),
    // Ассистент занят: грузит модель (chatActive) ИЛИ пишет ответ —
    // именно это состояние должно блокировать кнопку генерации в UI
    assistantBusy: assertGenerationAllowed() !== null,
    // Идёт генерация видео — блокировка чата в UI
    blockedByGeneration: await comfyBusy(),
    modelId: activeLlmModelId(),
    modelBytes,
    modelReady: s.modelExists && modelBytes > 100_000_000,
    // Cheap existence check that also works before any spawn
    fileExists: existsSync(modelFile),
  })
}
