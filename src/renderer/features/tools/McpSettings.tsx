import { useState } from 'react'
import { ChevronDown, ClipboardPaste, Globe, Pencil, Plus, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import type { McpServerView, McpStatus } from '@shared/api'
import { joinArgs } from '@shared/mcp'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/cn'
import { Badge, Button, IconButton, Spinner, Switch } from '@/components/ui'
import { useMcp } from '@/stores/mcp'

/** What a tool is doing, in a word: working (with how many tools it offers), not working, or being looked at. */
export function McpStatusBadge({ status, enabled = true }: { status: McpStatus; enabled?: boolean }) {
  if (!enabled) return <Badge>Off</Badge>
  switch (status.state) {
    case 'checking':
      return (
        <Badge>
          <Spinner className="h-3 w-3" /> Checking
        </Badge>
      )
    case 'ok':
      return <Badge tone="success">Working · {status.tools.length === 1 ? '1 tool' : `${status.tools.length} tools`}</Badge>
    case 'failed':
      return <Badge tone="warning">Not working</Badge>
    default:
      return <Badge>Not checked</Badge>
  }
}

const summary = (s: McpServerView) => (s.type === 'stdio' ? [s.command, joinArgs(s.args ?? [])].filter(Boolean).join(' ') : (s.url ?? ''))

/** Settings, Tools: every tool the person added, whether it works, and what it offers. */
export function McpSettings() {
  const servers = useMcp((s) => s.servers)
  const setEditing = useMcp((s) => s.setEditing)
  const setImportOpen = useMcp((s) => s.setImportOpen)

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        These tools are given to every chat that starts after you add them, whichever vendor runs it. Whether the assistant asks before using one follows the chat’s approval setting, like any other tool.
      </p>
      {servers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge-strong p-8 text-center">
          <div className="text-[15px] text-ink">No tools added</div>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-muted">Add a program or a web address that speaks MCP, or paste the configuration a tool’s page gives you.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button variant={servers.length === 0 ? 'primary' : 'secondary'} onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add a tool
        </Button>
        <Button variant="secondary" onClick={() => setImportOpen(true)}>
          <ClipboardPaste className="h-4 w-4" /> Paste a configuration
        </Button>
      </div>
    </div>
  )
}

function ServerCard({ server }: { server: McpServerView }) {
  const setEditing = useMcp((s) => s.setEditing)
  const setEnabled = useMcp((s) => s.setEnabled)
  const remove = useMcp((s) => s.remove)
  const test = useMcp((s) => s.test)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const Icon = server.type === 'stdio' ? Terminal : Globe
  const tools = server.status.state === 'ok' ? server.status.tools : []

  return (
    <li className="rounded-xl border border-edge p-4">
      <div className="flex items-center gap-3">
        <Icon className="h-[18px] w-[18px] shrink-0 text-ink-muted" aria-hidden />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-ink">{server.name}</span>
            <McpStatusBadge status={server.status} enabled={server.enabled} />
          </div>
          <div className="mt-1 truncate font-mono text-xs text-ink-muted" title={summary(server)}>
            {summary(server)}
          </div>
        </div>
        <Switch label={`${server.name} on`} checked={server.enabled} onCheckedChange={(v) => void setEnabled(server.id, v)} />
      </div>

      {server.status.state === 'failed' && server.enabled && <p className="selectable mt-3 text-[13px] leading-relaxed break-words text-warning">{server.status.message}</p>}

      {tools.length > 0 && (
        <div className="mt-3">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline">
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} /> {open ? 'Hide' : 'Show'} the tools it offers
          </button>
          {open && (
            <ul className="mt-2 space-y-1.5">
              {tools.map((t) => (
                <li key={t.name} className="text-[13px] leading-snug">
                  <span className="font-mono text-ink">{t.name}</span>
                  {t.description && <span className="text-ink-muted"> · {t.description.length > 140 ? `${t.description.slice(0, 140)}…` : t.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={server.status.state === 'checking'} onClick={() => void test(server.id)}>
          <RefreshCw className="h-4 w-4" /> Check again
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(server)}>
          <Pencil className="h-4 w-4" /> Change
        </Button>
        <span className="flex-1" />
        <IconButton label={`Remove ${server.name}`} onClick={() => setConfirm(true)}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>

      <ConfirmDialog
        open={confirm}
        title={`Remove ${server.name}?`}
        confirmLabel="Remove"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          void remove(server)
        }}
      >
        It stops being given to the assistant, and any token or header you stored for it is deleted. Chats already running keep it until they end.
      </ConfirmDialog>
    </li>
  )
}
