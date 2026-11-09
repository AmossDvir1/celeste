// What a paired phone's requests do. Only PHONE_METHODS get here (the bridge refuses the rest); this keeps each one to
// what a remote should do: no attachments from the computer's disk, only folders the person already used, their usual settings.

import type { Effort, ModelInfo, VendorId } from '@shared/agent'
import type { CoreApi, SessionSummary } from '@shared/api'
import type { PhoneBootstrap, PhoneMethod, PhoneModelChoice, PhoneModels, PhoneNewSession, PhoneProject } from '@shared/phone'

type Api = Pick<CoreApi, 'app.bootstrap' | 'sessions.create' | 'sessions.send'> & Partial<CoreApi>

const VENDORS: VendorId[] = ['copilot', 'claude']

/**
 * The models of the assistants connected on the computer, as its model menu lists them. Asking a vendor starts its
 * program, so only connected ones are asked, and the answer is kept for checking what a phone picks.
 */
async function connectedModels(a: Api, kept: Map<VendorId, ModelInfo[]>): Promise<ModelInfo[]> {
  const connected = VENDORS.filter((v) => a['app.bootstrap']().vendors[v])
  for (const v of [...kept.keys()]) if (!connected.includes(v)) kept.delete(v)
  await Promise.all(
    connected.map(async (v) => {
      const list = a['vendor.models'] ? await a['vendor.models'](v).catch(() => []) : []
      if (list.length) kept.set(v, list)
      else kept.delete(v)
    })
  )
  return VENDORS.flatMap((v) => kept.get(v) ?? [])
}

/** The model and effort a phone picked, checked against what the computer offers. Throws a message fit to show. */
async function checkChoice(a: Api, kept: Map<VendorId, ModelInfo[]>, choice: PhoneModelChoice, vendor?: VendorId): Promise<{ model: ModelInfo; effort: Effort | null }> {
  const find = () => VENDORS.flatMap((v) => kept.get(v) ?? []).find((m) => m.id === choice.model && (!vendor || m.vendor === vendor))
  const model = find() ?? (await connectedModels(a, kept), find())
  if (!model) throw new Error(vendor ? 'This chat cannot use that model. Its assistant stays the same.' : 'That model is not available on the computer now.')
  const effort = choice.effort && model.efforts.includes(choice.effort) ? choice.effort : model.efforts.length ? (model.defaultEffort ?? model.efforts[0] ?? null) : null
  return { model, effort }
}

/** A short title from the first message, as the sidebar shows it until a better one is written. */
export function titleFromText(text: string): string {
  const words = text.trim().replace(/\s+/g, ' ')
  if (!words) return 'New chat'
  return words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** The projects the person used for Develop, newest first. A session in a separate copy counts for the project it was copied from. */
export async function recentProjects(a: Api): Promise<PhoneProject[]> {
  const sessions = a['app.bootstrap']().sessions.filter((s) => s.mode === 'develop' && s.cwd)
  const copies = new Map<string, string>()
  if (sessions.some((s) => s.worktree) && a['project.worktrees']) {
    for (const w of await a['project.worktrees']().catch(() => [])) if (w.repo) copies.set(w.path, w.repo)
  }
  const last = new Map<string, number>()
  for (const s of sessions) {
    const path = s.worktree ? copies.get(s.cwd as string) : s.cwd
    if (path) last.set(path, Math.max(last.get(path) ?? 0, s.updatedAt))
  }
  const out: PhoneProject[] = []
  for (const [path, lastUsed] of [...last].sort((x, y) => y[1] - x[1]).slice(0, 12)) {
    const seen = a['project.inspect'] ? await a['project.inspect'](path).catch(() => null) : { exists: true, branch: null }
    if (seen?.exists) out.push({ path, name: baseName(path), branch: seen.branch, lastUsed })
  }
  return out
}

export function phoneCalls(api: () => Api, computerName: () => string): (method: PhoneMethod, params: unknown[]) => Promise<unknown> {
  const kept = new Map<VendorId, ModelInfo[]>()
  return async (method, params) => {
    const a = api()
    switch (method) {
      case 'phone.models': {
        const reply: PhoneModels = { models: await connectedModels(a, kept), pinned: a['app.bootstrap']().settings.pinnedModels ?? [] }
        return reply
      }
      case 'phone.setModel': {
        // Only the model and its effort: a chat keeps its assistant, as on the computer.
        const [id, choice] = params as [unknown, PhoneModelChoice | undefined]
        const session = a['app.bootstrap']().sessions.find((s) => s.id === String(id))
        if (!session) throw new Error('This chat is no longer on the computer.')
        if (!a['sessions.update']) throw new Error('Not available from a phone.')
        const { model, effort } = await checkChoice(a, kept, { ...choice, model: String(choice?.model ?? '') }, session.vendor)
        return a['sessions.update'](session.id, { model: model.id, effort })
      }
      case 'phone.hello': {
        const b = a['app.bootstrap']()
        const reply: PhoneBootstrap = { computer: computerName(), version: b.version, userName: b.settings.userName, theme: b.settings.theme, sessions: b.sessions }
        return reply
      }
      case 'phone.projects':
        return recentProjects(a)
      case 'phone.newChat': {
        const text = String(params[0] ?? '').slice(0, 100_000)
        if (!text.trim()) throw new Error('Write something first.')
        const how = (params[1] as PhoneNewSession | undefined) ?? { mode: 'chat' }
        const b = a['app.bootstrap']()
        const newest = (mode: 'chat' | 'develop') => b.sessions.filter((s) => s.mode === mode).sort((x, y) => y.updatedAt - x.updatedAt)[0]
        const title = titleFromText(text)
        // A model the phone picked is checked before anything is made, a separate copy included.
        const picked = how.model ? await checkChoice(a, kept, how) : null
        let place: { cwd?: string; branch?: string } = {}
        if (how.mode === 'develop') {
          // Only a folder the person already used for Develop on the computer: a phone never names a new one.
          const project = (await recentProjects(a)).find((p) => p.path === how.project)
          if (!project) throw new Error('Choose one of your projects. New ones are added from the computer.')
          if (how.copy) {
            if (!a['project.createWorktree']) throw new Error('Separate copies are not available.')
            const copy = await a['project.createWorktree'](project.path, title)
            place = { cwd: copy.path, branch: copy.branch }
          } else place = { cwd: project.path, ...(project.branch ? { branch: project.branch } : {}) }
        }
        // It carries on with the assistant and model of the newest session of the same kind, else the newest of any kind,
        // else the person's defaults.
        const like = newest(how.mode) ?? newest(how.mode === 'chat' ? 'develop' : 'chat')
        const model = picked?.model.id ?? like?.model ?? b.settings.defaults.model
        const vendor = picked?.model.vendor ?? like?.vendor ?? (model.startsWith('claude') ? 'claude' : 'copilot')
        const created: SessionSummary = a['sessions.create']({
          vendor,
          mode: how.mode,
          title,
          model,
          effort: picked ? picked.effort : (like?.effort ?? null),
          approval: like?.approval ?? b.settings.defaults.approval,
          ...place
        })
        a['sessions.send'](created.id, { text, attachments: [] })
        return created
      }
      case 'sessions.send': {
        // Text only: a phone cannot point at files on the computer.
        const [id, input] = params as [unknown, { text?: unknown } | undefined]
        const text = String(input?.text ?? '').slice(0, 100_000)
        if (!text.trim()) throw new Error('Write something first.')
        return a['sessions.send'](String(id), { text, attachments: [] })
      }
      default: {
        const fn = a[method as keyof CoreApi] as ((...x: unknown[]) => unknown) | undefined
        if (!fn) throw new Error('Not available from a phone.')
        return fn(...params)
      }
    }
  }
}
