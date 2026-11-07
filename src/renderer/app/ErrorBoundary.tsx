import { Component, type ErrorInfo, type ReactNode } from 'react'

/** If a screen fails to draw, say so and offer a way back, instead of leaving a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('The interface failed to draw', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="flex h-screen w-screen items-center justify-center bg-canvas p-8 text-ink">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Something went wrong drawing this screen</h1>
          <p className="mt-3 text-[15px] text-ink-muted">Your sessions and settings are saved. Reloading usually fixes it. If it keeps happening, please report it.</p>
          <p className="mt-3 truncate font-mono text-xs text-ink-faint">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 h-10 rounded-lg bg-accent px-5 text-[14px] font-medium text-accent-ink hover:brightness-110"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
