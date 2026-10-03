import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import {
  loadLoras,
  saveLoras,
  lorasDir,
  listLoraFiles,
  TURBO_LORA_NAME,
} from '@/lib/loras-config'
import { comfyBusy } from '@/lib/vram-arbiter'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'

/**
 * GET /api/loras
 * Returns the list of available LoRAs (files in folder) merged with settings.
 */
export async function GET(req: NextRequest) {
  try {
    // (правка 95) Турбо-лора в общем списке: помечаем isTurbo для UI.
    void req
    const files = listLoraFiles()
    const settings = loadLoras()
    const settingsMap = new Map(settings.map((e) => [e.name, e]))

    // Build the response: all files with their settings.
    // (правка 134) По умолчанию включена ТОЛЬКО турбо-лора (4 шага),
    // остальные кастомные лоры выключены. Раньше enabled=true по умолчанию
    // — все лоры из папки автоматически включались в генерацию.
    const result = files.map((name) => {
      const s = settingsMap.get(name)
      const isTurbo = name === TURBO_LORA_NAME
      return {
        name,
        strength: s?.strength ?? 1.0,
        enabled: s?.enabled ?? isTurbo, // turbo → true, остальные → false
        trigger: s?.trigger ?? '',
        isTurbo,
        size: getFileSize(name),
      }
    })

    // (правка 89) Чистка «призраков»: записи, чьи файлы удалены вручную из
    // папки loras, больше не показываются и не должны оставаться в конфиге
    // (иначе generate-роут обязан фильтровать их по диску — что он и делает,
    // но мусор в loras.json копить незачем).
    const fileSet = new Set(files)
    const pruned = settings.filter((e) => fileSet.has(e.name))
    if (pruned.length !== settings.length) {
      saveLoras(pruned)
    }

    return NextResponse.json({ loras: result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * POST /api/loras
 * Body: FormData with 'file' field (.safetensors)
 * Copies the file to the LoRAs folder and adds it to settings.
 *
 * (правка 103) Стриминг — то же, что в /api/comfy/diffusion-models
 * (правки 102/103): `req.formData()` буферизовал ВЕСЬ файл в RAM — на
 * больших LoRAs это OOM-ом убивало процесс ("догружается до 100 %, а
 * лоры нет"). Теперь тело разбирается потоково (@/lib/multipart-stream),
 * байты пишутся в .part-файл, затем атомарный rename. Память O(chunk).
 *
 * (правка 106) Тело запроса читается штатным reader'ом Web-потока
 * (req.body.getReader() внутри парсера) — так же, как рабочий роут
 * /api/upscale/upload; Readable.fromWeb больше не используется
 * (на больших загрузках он вызывал ECONNRESET под Next.js).
 */
export async function POST(req: NextRequest) {
  let tmpDest = ''
  let part: MultipartFilePart | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
    }

    // (правка 103) Заголовки части приходят первыми — имя файла известно
    // ДО передачи байтов: 400/409 отдаём до единого записанного байта.
    // (правка 106) req.body — Web-поток, парсер читает его штатным
    // reader'ом (без Readable.fromWeb) — как /api/upscale/upload.
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      abortUpload(part)
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Имя из multipart может содержать путь (..\..\model.safetensors) —
    // оставляем только базовое имя и выкидываем недопустимые для Windows
    // символы, иначе загрузка превращается в произвольную запись файла.
    const safeName = path.basename(part.filename).replace(/[\\/:*?"<>|]+/g, '_').trim()
    if (!safeName) {
      abortUpload(part)
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 })
    }
    const ext = path.extname(safeName).toLowerCase()
    if (ext !== '.safetensors') {
      abortUpload(part)
      return NextResponse.json({ error: 'Only .safetensors files are supported' }, { status: 400 })
    }

    const dir = lorasDir()
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, safeName)

    // Check name collision
    if (fs.existsSync(dest)) {
      abortUpload(part)
      return NextResponse.json({ error: `File "${safeName}" already exists in LoRAs folder` }, { status: 409 })
    }

    // (правка 103) Остаточный .part от неудачной загрузки чистим заранее.
    const stalePart = dest + '.part'
    if (fs.existsSync(stalePart)) {
      try { fs.unlinkSync(stalePart) } catch { /* ignore */ }
    }

    // (правка 103) Пишем потоково во временный .part, затем атомарный
    // rename — при сбое частичный файл не блокирует повторную загрузку.
    tmpDest = dest + '.part'
    const ws = fs.createWriteStream(tmpDest)
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
      part!.stream.on('error', reject)
      part!.stream.pipe(ws)
    })
    fs.renameSync(tmpDest, dest)
    tmpDest = '' // успех — cleanup не нужен

    // Add to settings.
    // (правка 134) Новая лора по умолчанию ВЫКЛЮЧЕНА — пользователь должен
    // явно включить её в UI. Раньше enabled=true — все загруженные лоры
    // автоматически участвовали в генерации.
    const entries = loadLoras()
    entries.push({ name: safeName, strength: 1.0, enabled: false })
    saveLoras(entries)

    let size = 0
    try { size = fs.statSync(dest).size } catch { /* ignore */ }
    return NextResponse.json({ ok: true, name: safeName, size })
  } catch (err) {
    abortUpload(part)
    if (tmpDest) {
      try { fs.unlinkSync(tmpDest) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof MultipartParseError) {
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/** (правка 103) Прерываем загрузку: клиент больше не читает тело. */
function abortUpload(part: MultipartFilePart | null): void {
  try { part?.stream.destroy() } catch { /* уже разрушен */ }
  try { part?.cancel() } catch { /* уже закрыт */ }
}

/**
 * PUT /api/loras
 * Body: { name: string, strength?: number, enabled?: boolean }
 * Updates LoRA settings.
 *
 * (правка 133) При смене enabled (вкл/выкл) автоматически сбрасывает патчи
 * ComfyUI (POST /free), чтобы избежать ошибки «shape ... invalid» при
 * повторном включении. Сброс идёт в фоне — не блокирует ответ.
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, strength, enabled, trigger } = body as { name: string; strength?: number; enabled?: boolean; trigger?: string }
    if (!name) {
      return NextResponse.json({ error: 'Invalid LoRA name' }, { status: 400 })
    }

    const entries = loadLoras()
    let entry = entries.find((e) => e.name === name)
    if (!entry) {
      entry = { name, strength: 1.0, enabled: true }
      entries.push(entry)
    }

    // (правка 133) Запоминаем предыдущее состояние для сброса патчей
    const wasEnabled = entry.enabled

    if (strength !== undefined) entry.strength = Math.max(0, Math.min(2, strength))
    if (enabled !== undefined) entry.enabled = enabled
    if (trigger !== undefined) entry.trigger = trigger.trim()
    saveLoras(entries)

    // (правка 133) Если enabled изменился — сбрасываем патчи ComfyUI.
    // Это предотвращает ошибку «shape ... invalid» при повторном включении
    // LoRA, когда ComfyUI кэширует патчи в RAM.
    // НО не во время генерации: unload_models посреди исполняющегося промпта
    // убивает задачу (OOM/model-missing). Проверяем занятость ComfyUI.
    if (enabled !== undefined && enabled !== wasEnabled) {
      const busy = await comfyBusy().catch(() => false)
      if (busy) {
        return NextResponse.json({
          ok: true,
          warning: 'Патчи ComfyUI не сброшены: идёт генерация. Сброс произойдёт при следующем переключении.',
        })
      }
      const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
      // fire-and-forget: не ждём ответа, не блокируем UI
      fetch(`${COMFY_URL}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => { /* ComfyUI может быть недоступен — молча игнорируем */ })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * DELETE /api/loras
 * Body: { name: string, deleteFile?: boolean }
 * Removes LoRA from settings. If deleteFile=true, also deletes the file.
 */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, deleteFile } = body as { name: string; deleteFile?: boolean }
    // (правка 95) Турбо-лора удаляется наравне с остальными: файл исчез
    // из папки → generate-роут сам не включит её в workflow.
    if (!name) {
      return NextResponse.json({ error: 'Invalid LoRA name' }, { status: 400 })
    }

    // Remove from settings
    const entries = loadLoras()
    saveLoras(entries.filter((e) => e.name !== name))

    // Delete file if requested
    if (deleteFile) {
      const dir = lorasDir()
      const filePath = path.join(dir, path.basename(name))
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/* ─── helper ─── */
function getFileSize(name: string): number {
  try {
    const dir = lorasDir()
    const st = fs.statSync(path.join(dir, name))
    return st.size
  } catch {
    return 0
  }
}
