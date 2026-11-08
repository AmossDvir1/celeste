import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { McpServerInput, McpServerView } from '@shared/api'
import { joinArgs, mcpSecretName, parseMcpJson, splitArgs } from '@shared/mcp'
import { secrets } from '@/api'
import { Modal } from '@/components/Dialog'
import { Field } from '@/components/form'
import { TextArea } from '@/components/form'
import { Button, IconButton, Segmented, TextInput } from '@/components/ui'
import { useMcp } from '@/stores/mcp'
import { useUi } from '@/stores/ui'

interface Pair {
  name: string
  value: string
  /** A value for this name is already stored: leaving the box empty keeps it. */
  saved: boolean
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

/** Adds a tool, or changes one. Secret values go to the encrypted store, never to the list. */
export function McpDialog() {
  const editing = useMcp((s) => s.editing)
  const setEditing = useMcp((s) => s.setEditing)
  return (
    <Modal
      open={editing !== null}
      onOpenChange={(open) => !open && setEditing(null)}
      title={editing === 'new' || editing === null ? 'Add a tool' : `Change ${editing.name}`}
      description="A tool is a program or a web address that gives the assistant new abilities. Every vendor can use it."
    >
      {editing !== null && <Form key={editing === 'new' ? 'new' : editing.id} server={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
    </Modal>
  )
}

function Form({ server, onDone }: { server: McpServerView | null; onDone: () => void }) {
  const save = useMcp((s) => s.save)
  const pushToast = useUi((s) => s.pushToast)
  const [type, setType] = useState<'stdio' | 'http'>(server?.type ?? 'stdio')
  const [name, setName] = useState(server?.name ?? '')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(joinArgs(server?.args ?? []))
  const [url, setUrl] = useState(server?.url ?? '')
  const [env, setEnv] = useState<Pair[]>((server?.envNames ?? []).map((n) => ({ name: n, value: '', saved: true })))
  const [headers, setHeaders] = useState<Pair[]>((server?.headerNames ?? []).map((n) => ({ name: n, value: '', saved: true })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => first.current?.focus(), [])

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const keep = (list: Pair[]) => list.filter((p) => p.name.trim())
      const e = type === 'stdio' ? keep(env) : []
      const h = type === 'http' ? keep(headers) : []
      const input: McpServerInput = {
        ...(server ? { id: server.id, enabled: server.enabled } : {}),
        name,
        type,
        ...(type === 'stdio' ? { command, args: splitArgs(args) } : { url }),
        envNames: e.map((p) => p.name.trim()),
        headerNames: h.map((p) => p.name.trim())
      }
      await save(input, { env: Object.fromEntries(e.map((p) => [p.name.trim(), p.value])), header: Object.fromEntries(h.map((p) => [p.name.trim(), p.value])) }, server ?? undefined)
      pushToast({ text: server ? 'Tool saved. Checking it now.' : 'Tool added. Checking it now.' })
      onDone()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="max-h-[calc(88vh-90px)] space-y-4 overflow-y-auto px-6 pt-4 pb-5"
      onSubmit={(ev) => {
        ev.preventDefault()
        void submit()
      }}
    >
      <Segmented
        label="Kind of tool"
        value={type}
        onChange={setType}
        options={[
          { value: 'stdio', label: 'A program' },
          { value: 'http', label: 'A web address' }
        ]}
      />
      <Field label="Name" hint="What you will see in the list. The assistant sees it too.">
        {(id) => <TextInput id={id} ref={first} value={name} maxLength={40} placeholder="Internal wiki" onChange={(e) => setName(e.target.value)} />}
      </Field>
      {type === 'stdio' ? (
        <>
          <Field label="Program to run" hint="For example npx, node, python or uvx.">
            {(id) => <TextInput id={id} value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />}
          </Field>
          <Field label="Arguments" hint="Separated by spaces. Put quotes around one that has spaces in it.">
            {(id) => <TextInput id={id} value={args} className="font-mono" placeholder="-y @modelcontextprotocol/server-everything" onChange={(e) => setArgs(e.target.value)} />}
          </Field>
          <Pairs title="Secret variables" hint="Values the program needs, such as an access token. They are stored encrypted and never shown again." namePlaceholder="API_TOKEN" pairs={env} onChange={setEnv} secretFor={(n) => (server ? mcpSecretName(server.id, 'env', n) : null)} />
        </>
      ) : (
        <>
          <Field label="Web address" hint="Starts with https://. A tool on this computer can use http://.">
            {(id) => <TextInput id={id} value={url} placeholder="https://tools.example.com/mcp" onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <Pairs title="Secret headers" hint="Sent with every request, such as Authorization. Stored encrypted and never shown again." namePlaceholder="Authorization" pairs={headers} onChange={setHeaders} secretFor={(n) => (server ? mcpSecretName(server.id, 'header', n) : null)} />
        </>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || (type === 'stdio' ? !command.trim() : !url.trim())}>
          {server ? 'Save' : 'Add tool'}
        </Button>
      </div>
    </form>
  )
}

function Pairs({
  title,
  hint,
  namePlaceholder,
  pairs,
  onChange,
  secretFor
}: {
  title: string
  hint: string
  namePlaceholder: string
  pairs: Pair[]
  onChange: (next: Pair[]) => void
  /** The secret that holds this name's value, to see whether one is stored. */
  secretFor: (name: string) => string | null
}) {
  const [stored, setStored] = useState<Record<string, boolean>>({})
  // Which of the named values really are stored, so "Saved" is never claimed for one that is not.
  useEffect(() => {
    for (const p of pairs) {
      const secret = secretFor(p.name)
      if (p.saved && secret && stored[p.name] === undefined) void secrets.has(secret).then((has) => setStored((s) => ({ ...s, [p.name]: has })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs.length])

  const set = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-ink-muted">{title}</div>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...pairs, { name: '', value: '', saved: false }])}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {pairs.length === 0 && <p className="text-xs text-ink-faint">{hint}</p>}
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <TextInput aria-label="Name" className="w-[38%] font-mono" value={p.name} placeholder={namePlaceholder} onChange={(e) => set(i, { name: e.target.value, saved: false })} />
          <TextInput
            aria-label={`Value of ${p.name || 'the secret'}`}
            type="password"
            autoComplete="off"
            value={p.value}
            placeholder={p.saved && stored[p.name] ? 'Saved. Leave empty to keep it.' : 'Value'}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <IconButton label="Remove" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

/** Adds the tools of a pasted configuration: the `.mcp.json` of a project, or the snippet a tool's page tells you to use. */
export function McpImportDialog() {
  const open = useMcp((s) => s.importOpen)
  const setOpen = useMcp((s) => s.setImportOpen)
  return (
    <Modal open={open} onOpenChange={setOpen} title="Paste a configuration" description="Paste the JSON a tool’s page gives you, or the contents of a .mcp.json file. Values such as tokens are stored encrypted.">
      {open && <Import onDone={() => setOpen(false)} />}
    </Modal>
  )
}

function Import({ onDone }: { onDone: () => void }) {
  const save = useMcp((s) => s.save)
  const pushToast = useUi((s) => s.pushToast)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<string[]>([])

  let parsed: ReturnType<typeof parseMcpJson> | null = null
  let problem = ''
  if (text.trim()) {
    try {
      parsed = parseMcpJson(text)
    } catch (err) {
      problem = message(err)
    }
  }

  const add = async () => {
    if (!parsed) return
    setBusy(true)
    const failed: string[] = []
    let added = 0
    for (const s of parsed.servers) {
      try {
        await save(
          {
            name: s.name,
            type: s.type,
            ...(s.type === 'stdio' ? { command: s.command, args: s.args } : { url: s.url }),
            envNames: s.type === 'stdio' ? Object.keys(s.env) : [],
            headerNames: s.type === 'http' ? Object.keys(s.headers) : []
          },
          { env: s.env, header: s.headers }
        )
        added++
      } catch (err) {
        failed.push(`${s.name}: ${message(err)}`)
      }
    }
    setBusy(false)
    setFailures(failed)
    if (added) pushToast({ text: added === 1 ? 'Tool added. Checking it now.' : `${added} tools added. Checking them now.` })
    if (!failed.length) onDone()
  }

  return (
    <div className="space-y-3 px-6 pt-4 pb-5">
      <TextArea aria-label="Configuration" rows={9} className="font-mono text-[13px]" value={text} placeholder={'{\n  "mcpServers": {\n    "wiki": { "command": "npx", "args": ["-y", "wiki-server"] }\n  }\n}'} onChange={(e) => setText(e.target.value)} />
      {problem && <p className="text-[13px] text-danger">{problem}</p>}
      {parsed && (
        <p className="text-[13px] text-ink-muted">
          {parsed.servers.length === 1 ? 'Found 1 tool' : `Found ${parsed.servers.length} tools`}: {parsed.servers.map((s) => s.name).join(', ')}.
          {parsed.skipped.length > 0 && <span className="block text-ink-faint">Left out: {parsed.skipped.join('; ')}.</span>}
        </p>
      )}
      {failures.map((f) => (
        <p key={f} role="alert" className="text-[13px] text-danger">
          {f}
        </p>
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !parsed || parsed.servers.length === 0} onClick={() => void add()}>
          {parsed && parsed.servers.length > 1 ? `Add ${parsed.servers.length} tools` : 'Add tool'}
        </Button>
      </div>
    </div>
  )
}
