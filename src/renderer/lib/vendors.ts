import type { ApprovalMode, Effort, ModelInfo, VendorId } from '@shared/agent'

// What the screens say about each vendor and each approval mode. The models themselves come from the vendors.

export const VENDOR_ORDER: VendorId[] = ['copilot', 'claude', 'openai', 'gemini']

export interface VendorMeta {
  id: VendorId
  /** Name on the connect card. */
  name: string
  /** Group label in the model menu. Anthropic asks for "Claude Agent" in dropdowns. */
  menuLabel: string
  blurb: string
  /** What Connect does, in plain words, for the card. */
  connectHint: string
  billedTo: string
  /** The link under Connect that offers a pasted API key instead. Absent when the vendor takes none (Copilot signs in with GitHub only). */
  keyHint?: string
  /** False while Celeste has no adapter for the vendor: its card says "Coming soon" and offers nothing. */
  available: boolean
}

export const VENDORS: Record<VendorId, VendorMeta> = {
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    menuLabel: 'GitHub Copilot',
    blurb: 'Free and paid Copilot plans, including Business and Enterprise.',
    connectHint: 'Opens GitHub in your browser to authorize.',
    billedTo: 'Your Copilot plan',
    available: true
  },
  claude: {
    id: 'claude',
    name: 'Claude Agent',
    menuLabel: 'Claude Agent',
    blurb: 'Anthropic’s agent, billed as API usage on your Claude Console account.',
    connectHint: 'Opens the Claude Console in your browser to authorize.',
    billedTo: 'Your Claude Console account',
    keyHint: 'Paste an API key instead',
    available: true
  },
  openai: {
    id: 'openai',
    name: 'OpenAI Codex',
    menuLabel: 'OpenAI',
    blurb: 'Use your ChatGPT plan, or an OpenAI API key.',
    connectHint: 'Continue with ChatGPT in your browser.',
    billedTo: 'Your ChatGPT plan',
    keyHint: 'Paste an API key instead',
    available: false
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    menuLabel: 'Google Gemini',
    blurb: 'Gemini through an API key, or Vertex AI for teams.',
    connectHint: 'Opens Google AI Studio so you can create a key.',
    billedTo: 'Your Gemini API account',
    keyHint: 'Use Vertex AI instead',
    available: false
  }
}

export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** The effort to use after switching models: keep the current one if the new model has it. */
export function effortFor(model: ModelInfo, current: Effort | null, preferHigher = false): Effort | null {
  if (model.efforts.length === 0) return null
  if (current && model.efforts.includes(current)) return current
  if (preferHigher && model.efforts.includes('high')) return 'high'
  return model.defaultEffort ?? model.efforts[0]
}

export const APPROVAL_OPTIONS: {
  value: ApprovalMode
  label: string
  short: string
  description: string
  developOnly?: boolean
}[] = [
  { value: 'auto', label: 'Auto-approve', short: 'Auto-approve', description: 'Edits files and runs commands without asking.' },
  { value: 'edits', label: 'Auto-approve edits', short: 'Approve edits', description: 'File edits go through. Commands and web access ask first.' },
  { value: 'ask', label: 'Ask first', short: 'Ask first', description: 'Asks before every change, command or web request.' },
  { value: 'plan', label: 'Plan only', short: 'Plan only', description: 'Explores and proposes a plan. Changes nothing.', developOnly: true }
]
