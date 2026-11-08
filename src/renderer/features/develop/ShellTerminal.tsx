import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { RotateCw } from 'lucide-react'
import { core } from '@/api'
import { Button } from '@/components/ui'

/** The colours of the window's theme, read where they are defined so the terminal always matches it. */
function themeColours(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string) => style.getPropertyValue(name).trim()
  const light = document.documentElement.dataset['theme'] === 'light'
  const base: ITheme = {
    background: v('--c-field'),
    foreground: v('--c-ink'),
    cursor: v('--c-accent'),
    cursorAccent: v('--c-field'),
    selectionBackground: light ? '#cfd8f5' : '#3b4a78'
  }
  // The usual sixteen, kept readable on the panel's own background in each theme.
  return light
    ? {
        ...base,
        black: '#111b4c', red: '#b3261e', green: '#1b6e3a', yellow: '#8a5a00', blue: '#1f4fd1', magenta: '#a3237a', cyan: '#0b6e7a', white: '#5b6685',
        brightBlack: '#424e6e', brightRed: '#d0342c', brightGreen: '#23884a', brightYellow: '#a06a00', brightBlue: '#3a64e0', brightMagenta: '#c02f92', brightCyan: '#12818f', brightWhite: '#111b4c'
      }
    : {
        ...base,
        black: '#1b2438', red: '#ff6b81', green: '#5fd68a', yellow: '#f2c35a', blue: '#7aa2ff', magenta: '#f58bd0', cyan: '#5fd3e0', white: '#d6dcef',
        brightBlack: '#6b7794', brightRed: '#ff8fa0', brightGreen: '#85e6a6', brightYellow: '#f7d584', brightBlue: '#9db8ff', brightMagenta: '#f9aee0', brightCyan: '#86e0ea', brightWhite: '#f7f8fc'
      }
}

/**
 * A real shell for the session, in its project folder. Core runs it and keeps it running while the panel is closed or another
 * session is shown; this only draws it and carries the typing across. Opening it again shows what the shell printed meanwhile.
 */
export function ShellTerminal({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const [ended, setEnded] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const el = host.current
    if (!el) return
    setEnded(null)
    setError(null)
    const t = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: themeColours()
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(el)
    term.current = t
    let alive = true
    // Output that arrives before the shell's earlier output has been drawn is already part of that earlier output.
    let ready = false

    const off = core.onPush((push) => {
      if (push.type !== 'terminal' || push.sessionId !== sessionId || !ready) return
      if (push.data) t.write(push.data)
      if (push.exited !== undefined) setEnded(push.exited)
    })
    const typing = t.onData((data) => void core.call('terminal.write', sessionId, data).catch(() => undefined))

    const sizeNow = () => {
      try {
        fit.fit()
      } catch {
        /* the panel is not on screen yet */
      }
      return { cols: t.cols, rows: t.rows }
    }
    const { cols, rows } = sizeNow()
    core.call('terminal.open', sessionId, cols, rows).then(
      (opened) => {
        if (!alive) return
        if (opened.output) t.write(opened.output)
        ready = true
        t.focus()
      },
      (err: unknown) => alive && setError(err instanceof Error ? err.message : 'Could not start a terminal.')
    )

    const watch = new ResizeObserver(() => {
      const s = sizeNow()
      void core.call('terminal.resize', sessionId, s.cols, s.rows).catch(() => undefined)
    })
    watch.observe(el)
    // Light and dark are switched on the page itself, so the terminal follows when that attribute changes.
    const theme = new MutationObserver(() => {
      t.options.theme = themeColours()
    })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      alive = false
      off()
      typing.dispose()
      watch.disconnect()
      theme.disconnect()
      // Only the drawing goes: the shell itself keeps running in Core.
      t.dispose()
      term.current = null
    }
  }, [sessionId, generation])

  const again = useCallback(() => setGeneration((g) => g + 1), [])

  return (
    <div className="relative h-full">
      <div ref={host} aria-label="Shell" className="h-full px-3 py-2" />
      {error && (
        <div role="alert" className="absolute inset-x-3 bottom-3 rounded-lg border border-danger/40 bg-panel px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      )}
      {ended !== null && (
        <div role="status" className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg border border-edge-strong bg-panel px-3 py-2 text-[13px] text-ink-muted">
          <span className="min-w-0 flex-1">The shell ended{ended ? ` (code ${ended})` : ''}.</span>
          <Button variant="secondary" size="sm" onClick={again}>
            <RotateCw className="h-3.5 w-3.5" /> Start a new one
          </Button>
        </div>
      )}
    </div>
  )
}
