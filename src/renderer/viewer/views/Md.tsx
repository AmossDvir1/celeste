import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { slugify } from '../lib/outline'

const text = (children: ReactNode): string => (typeof children === 'string' ? children : Array.isArray(children) ? children.map(text).join('') : typeof children === 'object' && children && 'props' in children ? text((children as { props: { children?: ReactNode } }).props.children) : '')

/** The anchor of a heading in a document: the same text always gets the same one, repeats are numbered by the caller of `components`. */
function headings(): Pick<Components, 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'> {
  const seen = new Map<string, number>()
  const make = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', cls: string) =>
    function Heading({ children }: { children?: ReactNode }) {
      const base = slugify(text(children))
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return (
        <Tag id={n === 0 ? base : `${base}-${n}`} className={cls}>
          {children}
        </Tag>
      )
    }
  return {
    h1: make('h1', 'mt-7 mb-3 border-b border-edge pb-2 text-[26px] font-semibold text-ink first:mt-0'),
    h2: make('h2', 'mt-7 mb-2.5 border-b border-edge pb-1.5 text-[21px] font-semibold text-ink first:mt-0'),
    h3: make('h3', 'mt-6 mb-2 text-[17px] font-semibold text-ink'),
    h4: make('h4', 'mt-5 mb-1.5 text-[15px] font-semibold text-ink'),
    h5: make('h5', 'mt-4 mb-1 text-[14px] font-semibold text-ink'),
    h6: make('h6', 'mt-4 mb-1 text-[13px] font-semibold text-ink-muted')
  }
}

function components(): Components {
  return {
    ...headings(),
    p: ({ children }) => <p className="my-3 leading-[1.75]">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 marker:text-ink-faint">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 marker:text-ink-faint">{children}</ol>,
    li: ({ children }) => <li className="pl-0.5 leading-[1.7]">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    // A link in a document cannot be followed from here (the page stays where it is), so it is shown as one, with where it goes.
    a: ({ href, children }) => (
      <a href={href} title={href} onClick={(e) => e.preventDefault()} className="cursor-default text-accent-text underline decoration-accent-text/40 underline-offset-2">
        {children}
      </a>
    ),
    // Pictures are files beside the document, which the page cannot reach: the description is shown in their place.
    img: ({ alt }) => <span className="rounded bg-field px-1.5 py-0.5 text-[13px] text-ink-muted">🖼 {alt || 'image'}</span>,
    blockquote: ({ children }) => <blockquote className="my-4 border-l-2 border-accent-edge pl-4 text-ink-muted">{children}</blockquote>,
    hr: () => <hr className="my-6 border-edge" />,
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-xl border border-edge">
        <table className="w-full border-collapse text-[14px]">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-raised/70 text-left text-ink-muted">{children}</thead>,
    th: ({ children }) => <th className="border-b border-edge px-3 py-2 font-medium">{children}</th>,
    td: ({ children }) => <td className="border-b border-edge/60 px-3 py-2 align-top">{children}</td>,
    pre: ({ children }) => <pre className="my-4 overflow-x-auto rounded-xl border border-edge bg-field p-4 font-mono text-[12.5px] leading-[1.6]">{children}</pre>,
    code: ({ className, children }) =>
      className ? <code className={className}>{children}</code> : <code className="rounded bg-field px-1.5 py-0.5 font-mono text-[0.88em] text-ink">{children}</code>,
    input: ({ checked }) => <input type="checkbox" checked={!!checked} readOnly className="mr-2 align-middle accent-[var(--c-accent)]" />
  }
}

/** Markdown, drawn for reading. HTML inside it is not drawn as HTML. */
export const Md = memo(function Md({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components()}>
      {source}
    </ReactMarkdown>
  )
})
