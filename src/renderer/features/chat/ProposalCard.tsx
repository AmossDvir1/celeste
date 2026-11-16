import { memo, useState } from 'react'
import { Check, Plug, ShieldQuestion, Workflow, X } from 'lucide-react'
import type { ApprovalProposal } from '@shared/agent'
import { commandLineOf } from '@shared/mcp'
import { core } from '@/api'
import { Button, TextInput } from '@/components/ui'
import { storeServerSecrets, type McpSecretValues } from '@/stores/mcp'
import type { TimelineItem } from '@/stores/types'

type Proposal = Extract<TimelineItem, { kind: 'approval' }>
type WorkflowProposal = Extract<ApprovalProposal, { kind: 'workflow' }>
type PluginProposal = Extract<ApprovalProposal, { kind: 'plugin' }>

/** The command line exactly as it will run: every argument, with nothing left out or tidied. */
export const commandLine = commandLineOf

/**
 * The card for something the assistant wants to add: a workflow to save, or a plugin to install (docs/plans/INNER_TOOLS_PLAN.md, section 5).
 * It draws what Core built from validated arguments, and holds the buttons. Secret values typed here go straight to the main process's
 * secret store and never to Core, the log or the assistant.
 */
export const ProposalCard = memo(function ProposalCard({
  item,
  proposal,
  onAnswer
}: {
  item: Proposal
  proposal: ApprovalProposal
  onAnswer: (requestId: string, allow: boolean, always?: boolean, minutes?: number, again?: string) => void
}) {
  const name = proposal.kind === 'workflow' ? proposal.payload.name : proposal.payload.server.name
  if (item.status !== 'pending') {
    const done = item.status === 'allowed'
    return (
      <div className="flex max-w-[760px] items-center gap-2 text-[13px] text-ink-muted">
        {done ? <Check className="h-3.5 w-3.5 text-success" /> : <X className="h-3.5 w-3.5 text-danger" />}
        {done ? (proposal.kind === 'workflow' ? (proposal.edit ? 'You saved the changes to' : 'You saved') : 'You installed') : item.status === 'retried' ? 'You asked for another try' : 'You denied'}: <span className="truncate font-mono text-[12.5px]">{name}</span>
      </div>
    )
  }
  const heading = proposal.kind === 'workflow' ? (proposal.edit ? 'Save these changes?' : 'Save this workflow?') : 'Install this plugin?'
  return (
    <div role="group" aria-label={heading} className="animate-fade-up max-w-[760px] rounded-xl border border-accent-edge bg-accent-soft/50 p-4">
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <ShieldQuestion className="h-[18px] w-[18px] text-accent-text" />
        {heading}
      </div>
      {proposal.kind === 'workflow' ? <WorkflowBody proposal={proposal} item={item} onAnswer={onAnswer} /> : <PluginBody proposal={proposal} item={item} onAnswer={onAnswer} />}
    </div>
  )
})

type Answer = (requestId: string, allow: boolean, always?: boolean, minutes?: number, again?: string) => void

function WorkflowBody({ proposal, item, onAnswer }: { proposal: WorkflowProposal; item: Proposal; onAnswer: Answer }) {
  const { payload } = proposal
  const [changing, setChanging] = useState(false)
  const [words, setWords] = useState('')
  return (
    <>
      <div className="mt-2.5 rounded-lg bg-field px-3 py-2.5">
        <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
          <Workflow className="h-4 w-4 shrink-0 text-ink-muted" />
          <span className="selectable min-w-0 break-words">{payload.name}</span>
        </div>
        {payload.description && <div className="selectable mt-1 text-[13px] text-ink-muted">{payload.description}</div>}
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-ink" aria-label="Steps">
          {payload.steps.map((s, i) => (
            <li key={i} className="selectable break-words">
              <span className="font-medium">{s.name}</span>
              {s.summary && <span className="text-ink-muted">: {s.summary}</span>}
            </li>
          ))}
        </ol>
        {payload.inputs.length > 0 && (
          <div className="selectable mt-2 text-[13px] text-ink-muted">
            Asks for: {payload.inputs.map((i) => `${i.name} (${i.type}${i.required ? ', required' : ''})`).join(', ')}
          </div>
        )}
        {payload.notes.length > 0 && (
          <ul className="selectable mt-2 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-muted">
            {payload.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
      {changing && (
        <div className="mt-3 space-y-2">
          <label htmlFor={`again-${item.requestId}`} className="text-[13px] text-ink-muted">
            What should be different?
          </label>
          <textarea
            id={`again-${item.requestId}`}
            value={words}
            maxLength={2000}
            rows={3}
            autoFocus
            onChange={(e) => setWords(e.target.value)}
            className="w-full resize-y rounded-control border border-edge bg-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent-edge focus:outline-none"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {changing ? (
          <>
            <Button variant="primary" size="sm" disabled={!words.trim()} onClick={() => onAnswer(item.requestId, false, undefined, undefined, words.trim())}>
              Send
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
              Back
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" autoFocus onClick={() => onAnswer(item.requestId, true)}>
              {proposal.accept}
            </Button>
            {proposal.retry && (
              <Button variant="secondary" size="sm" onClick={() => setChanging(true)}>
                {proposal.retry}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onAnswer(item.requestId, false)}>
              Deny
            </Button>
          </>
        )}
      </div>
    </>
  )
}

function PluginBody({ proposal, item, onAnswer }: { proposal: PluginProposal; item: Proposal; onAnswer: Answer }) {
  const { server, source } = proposal.payload
  const [values, setValues] = useState<McpSecretValues>({ env: {}, header: {} })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const asked: { kind: 'env' | 'header'; name: string }[] = [...server.envNames.map((name) => ({ kind: 'env' as const, name })), ...server.headerNames.map((name) => ({ kind: 'header' as const, name }))]
  const complete = asked.every((a) => (values[a.kind][a.name] ?? '').length > 0)

  const install = async () => {
    setBusy(true)
    setProblem('')
    try {
      // The values need the server's id, so it is saved first, switched off. Core then finds it by its name and tests it.
      if (asked.length > 0) {
        const saved = await core.call('mcp.save', { ...server, enabled: false })
        await storeServerSecrets(saved, values)
      }
      onAnswer(item.requestId, true)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'It could not be saved.')
      setBusy(false)
    }
  }

  return (
    <>
      <div className="mt-2.5 space-y-2 rounded-lg bg-field px-3 py-2.5">
        <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
          <Plug className="h-4 w-4 shrink-0 text-ink-muted" />
          <span className="selectable min-w-0 break-words">{server.name}</span>
        </div>
        <div>
          <div className="text-[12px] text-ink-muted">{server.type === 'stdio' ? 'It runs this program on this computer, with your rights:' : 'It connects to this address:'}</div>
          <div className="selectable mt-1 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-ink">{commandLine(server)}</div>
        </div>
        {source && <div className="selectable text-[12.5px] text-ink-muted">The assistant says it came from: {source}</div>}
      </div>
      {asked.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-[13px] text-ink-muted">It needs these secrets. They are stored encrypted on this computer and the assistant never sees them.</div>
          {asked.map((a) => (
            <div key={`${a.kind}-${a.name}`} className="flex items-center gap-3">
              <label htmlFor={`secret-${item.requestId}-${a.kind}-${a.name}`} className="w-[38%] shrink-0 truncate font-mono text-[12.5px] text-ink">
                {a.name}
              </label>
              <TextInput
                id={`secret-${item.requestId}-${a.kind}-${a.name}`}
                type="password"
                autoComplete="off"
                className="h-9 flex-1"
                value={values[a.kind][a.name] ?? ''}
                onChange={(e) => setValues({ ...values, [a.kind]: { ...values[a.kind], [a.name]: e.target.value } })}
              />
            </div>
          ))}
        </div>
      )}
      {problem && (
        <div role="alert" className="mt-2 text-[13px] text-danger">
          {problem}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy || !complete} autoFocus={asked.length === 0} onClick={() => void install()}>
          {proposal.accept}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(item.requestId, false)}>
          Deny
        </Button>
        <span className="text-[12px] text-ink-faint">It is installed switched off, tested, and switched on only if the test passes.</span>
      </div>
    </>
  )
}
