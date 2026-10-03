import { NextResponse } from 'next/server'
import { getAppConfig, setConfigValue } from '@/lib/app-config'
import { llmStatus, stopLlm } from '@/lib/llm-runner'
import { sttStatus, stopStt } from '@/lib/stt-runner'

/**
 * GET /api/config — runtime app settings (config.ini).
 * POST /api/config — update settings: { reserve_gb?, dynamic_vram?, llm_device?, comfy_dir? }.
 *
 * comfy_dir is the root of the portable backend install (the folder that
 * contains ComfyUI/ and python_embeded/). Changing it re-points every
 * file route immediately — no restart needed.
 *
 * llm_device ('auto'|'gpu'|'cpu') re-modes the LLM assistant: the running
 * instance (if any) is stopped so the next chat message reloads it with
 * the new device.
 */
export async function GET() {
  try {
    const config = getAppConfig()
    return NextResponse.json({
      reserve_gb: config.reserveGb,
      dynamic_vram: config.dynamicVram,
      llm_device: config.llmDevice,
      llm_context_size: config.llmContextSize,
      llm_max_output_tokens: config.llmMaxOutputTokens,
      comfy_dir: config.comfyRoot,
      diffusion_model: config.diffusionModel,
      llm_model: config.llmModel,
      // (правка 136 / Bonsai) папка портативной сборки Bonsai 2 27B
      llm_bonsai_dir: config.llmBonsaiDir,
      // (правка 53) видение видео ассистентом — по умолчанию false
      llm_video_vision: config.llmVideoVision,
      // (правка 109) квантизация KV-кэша LLM — по умолчанию off (fp16)
      llm_kv_cache: config.llmKvCache,
      // (правка 135b) тонкая настройка сэмплинга LLM
      llm_sampling_override: config.llmSamplingOverride,
      llm_temperature: config.llmTemperature,
      llm_top_p: config.llmTopP,
      llm_top_k: config.llmTopK,
      llm_min_p: config.llmMinP,
      llm_presence_penalty: config.llmPresencePenalty,
      llm_frequency_penalty: config.llmFrequencyPenalty,
      llm_repeat_penalty: config.llmRepeatPenalty,
      sound_on: config.soundOn,
      // (правка 65) голосовой ввод — whisper STT (CPU)
      stt_enabled: config.sttEnabled,
      stt_dir: config.sttDir,
      stt_model: config.sttModel,
      stt_language: config.sttLanguage,
      stt_threads: config.sttThreads,
    })
  } catch {
    // (правка 119) дефолты: контекст 25K, KV-кэш Q4
    // (правка 135b) сэмплинг — override выкл, значения модель-осознанные
    return NextResponse.json({ reserve_gb: 3, dynamic_vram: true, llm_device: 'auto', llm_context_size: 25600, llm_max_output_tokens: 4096, comfy_dir: '', diffusion_model: '', llm_model: '', llm_video_vision: false, llm_kv_cache: 'q4_0', llm_sampling_override: false, llm_temperature: 0.7, llm_top_p: 0.95, llm_top_k: 40, llm_min_p: 0.05, llm_presence_penalty: 0.0, llm_frequency_penalty: 0.0, llm_repeat_penalty: 1.0, sound_on: true, stt_enabled: true, stt_dir: '', stt_model: '', stt_language: 'ru', stt_threads: 0 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    if (body.reserve_gb !== undefined) {
      const reserveGb = Math.max(0, Math.min(16, parseFloat(body.reserve_gb) || 3))
      setConfigValue('vram', 'reserve_gb', String(reserveGb))
    }

    if (body.dynamic_vram !== undefined) {
      // Written to [vram] next to reserve_gb — start_comfy.bat reads both
      // from there (single source of truth; [comfy] was a legacy duplicate).
      setConfigValue('vram', 'dynamic_vram', body.dynamic_vram ? '1' : '0')
    }

    if (body.llm_device !== undefined) {
      const dev = ['auto', 'gpu', 'cpu'].includes(body.llm_device) ? body.llm_device : 'auto'
      // Перезапуск ТОЛЬКО при фактическом изменении: диалог всегда шлёт
      // device/ctx/kv_cache, и «Сохранить» без правок убивало загруженную
      // модель с холодной перезагрузкой на следующем сообщении.
      const changed = getAppConfig().llmDevice !== dev
      setConfigValue('llm', 'device', dev)
      // Re-mode the running assistant: stop it so the next chat message
      // reloads the model on the newly selected device.
      if (changed && llmStatus().running) await stopLlm()
    }

    if (body.llm_context_size !== undefined) {
      // (правка 119) максимум контекста — 100K токенов, дефолт — 25K
      const ctx = Math.max(4096, Math.min(102400, parseInt(body.llm_context_size, 10) || 25600))
      const ctxChanged = getAppConfig().llmContextSize !== ctx
      setConfigValue('llm', 'context_size', String(ctx))
      // Context size is baked into the Llama instance — restart to apply.
      if (ctxChanged && llmStatus().running) await stopLlm()
    }

    if (body.llm_max_output_tokens !== undefined) {
      const out = Math.max(256, Math.min(16384, parseInt(body.llm_max_output_tokens, 10) || 4096))
      setConfigValue('llm', 'max_output_tokens', String(out))
      // Applied per-request on the next chat message — no LLM restart needed.
    }

    if (typeof body.comfy_dir === 'string' && body.comfy_dir.trim()) {
      setConfigValue('comfy', 'comfy_dir', body.comfy_dir.trim())
    }

    if (typeof body.diffusion_model === 'string') {
      setConfigValue('comfy', 'diffusion_model', body.diffusion_model.trim())
    }

    if (typeof body.llm_model === 'string') {
      const modelChanged = getAppConfig().llmModel !== body.llm_model.trim()
      setConfigValue('llm', 'model', body.llm_model.trim())
      // Model file change requires LLM restart to load the new file.
      if (modelChanged && llmStatus().running) await stopLlm()
    }

    // (правка 136 / Bonsai) папка внешней сборки Bonsai: смена пути требует
    // перезапуска ассистента (файлы модели грузятся из этой папки).
    if (typeof body.llm_bonsai_dir === 'string' && body.llm_bonsai_dir.trim()) {
      const dirChanged = getAppConfig().llmBonsaiDir !== body.llm_bonsai_dir.trim()
      setConfigValue('llm', 'bonsai_dir', body.llm_bonsai_dir.trim())
      if (dirChanged && llmStatus().running) await stopLlm()
    }

    // (правка 53) Видение видео ассистентом: применяется к каждому запросу
    // чата — перезапуск LLM не нужен.
    if (typeof body.llm_video_vision === 'boolean') {
      setConfigValue('llm', 'video_vision', body.llm_video_vision ? '1' : '0')
    }

    // (правка 109) Квантизация KV-кэша LLM: параметр зашивается в Llama-инстанс
    // (type_k/type_v) при создании контекста — запущенный сервер перезапускаем,
    // новый загрузится с выбранным типом.
    if (typeof body.llm_kv_cache === 'string' && ['off', 'q8_0', 'q5_1', 'q4_0'].includes(body.llm_kv_cache)) {
      const kvChanged = getAppConfig().llmKvCache !== body.llm_kv_cache
      setConfigValue('llm', 'kv_cache', body.llm_kv_cache)
      if (kvChanged && llmStatus().running) await stopLlm()
    }

    // (правка 135b) Тонкая настройка сэмплинга LLM — применяется к каждому
    // запросу (per-request), перезапуск LLM не нужен.
    if (typeof body.llm_sampling_override === 'boolean') {
      setConfigValue('llm', 'sampling_override', body.llm_sampling_override ? '1' : '0')
    }
    if (typeof body.llm_temperature === 'number') {
      setConfigValue('llm', 'temperature', String(Math.max(0, Math.min(2.0, body.llm_temperature))))
    }
    if (typeof body.llm_top_p === 'number') {
      setConfigValue('llm', 'top_p', String(Math.max(0, Math.min(1.0, body.llm_top_p))))
    }
    if (typeof body.llm_top_k === 'number') {
      setConfigValue('llm', 'top_k', String(Math.max(1, Math.min(200, Math.round(body.llm_top_k)))))
    }
    if (typeof body.llm_min_p === 'number') {
      setConfigValue('llm', 'min_p', String(Math.max(0, Math.min(1.0, body.llm_min_p))))
    }
    if (typeof body.llm_presence_penalty === 'number') {
      setConfigValue('llm', 'presence_penalty', String(Math.max(0, Math.min(2.5, body.llm_presence_penalty))))
    }
    if (typeof body.llm_frequency_penalty === 'number') {
      setConfigValue('llm', 'frequency_penalty', String(Math.max(0, Math.min(2.5, body.llm_frequency_penalty))))
    }
    if (typeof body.llm_repeat_penalty === 'number') {
      setConfigValue('llm', 'repeat_penalty', String(Math.max(1.0, Math.min(2.0, body.llm_repeat_penalty))))
    }

    if (typeof body.sound_on === 'boolean') {
      setConfigValue('ui', 'sound_on', body.sound_on ? '1' : '0')
    }

    // (правка 65) Голосовой ввод (whisper STT). Изменения применяются со
    // следующего диктата: запущенный сервис останавливаем (перезапустится
    // сам при первом же использовании с новыми параметрами).
    let sttChanged = false
    if (typeof body.stt_enabled === 'boolean') {
      setConfigValue('stt', 'enabled', body.stt_enabled ? '1' : '0')
      sttChanged = true
    }
    // Пустая строка — ВАЛИДНОЕ значение (сброс к дефолту <project>/stt):
    // прежний guard `.trim()` молча съедал его, и кастомная папка переживала
    // «Сброс настроек» и заводской сброс вопреки обещанию диалога.
    if (typeof body.stt_dir === 'string') {
      setConfigValue('stt', 'dir', body.stt_dir.trim())
      sttChanged = true
    }
    if (typeof body.stt_model === 'string') {
      setConfigValue('stt', 'model', body.stt_model.trim())
      sttChanged = true
    }
    if (typeof body.stt_language === 'string' && ['auto', 'ru', 'en'].includes(body.stt_language)) {
      setConfigValue('stt', 'language', body.stt_language)
      sttChanged = true
    }
    if (typeof body.stt_threads === 'number') {
      setConfigValue('stt', 'threads', String(Math.max(0, Math.min(32, Math.round(body.stt_threads)))))
      sttChanged = true
    }
    if (sttChanged && sttStatus().running) {
      await stopStt()
    }

    const config = getAppConfig()
    return NextResponse.json({
      ok: true,
      reserve_gb: config.reserveGb,
      dynamic_vram: config.dynamicVram,
      llm_device: config.llmDevice,
      llm_context_size: config.llmContextSize,
      llm_max_output_tokens: config.llmMaxOutputTokens,
      comfy_dir: config.comfyRoot,
      diffusion_model: config.diffusionModel,
      llm_model: config.llmModel,
      llm_video_vision: config.llmVideoVision,
      llm_kv_cache: config.llmKvCache,
      llm_sampling_override: config.llmSamplingOverride,
      llm_temperature: config.llmTemperature,
      llm_top_p: config.llmTopP,
      llm_top_k: config.llmTopK,
      llm_min_p: config.llmMinP,
      llm_presence_penalty: config.llmPresencePenalty,
      llm_frequency_penalty: config.llmFrequencyPenalty,
      llm_repeat_penalty: config.llmRepeatPenalty,
      sound_on: config.soundOn,
      stt_enabled: config.sttEnabled,
      stt_dir: config.sttDir,
      stt_model: config.sttModel,
      stt_language: config.sttLanguage,
      stt_threads: config.sttThreads,
    })
  } catch {
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
  }
}