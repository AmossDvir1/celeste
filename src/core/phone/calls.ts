// What a paired phone's requests do. Only PHONE_METHODS get here (the bridge refuses the rest); this keeps each one to
// what a remote should do: files only as the phone sends them itself, project files only inside the project of a Develop
// session, only folders the person already used, their usual settings.

import type { AttachmentInfo, ContextRef, Effort, ModelInfo, VendorId } from '@shared/agent'
import type { CoreApi, SessionSummary } from '@shared/api'
import {
  PHONE_ATTACH_PART,
  PHONE_CONTEXT_MAX,
  PHONE_UPLOAD_MAX_BYTES,
  PHONE_UPLOAD_MAX_FILES,
  type PhoneBootstrap,
  type PhoneMessage,
  type PhoneMethod,
  type PhoneModelChoice,
  type PhoneModels,
  type PhoneNewSession,
  type PhoneProject,
  type PhoneUploaded,
  type PhoneUploadPart,
  type PhoneWorkflow
} from '@shared/phone'
import { checkInputs, type InputDef, type WorkflowFull } from '@shared/workflow'

/** What a workflow's Start step asks for. */
const startInputs = (w: WorkflowFull): InputDef[] => {
  const start = w.definition.nodes.find((n) => n.type === 'start')
  return start && start.type === 'start' ? start.inputs : []
}

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

interface Upload {
  name: string
  mime: string
  parts: Buffer[]
  bytes: number
  next: number
  width?: number
  height?: number
}

const UPLOAD_ID = /^[\w-]{8,64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const PART_CHARS = Math.ceil(PHONE_ATTACH_PART / 3) * 4
/** Files saved for a phone and not yet sent: kept per phone, the oldest let go past this many. */
const KEPT_UPLOADS = 2 * PHONE_UPLOAD_MAX_FILES

const pixels = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 100_000 ? n : undefined)

export function phoneCalls(
  api: () => Api,
  computerName: () => string
): (method: PhoneMethod, params: unknown[], phone?: { id: string }) => Promise<unknown> {
  const kept = new Map<VendorId, ModelInfo[]>()
  const uploading = new Map<string, Upload>()
  const saved = new Map<string, Map<string, AttachmentInfo>>()

  /** A file arrives in parts, in order. The last part saves it on the computer as an attachment. */
  const receive = (a: Api, phoneId: string, p: Partial<PhoneUploadPart> | undefined): PhoneUploaded | { part: number } => {
    if (!a['attachments.save']) throw new Error('Not available from a phone.')
    if (!p || typeof p.upload !== 'string' || !UPLOAD_ID.test(p.upload)) throw new Error('That file could not be sent. Try again.')
    const key = `${phoneId}:${p.upload}`
    const fail = (message: string): never => {
      uploading.delete(key)
      throw new Error(message)
    }
    let up = uploading.get(key)
    if (p.part === 0 && !up) {
      const mine = [...uploading.keys()].filter((k) => k.startsWith(`${phoneId}:`))
      while (mine.length >= PHONE_UPLOAD_MAX_FILES) uploading.delete(mine.shift() as string)
      up = {
        name: baseName(String(p.name ?? '')).slice(0, 200) || 'file',
        mime: String(p.mime ?? '').slice(0, 100) || 'application/octet-stream',
        parts: [],
        bytes: 0,
        next: 0,
        width: pixels(p.width),
        height: pixels(p.height)
      }
      uploading.set(key, up)
    }
    if (!up || p.part !== up.next) return fail('That file could not be sent. Try again.')
    const data = typeof p.data === 'string' ? p.data : ''
    if (data.length > PART_CHARS || !BASE64.test(data)) return fail('That file could not be sent. Try again.')
    const bytes = Buffer.from(data, 'base64')
    up.bytes += bytes.length
    if (up.bytes > PHONE_UPLOAD_MAX_BYTES) return fail('That file is over 25 MB.')
    up.parts.push(bytes)
    up.next += 1
    if (!p.last) return { part: up.next }
    uploading.delete(key)
    if (!up.bytes) throw new Error('That file is empty.')
    const whole = Buffer.concat(up.parts)
    const info = a['attachments.save']({
      name: up.name,
      mime: up.mime,
      data: whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength) as ArrayBuffer,
      ...(up.width && up.height ? { width: up.width, height: up.height } : {})
    })
    const mine = saved.get(phoneId) ?? new Map<string, AttachmentInfo>()
    saved.set(phoneId, mine)
    mine.set(info.id, info)
    while (mine.size > KEPT_UPLOADS) {
      const [oldest] = mine.keys()
      mine.delete(oldest as string)
      a['attachments.discard']?.(oldest as string)
    }
    return { id: info.id, name: info.name, mime: info.mime, size: info.size }
  }

  /** The files this phone sent, by the ids it gives. Nothing else on the computer can be named. */
  const files = (phoneId: string, ids: unknown): AttachmentInfo[] => {
    if (ids === undefined || ids === null) return []
    if (!Array.isArray(ids)) throw new Error('That message could not be sent. Try again.')
    const unique = [...new Set(ids.map(String))]
    if (unique.length > PHONE_UPLOAD_MAX_FILES) throw new Error(`Attach at most ${PHONE_UPLOAD_MAX_FILES} files.`)
    const mine = saved.get(phoneId)
    return unique.map((id) => {
      const info = mine?.get(id)
      if (!info) throw new Error('A file is no longer on the computer. Attach it again.')
      return info
    })
  }
  const used = (phoneId: string, list: AttachmentInfo[]) => {
    const mine = saved.get(phoneId)
    for (const f of list) mine?.delete(f.id)
  }

  return async (method, params, phone) => {
    const a = api()
    const phoneId = phone?.id ?? ''
    switch (method) {
      case 'phone.upload':
        return receive(a, phoneId, params[0] as Partial<PhoneUploadPart> | undefined)
      case 'phone.discard': {
        const id = String(params[0] ?? '')
        if (saved.get(phoneId)?.delete(id)) a['attachments.discard']?.(id)
        return undefined
      }

      case 'phone.models': {
        const reply: PhoneModels = { models: await connectedModels(a, kept), pinned: a['app.bootstrap']().settings.pinnedModels ?? [] }
        return reply
      }
      case 'phone.workflows': {
        if (!a['workflows.list'] || !a['workflows.get']) return []
        const get = a['workflows.get']
        return a['workflows.list']().flatMap((s): PhoneWorkflow[] => {
          const w = get(s.id)
          return w ? [{ id: w.id, name: w.name, description: w.description, inputs: startInputs(w) }] : []
        })
      }
      case 'phone.runWorkflow': {
        // A run started from the phone works in the workflow's own folder (a phone never names one), and asks before it does
        // anything, as every run does: that card reaches the phone too.
        const [id, given] = params as [unknown, Record<string, unknown> | undefined]
        const w = a['workflows.get']?.(String(id))
        if (!w || !a['workflows.run']) throw new Error('That workflow is no longer on the computer.')
        const inputs = checkInputs(startInputs(w), given && typeof given === 'object' ? given : {})
        return a['workflows.run'](w.id, inputs, { folder: '', startedBy: 'you' })
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
        const sent = files(phoneId, params[2])
        if (!text.trim() && !sent.length) throw new Error('Write something first.')
        const how = (params[1] as PhoneNewSession | undefined) ?? { mode: 'chat' }
        const b = a['app.bootstrap']()
        const newest = (mode: 'chat' | 'develop') => b.sessions.filter((s) => s.mode === mode).sort((x, y) => y.updatedAt - x.updatedAt)[0]
        const title = titleFromText(text.trim() ? text : (sent[0]?.name ?? ''))
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
        a['sessions.send'](created.id, { text, attachments: sent })
        used(phoneId, sent)
        return created
      }
      case 'sessions.send': {
        // Words, files the phone sent itself, and files of the project (the computer checks those stay inside it).
        const [id, input, mode] = params as [unknown, Partial<PhoneMessage> | undefined, unknown]
        const text = String(input?.text ?? '').slice(0, 100_000)
        const sent = files(phoneId, input?.attachments)
        const context = Array.isArray(input?.context) ? (input.context as ContextRef[]) : []
        if (context.length > PHONE_CONTEXT_MAX) throw new Error(`Add at most ${PHONE_CONTEXT_MAX} project files.`)
        if (!text.trim() && !sent.length && !context.length) throw new Error('Write something first.')
        const sendMode = mode === 'queue' || mode === 'stop' ? mode : undefined
        const done = await a['sessions.send'](String(id), { text, attachments: sent, ...(context.length ? { context } : {}) }, sendMode)
        used(phoneId, sent)
        return done
      }
      default: {
        const fn = a[method as keyof CoreApi] as ((...x: unknown[]) => unknown) | undefined
        if (!fn) throw new Error('Not available from a phone.')
        return fn(...params)
      }
    }
  }
}
