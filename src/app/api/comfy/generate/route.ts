import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { submitVideo, uploadImage } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { readStaged, deleteStaged } from '@/lib/staging'
import { recordPendingMeta } from '@/lib/pending-meta'
import { loadLoras, listLoraFiles, TURBO_LORA_NAME } from '@/lib/loras-config'
import { getAppConfig } from '@/lib/app-config'
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import type { MiniMaxH3Params } from '@/lib/comfy/minimax-h3-template'

/**
 * POST /api/comfy/generate
 * Body: MiniMaxH3Params (prompt, refImages[], aspectRatio, duration, seed, finalResolution?, lowResMP?, sigmaVariant?)
 * If refImages contains base64 data, uploads them first.
 * Staged reference names (uploaded while ComfyUI was down) are transferred
 * to ComfyUI's input/ here; the response carries `staged_transfers`
 * (stagedName → comfyName) so the client can update its references.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as MiniMaxH3Params & { refImagesBase64?: string[] }

    if (!body?.prompt) {
      return NextResponse.json({ error: 'Prompt is required.' }, { status: 400 })
    }

    // (правка 91) Папка проекта: один санитизированный сегмент, максимум 60
    // символов — дальше уходит в filename_prefix VHS («folder/Minimax_Studio»)
    // и в пути сайдкаров. Клиент шлёт '' (общая) или имя существующей папки.
    body.outputSubfolder = path.basename(String(body.outputSubfolder ?? '')).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60)

    // Fast-path 409 (до загрузки референсов): ассистент занят — не тратим
    // время на upload и не оставляем осиротевших файлов в input/ ComfyUI.
    // Полная проверка выполняется под mutex в runGeneration.
    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    // Upload base64 images if provided
    if (body.refImagesBase64?.length) {
      for (let i = 0; i < body.refImagesBase64.length; i++) {
        const b64 = body.refImagesBase64[i].replace(/^data:image\/\w+;base64,/, '')
        const buf = Buffer.from(b64, 'base64')
        const ext = body.refImagesBase64[i].includes('/png') ? 'png' : 'jpg'
        const name = `ref_${Date.now()}_${i}.${ext}`
        const uploaded = await uploadImage(buf, name)
        body.refImages = body.refImages || []
        body.refImages[i] = uploaded
      }
    }

    // Transfer staged reference files (uploaded while ComfyUI was down)
    const transfers: Record<string, string> = {}
    const transferStaged = async (name: string) => {
      const staged = await readStaged(name)
      if (staged) {
        const comfyName = await uploadImage(staged, name)
        transfers[name] = comfyName
        // Локальную копию удаляем: клиент обновляет пути через
        // staged_transfers, а .local-input/ иначе растёт бесконечно и
        // продолжает затенять превью (file-роут смотрит staging первым).
        await deleteStaged(name)
        return comfyName
      }
      return name
    }
    if (body.refImages?.length) {
      for (let i = 0; i < body.refImages.length; i++) {
        body.refImages[i] = await transferStaged(body.refImages[i])
      }
    }
    if (body.refVideos?.length) {
      for (let i = 0; i < body.refVideos.length; i++) {
        body.refVideos[i].path = await transferStaged(body.refVideos[i].path)
      }
    }
    if (body.refAudios?.length) {
      for (let i = 0; i < body.refAudios.length; i++) {
        body.refAudios[i] = await transferStaged(body.refAudios[i])
      }
    }
    // (правка 146) Кадры режима flf — тот же staged-трансфер, что у референсов
    if (body.firstFrame) body.firstFrame = await transferStaged(body.firstFrame)
    if (body.lastFrame) body.lastFrame = await transferStaged(body.lastFrame)

    // Custom LoRAs: inject enabled ones from config (правка 44).
    // (правка 89) Сверка с файлами на диске: запись в loras.json, файл
    // которой удалён вручную мимо приложения, — «призрак», ComfyUI упал бы
    // на загрузке несуществующей лоры. Такие записи молча пропускаем.
    // (правка 95) Турбо-лора управляется той же записью в loras.json
    // (enabled/strength) — в кастомную цепочку не входит.
    const loraFiles = new Set(listLoraFiles())
    const allEntries = loadLoras()
    const turboEntry = allEntries.find((e) => e.name === TURBO_LORA_NAME)
    const loraEntries = allEntries.filter((e) => e.enabled && e.name !== TURBO_LORA_NAME && loraFiles.has(e.name))
    // Турбо включена = файл на диске есть И запись не выключена
    // (записи может не быть — тогда дефолт «включена»).
    body.turboLoraEnabled = loraFiles.has(TURBO_LORA_NAME) && turboEntry?.enabled !== false
    // Влияние турбо: приоритет — слайдер в списке лор; иначе прежний
    // параметр из доп. настроек (turboLoraStrength от клиента).
    if (typeof turboEntry?.strength === 'number') {
      body.turboLoraStrength = turboEntry.strength
    }
    // (правка 89) Исходный промпт БЕЗ триггеров — уйдёт в метаданные,
    // иначе «Повторить генерацию» допишет триггеры к уже дописанному
    // промпту и они начнут накапливаться с каждым повтором.
    const promptForMeta = body.prompt
    if (loraEntries.length > 0) {
      body.customLoras = loraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      // Append trigger words to the prompt (правка 46)
      const triggers = loraEntries
        .map((e) => e.trigger?.trim())
        .filter((t): t is string => !!t)
      if (triggers.length > 0) {
        body.prompt = body.prompt + ' ' + triggers.join(', ')
      }
    }

    // Diffusion model: inject from config if set (правка 45).
    // (правка 89) Файл мог быть удалён с диска после выбора — проверяем
    // существование, иначе шаблон падает на UNETLoader с отсутствующим файлом.
    const cfg = getAppConfig()
    if (cfg.diffusionModel) {
      const modelPath = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'diffusion_models', cfg.diffusionModel)
      if (fs.existsSync(modelPath)) {
        body.diffusionModel = cfg.diffusionModel
      }
    }

    // VRAM arbitration: LLM должен ПОЛНОСТЬЮ покинуть VRAM до загрузки MiniMax.
    // Mutex держится и на submit — окно для гонки с чатом исключено.
    const run = await runGeneration(() => submitVideo(body))
    if (!run.ok) {
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    const result = run.result
    // Set active prompt so KJ preview events can be mapped
    if (result.prompt_id) {
      setActivePrompt(result.prompt_id)
      // Server-side metadata: persist the job params NOW so the sidecar can
      // be written on completion even if the browser tab is closed.
      // (правка 89) промпт без триггерных слов — см. комментарий выше
      recordPendingMeta(result.prompt_id, { ...body, prompt: promptForMeta })
    }
    return NextResponse.json({ ...result, staged_transfers: transfers })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
