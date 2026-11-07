import type { ApprovalMode, Effort, ModelInfo, VendorId } from '@shared/agent'

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
  keyHint: string
  accent: string
}

export const VENDORS: Record<VendorId, VendorMeta> = {
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    menuLabel: 'GitHub Copilot',
    blurb: 'Free and paid Copilot plans, including Business and Enterprise.',
    connectHint: 'Opens GitHub in your browser to authorize.',
    billedTo: 'Your Copilot plan',
    keyHint: 'Use your own provider key instead',
    accent: '#8b7cf6'
  },
  claude: {
    id: 'claude',
    name: 'Claude Agent',
    menuLabel: 'Claude Agent',
    blurb: 'Anthropic’s agent, billed as API usage on your Claude Console account.',
    connectHint: 'Opens the Claude Console in your browser to authorize.',
    billedTo: 'Your Claude Console account',
    keyHint: 'Paste an API key instead',
    accent: '#e08a5c'
  },
  openai: {
    id: 'openai',
    name: 'OpenAI Codex',
    menuLabel: 'OpenAI',
    blurb: 'Use your ChatGPT plan, or an OpenAI API key.',
    connectHint: 'Continue with ChatGPT in your browser.',
    billedTo: 'Your ChatGPT plan',
    keyHint: 'Paste an API key instead',
    accent: '#3fb69b'
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    menuLabel: 'Google Gemini',
    blurb: 'Gemini through an API key, or Vertex AI for teams.',
    connectHint: 'Opens Google AI Studio so you can create a key.',
    billedTo: 'Your Gemini API account',
    keyHint: 'Use Vertex AI instead',
    accent: '#5b9cf5'
  }
}

const FULL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// Mock catalog. Real adapters report their own models and effort levels.
export const MODELS: ModelInfo[] = [
  { id: 'copilot-auto', vendor: 'copilot', label: 'Copilot Auto', efforts: [], images: true },
  { id: 'copilot-gpt', vendor: 'copilot', label: 'Copilot · GPT-5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', images: true },
  { id: 'copilot-sonnet', vendor: 'copilot', label: 'Copilot · Claude Sonnet', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'medium', images: true },
  { id: 'claude-opus', vendor: 'claude', label: 'Claude Opus', efforts: FULL, defaultEffort: 'high', images: true },
  { id: 'claude-sonnet', vendor: 'claude', label: 'Claude Sonnet', efforts: FULL, defaultEffort: 'medium', images: true },
  { id: 'claude-haiku', vendor: 'claude', label: 'Claude Haiku', efforts: [], images: true },
  { id: 'openai-gpt5', vendor: 'openai', label: 'GPT-5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', images: true },
  { id: 'openai-mini', vendor: 'openai', label: 'GPT-5 mini', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', images: true },
  { id: 'gemini-pro', vendor: 'gemini', label: 'Gemini Pro', efforts: [], images: true },
  { id: 'gemini-flash', vendor: 'gemini', label: 'Gemini Flash', efforts: [], images: false }
]

export const MODEL_BY_ID: Record<string, ModelInfo> = Object.fromEntries(MODELS.map((m) => [m.id, m]))

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
