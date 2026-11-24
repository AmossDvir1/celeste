/** Markdown has no icon of its own in Lucide, so it gets a file outline with an "MD" mark. */
export function MdIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <text x="12" y="18" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">
        MD
      </text>
    </svg>
  )
}

export const isMarkdownName = (name: string) => /\.(md|markdown)$/i.test(name)
