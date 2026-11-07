import { create } from 'zustand'
import type { ModelInfo } from '@shared/agent'
import { core } from '@/api'
import { MODELS as SCRIPTED } from '@/mocks/models'

/*
 * The models a person can pick. Copilot's come from Copilot itself once it is connected: its own names, the
 * effort levels each takes, and whether it reads images. The other vendors still use the scripted catalog
 * until their adapters report theirs.
 */

const index = (list: ModelInfo[]): Record<string, ModelInfo> => Object.fromEntries(list.map((m) => [m.id, m]))

interface ModelsState {
  list: ModelInfo[]
  byId: Record<string, ModelInfo>
  /** True once Copilot has reported its own list, so the scripted Copilot models are gone. */
  copilotIsReal: boolean
  refresh: () => Promise<void>
}

export const useModels = create<ModelsState>((set) => ({
  list: SCRIPTED,
  byId: index(SCRIPTED),
  copilotIsReal: false,

  refresh: async () => {
    const copilot = await core.call('vendor.models', 'copilot').catch(() => [] as ModelInfo[])
    const list = copilot.length ? [...copilot, ...SCRIPTED.filter((m) => m.vendor !== 'copilot')] : SCRIPTED
    set({ list, byId: index(list), copilotIsReal: copilot.length > 0 })
  }
}))

/**
 * The model for a saved name. A scripted Copilot name (`copilot-auto`, `copilot-gpt`) from before Copilot was real
 * stands for Copilot's own Auto, and a name that is gone falls back to the first model there is.
 */
export function lookupModel(byId: Record<string, ModelInfo>, id: string): ModelInfo {
  const found = byId[id] ?? (id.startsWith('copilot-') ? byId['auto'] : undefined)
  if (found) return found
  const any = Object.values(byId)
  return any.find((m) => m.vendor === 'copilot') ?? (any[0] as ModelInfo)
}

export const modelOf = (id: string): ModelInfo => lookupModel(useModels.getState().byId, id)
