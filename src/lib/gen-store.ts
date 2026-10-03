/**
 * Persistent store for the generation form values.
 *
 * Uses Zustand + localStorage so that:
 *   - Switching between tabs doesn't lose form state (components unmount on switch)
 *   - Page refresh preserves the last-used parameters
 *   - Generated videos are loaded from ComfyUI's output directory,
 *     not stored here (only references are kept)
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/* ──────────────────────────── Video Gen ──────────────────────────── */

/**
 * One MiniMax H3 ref2va reference (reference manifest entry).
 * `path` is the ComfyUI input/ filename returned by /api/comfy/upload.
 */
export interface VideoRefItem {
  id: string
  kind: 'image' | 'video' | 'audio'
  /** ComfyUI input/ filename. */
  path: string
  /** Original file name (for display). */
  name: string
  /** Local blob URL preview — runtime only, stripped on persist. */
  previewUrl: string
  /** Free text: who/what this reference is (max 500 chars server-side). */
  role: string
  /** Images: how the reference is used by ref2va. */
  imageIntent: 'identity' | 'scene' | 'style' | 'composition'
  /** Audio: how the reference is used by ref2va. */
  audioIntent: 'voice' | 'drive' | 'style'
  /** Videos: include the reference's own audio track. */
  includeAudio: boolean
}

/** FL2VA start/end frame upload slot. */
export interface VideoFrameSlot {
  /** ComfyUI input/ filename. */
  path: string
  name: string
  /** Local blob URL preview — runtime only, stripped on persist. */
  previewUrl: string
  /** (правка 152) Ширина изображения в пикселях (из первого кадра — для aspect ratio). */
  width?: number
  /** (правка 152) Высота изображения в пикселях. */
  height?: number
}

export interface VideoGenState {
  prompt: string
  seed: number
  /** Selected model_type (single workflow: minimax_h3_ref2va). */
  modelType: string
  /** (правка 146) Режим генерации: 'ref' | 't2v' | 'flf' (default 'ref'). */
  mode: 'ref' | 't2v' | 'flf'
  /** Resolution label — ТОЧНЫЙ номинал (правка 124): "1280x720", "1920x1080", ... */
  resolution: string
  /** Total output frames (H3: 17n+5 grid, min 60 ≈ 2.5 с, правка 138). */
  videoLength: number
  /** ref2va reference detail: 'match' | 'max'. */
  referenceDetail: 'match' | 'max'
  /** FL2VA: first frame (image_prompt_type 'S'). */
  startFrame: VideoFrameSlot | null
  /** FL2VA: last frame (image_prompt_type 'E'). */
  endFrame: VideoFrameSlot | null
  /** ref2va reference manifest entries. */
  refs: VideoRefItem[]
  /** Two-pass latent upscaler: target resolution in MP (0 = auto from quality). */
  finalResolution: number
  /** Free-resolution mode: ignore quality presets, drive finalResolution directly. */
  freeResolution: boolean
  /** Pass 1 low-res resolution in MP (default 0.2). */
  lowResMP: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 4, max 30). */
  firstSamplerSteps: number
  /** Pass 2 sigma profile: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant: string
  /** (правка 69) Pass 2 sampler (default 'euler'). */
  pass2Sampler: string
  /** (правка 70) Pass 1 sampler (default 'euler'). */
  pass1Sampler: string
  /** (правка 70) Pass 1 scheduler (default 'simple'). */
  pass1Scheduler: string
  /** (правка 70) Влияние турбо-лоры (default 1.0). */
  turboLoraStrength: number
  /** MiniMaxLowVRAMAttention: head-chunked attention (saves VRAM). */
  lowVramAttention: boolean
  /** MiniMaxChunkFeedForward: chunked FFN for long sequences (saves VRAM). */
  chunkFeedForward: boolean
  /** ChunkFF: number of feed-forward chunks. */
  chunkFFChunks: number
  /** ChunkFF: sequence length threshold above which chunking kicks in. */
  chunkFFThreshold: number
  /** (правка 91) Активная папка галереи: '' = общая, иначе имя подпапки output.
   *  Вкладка «Генерация» фильтрует галерею по ней и складывает новые видео в неё. */
  outputFolder: string
}

export const DEFAULT_VIDEO_STATE: VideoGenState = {
  prompt: '',
  seed: -1,
  modelType: 'minimax_h3_ref2va',
  mode: 'ref', // (правка 146)
  resolution: '854x480', // (правка 138) дефолт 480p 16:9 — быстрее и дешевле в VRAM
  videoLength: 60, // (правка 138) минимум 2.5 с (60 кадров при 24 fps, сетка 17n+5)
  referenceDetail: 'match',
  startFrame: null,
  endFrame: null,
  refs: [],
  finalResolution: 0,
  freeResolution: false,
  lowResMP: 0.2,
  firstSamplerSteps: 4,
  sigmaVariant: '3step',
  pass2Sampler: 'euler',
  pass1Sampler: 'euler',
  pass1Scheduler: 'simple',
  turboLoraStrength: 1.0,
  lowVramAttention: true,
  chunkFeedForward: true,
  chunkFFChunks: 2,
  chunkFFThreshold: 4096,
  outputFolder: '',
}

/* ──────────────────────────── Store ──────────────────────────── */

/**
 * Освобождение blob-URL превью. URL.createObjectURL держит файл в памяти,
 * пока URL не отозван (или страница не закрыта) — без отзыва каждое
 * удаление/замена референса копило блобы на всю сессию.
 * Серверные URL (/api/…) не трогаем — отзыв применим только к blob:.
 */
function revokePreview(url?: string): void {
  if (url && url.startsWith('blob:') && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try { URL.revokeObjectURL(url) } catch { /* уже отозван */ }
  }
}

interface GenStoreState {
  video: VideoGenState

  // Video gen setters
  setVideoPrompt: (v: string) => void
  setVideoSeed: (v: number) => void
  setVideoModel: (v: string) => void
  setVideoResolution: (v: string) => void
  setVideoLength: (v: number) => void
  setVideoReferenceDetail: (v: 'match' | 'max') => void
  setVideoStartFrame: (slot: VideoFrameSlot | null) => void
  setVideoEndFrame: (slot: VideoFrameSlot | null) => void
  addVideoRefs: (items: VideoRefItem[]) => void
  updateVideoRef: (id: string, patch: Partial<Omit<VideoRefItem, 'id'>>) => void
  removeVideoRef: (id: string) => void
  moveVideoRef: (fromIndex: number, toIndex: number) => void
  clearVideoRefs: () => void
  /** Replace several video fields at once (model-change defaults). */
  patchVideo: (patch: Partial<VideoGenState>) => void
}

export const useGenStore = create<GenStoreState>()(
  persist(
    (set) => ({
      video: { ...DEFAULT_VIDEO_STATE },

      // Video gen setters
      setVideoPrompt: (v) => set((s) => ({ video: { ...s.video, prompt: v } })),
      setVideoSeed: (v) => set((s) => ({ video: { ...s.video, seed: v } })),
      setVideoModel: (v) => set((s) => ({ video: { ...s.video, modelType: v } })),
      setVideoResolution: (v) => set((s) => ({ video: { ...s.video, resolution: v } })),
      setVideoLength: (v) => set((s) => ({ video: { ...s.video, videoLength: v } })),
      setVideoReferenceDetail: (v) => set((s) => ({ video: { ...s.video, referenceDetail: v } })),
      setVideoStartFrame: (slot) =>
        set((s) => {
          if (s.video.startFrame && slot !== s.video.startFrame) revokePreview(s.video.startFrame.previewUrl)
          return { video: { ...s.video, startFrame: slot } }
        }),
      setVideoEndFrame: (slot) =>
        set((s) => {
          if (s.video.endFrame && slot !== s.video.endFrame) revokePreview(s.video.endFrame.previewUrl)
          return { video: { ...s.video, endFrame: slot } }
        }),
      addVideoRefs: (items) =>
        set((s) => ({ video: { ...s.video, refs: [...s.video.refs, ...items] } })),
      updateVideoRef: (id, patch) =>
        set((s) => ({
          video: {
            ...s.video,
            refs: s.video.refs.map((r) => {
              if (r.id !== id) return r
              if (patch.previewUrl && patch.previewUrl !== r.previewUrl) revokePreview(r.previewUrl)
              return { ...r, ...patch }
            }),
          },
        })),
      removeVideoRef: (id) =>
        set((s) => {
          const removed = s.video.refs.find((r) => r.id === id)
          if (removed) revokePreview(removed.previewUrl)
          return { video: { ...s.video, refs: s.video.refs.filter((r) => r.id !== id) } }
        }),
      moveVideoRef: (fromIndex, toIndex) =>
        set((s) => {
          const refs = [...s.video.refs]
          if (fromIndex < 0 || fromIndex >= refs.length || toIndex < 0 || toIndex >= refs.length) return s
          const [moved] = refs.splice(fromIndex, 1)
          refs.splice(toIndex, 0, moved)
          return { video: { ...s.video, refs } }
        }),
      clearVideoRefs: () =>
        set((s) => {
          for (const r of s.video.refs) revokePreview(r.previewUrl)
          return { video: { ...s.video, refs: [] } }
        }),
      patchVideo: (patch) =>
        set((s) => {
          // Полная замена списков/слотов патчем (restore-from-meta) — отзываем
          // blob-URL того, что не переехало в новый список
          if (patch.refs) {
            const kept = new Set(patch.refs.map((r) => r.previewUrl))
            for (const r of s.video.refs) {
              if (!kept.has(r.previewUrl)) revokePreview(r.previewUrl)
            }
          }
          if (patch.startFrame !== undefined && patch.startFrame !== s.video.startFrame) {
            revokePreview(s.video.startFrame?.previewUrl)
          }
          if (patch.endFrame !== undefined && patch.endFrame !== s.video.endFrame) {
            revokePreview(s.video.endFrame?.previewUrl)
          }
          return { video: { ...s.video, ...patch } }
        }),
    }),
    {
      name: 'h3-gen-store',
      version: 2,
      // (правка 97) Новый дефолт шагов pass 1 = 4 (был 2).
      // Сбрасываем только значение, равное старому дефолту (2), — оно означает
      // «пользователь слайдер не трогал». Осознанный выбор (3–30) сохраняется.
      migrate: (persisted: any, oldVersion: number) => {
        const state = (persisted ?? {}) as any
        if (oldVersion < 2 && state?.video && state.video.firstSamplerSteps === 2) {
          state.video = { ...state.video, firstSamplerSteps: 4 }
        }
        return state
      },
      // Deep-merge persisted state with initial state so new fields get defaults
      merge: (persisted: any, current: any) => {
        const result = { ...current, ...persisted }
        if (persisted?.video) {
          result.video = { ...current.video, ...persisted.video }
          // Guard against undefined numeric fields from old localStorage
          if (typeof result.video.videoLength !== 'number' || isNaN(result.video.videoLength)) {
            result.video.videoLength = DEFAULT_VIDEO_STATE.videoLength
          }
          if (typeof result.video.lowResMP !== 'number' || isNaN(result.video.lowResMP)) {
            result.video.lowResMP = DEFAULT_VIDEO_STATE.lowResMP
          }
          if (typeof result.video.finalResolution !== 'number' || isNaN(result.video.finalResolution)) {
            result.video.finalResolution = DEFAULT_VIDEO_STATE.finalResolution
          }
          if (typeof result.video.freeResolution !== 'boolean') {
            result.video.freeResolution = DEFAULT_VIDEO_STATE.freeResolution
          }
          if (typeof result.video.sigmaVariant !== 'string' || !result.video.sigmaVariant) {
            result.video.sigmaVariant = DEFAULT_VIDEO_STATE.sigmaVariant
          }
          if (typeof result.video.pass2Sampler !== 'string' || !result.video.pass2Sampler) {
            result.video.pass2Sampler = DEFAULT_VIDEO_STATE.pass2Sampler
          }
          if (typeof result.video.pass1Sampler !== 'string' || !result.video.pass1Sampler) {
            result.video.pass1Sampler = DEFAULT_VIDEO_STATE.pass1Sampler
          }
          if (typeof result.video.pass1Scheduler !== 'string' || !result.video.pass1Scheduler) {
            result.video.pass1Scheduler = DEFAULT_VIDEO_STATE.pass1Scheduler
          }
          if (typeof result.video.turboLoraStrength !== 'number' || isNaN(result.video.turboLoraStrength)) {
            result.video.turboLoraStrength = DEFAULT_VIDEO_STATE.turboLoraStrength
          }
          if (typeof result.video.lowVramAttention !== 'boolean') {
            result.video.lowVramAttention = DEFAULT_VIDEO_STATE.lowVramAttention
          }
          if (typeof result.video.chunkFeedForward !== 'boolean') {
            result.video.chunkFeedForward = DEFAULT_VIDEO_STATE.chunkFeedForward
          }
          if (typeof result.video.chunkFFChunks !== 'number' || isNaN(result.video.chunkFFChunks)) {
            result.video.chunkFFChunks = DEFAULT_VIDEO_STATE.chunkFFChunks
          }
          if (typeof result.video.chunkFFThreshold !== 'number' || isNaN(result.video.chunkFFThreshold)) {
            result.video.chunkFFThreshold = DEFAULT_VIDEO_STATE.chunkFFThreshold
          }
          if (!Array.isArray(result.video.refs)) {
            result.video.refs = []
          }
        }
        return result
      },
      // Persist form values. Preview blob URLs don't survive reload —
      // strip them and rebuild previews from the server-side input files.
      partialize: (state) => ({
        video: {
          ...state.video,
          startFrame: state.video.startFrame ? { ...state.video.startFrame, previewUrl: '' } : null,
          endFrame: state.video.endFrame ? { ...state.video.endFrame, previewUrl: '' } : null,
          refs: state.video.refs.map((r) => ({ ...r, previewUrl: '' })),
        },
      }),
    }
  )
)
