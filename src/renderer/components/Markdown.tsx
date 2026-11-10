import { memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { openLink } from '@/lib/links'
import { splitMarkdown } from '@/lib/markdown-chunks'

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-edge bg-field">
      <div className="flex h-8 items-center justify-between border-b border-edge/70 px-3 text-[11px] text-ink-faint">
        <span className="font-mono uppercase">{lang ?? 'text'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-ink-muted hover:bg-hover hover:text-ink"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-[1.6] text-ink">{code}</pre>
    </div>
  )
}

const components: Components = {
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-xl font-semibold text-ink first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-[17px] font-semibold text-ink first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-[15px] font-semibold text-ink first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5 marker:text-ink-faint">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 marker:text-ink-faint">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // A web link opens in Celeste's browser or the person's own, as they chose; Ctrl-click always means their own.
      onClick={(e) => {
        if (!href || !/^https?:\/\//i.test(href)) return
        e.preventDefault()
        void openLink(href, e)
      }}
      className="text-accent-text underline decoration-accent-text/40 underline-offset-2 hover:decoration-accent-text">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-accent-edge pl-4 text-ink-muted">{children}</blockquote>,
  hr: () => <hr className="my-5 border-edge" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-edge">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-raised/70 text-left text-ink-muted">{children}</thead>,
  th: ({ children }) => <th className="border-b border-edge px-3 py-2 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-edge/60 px-3 py-2 align-top last:border-b-0">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1]
    const text = String(children).replace(/\n$/, '')
    if (!lang && !text.includes('\n')) {
      return <code className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[0.88em] text-ink">{children as ReactNode}</code>
    }
    return <CodeBlock code={text} lang={lang} />
  }
}

/** One piece of a long reply. It is drawn again only when its own text changes, which for all but the last piece is never. */
const Piece = memo(function Piece({ text, first }: { text: string; first: boolean }) {
  // Inside a piece the first and last blocks have no outer margin; the gap between pieces is made here, as between any two blocks.
  return (
    <div className={first ? undefined : /^ {0,3}#{1,3}\s/.test(text) ? 'mt-5' : 'mt-2.5'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const pieces = useMemo(() => splitMarkdown(children), [children])
  return (
    <div className="selectable text-[15px] leading-[1.7] text-ink">
      {pieces.map((p, i) => (
        <Piece key={i} text={p} first={i === 0} />
      ))}
    </div>
  )
})
