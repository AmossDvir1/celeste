import { useMemo } from 'react'
import { Bar, Note } from '../ui'
import { decodeText } from '../lib/text'
import { rtfToText } from '../lib/rtf'
import type { ViewProps } from '../App'

/** A rich text file (.rtf), as its words and paragraphs. */
export default function RtfView({ file, data }: ViewProps) {
  const text = useMemo(() => rtfToText(decodeText(data, 20 * 1024 * 1024).text), [data])
  return (
    <div className="min-h-screen bg-panel text-ink-soft">
      <Bar>
        <span>{file.name}</span>
      </Bar>
      <Note>A simplified view: the words and paragraphs, not the fonts and layout. Open the file in your own program to see it as it was made.</Note>
      <article className="mx-auto max-w-[780px] px-6 py-6 text-[15px] leading-[1.75] whitespace-pre-wrap">{text || 'There is no text in this file.'}</article>
    </div>
  )
}
