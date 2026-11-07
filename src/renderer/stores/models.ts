import { create } from 'zustand'
import type { ModelInfo, VendorId } from '@shared/agent'
import { core } from '@/api'
import { MODELS as SCRIPTED } from '@/mocks/models'

/*
 * The models a person can pick. A real vendor's come from the vendor itself once it is connected: its own names, the
 * effort levels each takes, and whether it reads images. A vendor that has no adapter yet uses the scripted catalog.
 */

/** The vendors Celeste can really talk to. Asking about one that is not connected gives an empty list. */
const REAL: VendorId[] = ['copilot', 'claude']

const index = (list: ModelInfo[]): Record<string, ModelInfo> => Object.fromEntries(list.map((m) => [m.id, m]))

interface ModelsState {
  list: ModelInfo[]
  byId: Record<string, ModelInfo>
  /** The vendors that have reported their own list, so their scripted models are gone. */
  real: VendorId[]
  /** Asks the given vendors for their own lists. Asking starts a vendor's program, so only ask the ones that are connected. */
  refresh: (vendors?: VendorId[]) => Promise<void>
}

const reported: Partial<Record<VendorId, ModelInfo[]>> = {}

export const useModels = create<ModelsState>((set) => ({
  list: SCRIPTED,
  byId: index(SCRIPTED),
  real: [],

  refresh: async (vendors = REAL) => {
    await Promise.all(
      vendors.map(async (v) => {
        const models = await core.call('vendor.models', v).catch(() => [] as ModelInfo[])
        if (models.length) reported[v] = models
        else delete reported[v]
      })
    )
    const real = REAL.filter((v) => reported[v])
    const list = [...real.flatMap((v) => reported[v] as ModelInfo[]), ...SCRIPTED.filter((m) => !real.includes(m.vendor))]
    set({ list, byId: index(list), real })
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
