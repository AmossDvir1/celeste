// An absolute address: a relative one is joined to the page's origin, which is the string "null" for a file:// page, so Excalidraw would fall back to its CDN (esm.sh).
// The page the harness drives. Nothing of Excalidraw is loaded until run() asks for the canvas (the lazy chunk the app would have).
window.EXCALIDRAW_ASSET_PATH = new URL('./', location.href).href
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective}: ${String(e.blockedURI).slice(0, 80)}`))
window.__errors = []
window.addEventListener('error', (e) => window.__errors.push(String(e.message).slice(0, 160)))
window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason?.message ?? e.reason).slice(0, 160)))
window.__load = () => import('./canvas.jsx')
window.__ready = true
