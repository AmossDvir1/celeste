import { create } from 'zustand'
import type { ModelInfo, VendorId } from '@shared/agent'
import { core } from '@/api'

/*
 * The models a person can pick. They come from the vendors themselves once connected: their own names, the effort
 * levels each takes, and whether it reads images. Nothing is listed for a vendor that is not connected.
 */

/** The vendors Celeste can really talk to. Asking about one that is not connected gives an empty list. */
const REAL: VendorId[] = ['copilot', 'claude']

const index = (list: ModelInfo[]): Record<string, ModelInfo> => Object.fromEntries(list.map((m) => [m.id, m]))

interface ModelsState {
  list: ModelInfo[]
  byId: Record<string, ModelInfo>
  /** Asks the given vendors for their own lists. Asking starts a vendor's program, so only ask the ones that are connected. */
  refresh: (vendors?: VendorId[]) => Promise<void>
}

const reported: Partial<Record<VendorId, ModelInfo[]>> = {}

export const useModels = create<ModelsState>((set) => ({
  list: [],
  byId: {},

  refresh: async (vendors = REAL) => {
    await Promise.all(
      vendors.map(async (v) => {
        const models = await core.call('vendor.models', v).catch(() => [] as ModelInfo[])
        if (models.length) reported[v] = models
        else delete reported[v]
      })
    )
    const list = REAL.flatMap((v) => reported[v] ?? [])
    set({ list, byId: index(list) })
  }
}))

/** A name to show for a model that is not in the list: the vendor is not connected, or has not answered yet. */
function labelOf(id: string): string {
  const bare = id.replace(/^claude:/, '').replace(/^copilot-/, '')
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : 'Model'
}

/**
 * The model for a saved name. A name from before Copilot was real (`copilot-auto`) stands for Copilot's own Auto. A name that is
 * not in the list gets a plain stand-in that shows its name, so a conversation still opens when its vendor is not connected.
 */
export function lookupModel(byId: Record<string, ModelInfo>, id: string, vendor?: VendorId): ModelInfo {
  const found = byId[id] ?? (id.startsWith('copilot-') ? byId['auto'] : undefined)
  if (found) return found
  return { id, vendor: vendor ?? (id.startsWith('claude:') ? 'claude' : 'copilot'), label: labelOf(id), efforts: [], images: true }
}

export const modelOf = (id: string, vendor?: VendorId): ModelInfo => lookupModel(useModels.getState().byId, id, vendor)
