/** A notebook (.ipynb), as the viewer shows it. */
export interface NotebookCell {
  kind: 'markdown' | 'code' | 'raw'
  source: string
  /** The number in `In [3]`, when the cell was run. */
  count: number | null
  outputs: NotebookOutput[]
}

export type NotebookOutput =
  | { kind: 'text'; text: string; error?: boolean }
  | { kind: 'image'; mime: string; data: string }

export interface Notebook {
  language: string
  cells: NotebookCell[]
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const join = (v: unknown): string => (Array.isArray(v) ? v.map(String).join('') : typeof v === 'string' ? v : '')

function outputs(raw: unknown): NotebookOutput[] {
  if (!Array.isArray(raw)) return []
  const list: NotebookOutput[] = []
  for (const o of raw as Record<string, unknown>[]) {
    const type = o['output_type']
    if (type === 'stream') list.push({ kind: 'text', text: join(o['text']).replace(ANSI, '') })
    else if (type === 'error') {
      const trace = Array.isArray(o['traceback']) ? (o['traceback'] as unknown[]).map(String).join('\n') : ''
      list.push({ kind: 'text', error: true, text: (trace || `${String(o['ename'] ?? 'Error')}: ${String(o['evalue'] ?? '')}`).replace(ANSI, '') })
    } else if (type === 'execute_result' || type === 'display_data') {
      const data = (o['data'] ?? {}) as Record<string, unknown>
      const image = ['image/png', 'image/jpeg', 'image/gif'].find((m) => typeof data[m] === 'string' || Array.isArray(data[m]))
      if (image) list.push({ kind: 'image', mime: image, data: join(data[image]).replace(/\s+/g, '') })
      else if (data['text/plain'] !== undefined) list.push({ kind: 'text', text: join(data['text/plain']).replace(ANSI, '') })
    }
  }
  return list
}

/** Reads a notebook. Throws when it is not one. */
export function parseNotebook(text: string): Notebook {
  const json = JSON.parse(text) as Record<string, unknown>
  const cells = json['cells'] ?? (json['worksheets'] as { cells?: unknown }[] | undefined)?.[0]?.cells
  if (!Array.isArray(cells)) throw new Error('This is not a notebook.')
  const meta = (json['metadata'] ?? {}) as { language_info?: { name?: string }; kernelspec?: { language?: string } }
  return {
    language: meta.language_info?.name ?? meta.kernelspec?.language ?? 'python',
    cells: (cells as Record<string, unknown>[]).map((c) => {
      const t = c['cell_type']
      return {
        kind: t === 'markdown' ? 'markdown' : t === 'code' ? 'code' : 'raw',
        source: join(c['source'] ?? c['input']),
        count: typeof c['execution_count'] === 'number' ? (c['execution_count'] as number) : typeof c['prompt_number'] === 'number' ? (c['prompt_number'] as number) : null,
        outputs: outputs(c['outputs'])
      }
    })
  }
}
