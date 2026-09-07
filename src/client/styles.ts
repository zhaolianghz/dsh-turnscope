const STYLE_ID = '@zhaolianghz/dsh-turnscope'
const CSS = `
.turnscope-root{display:grid;gap:12px;padding:16px;overflow:auto}
.turnscope-card{border:1px solid var(--border-color,currentColor);border-radius:8px;padding:12px}
.turnscope-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.turnscope-status{font-weight:600}
.turnscope-summary{display:flex;flex-wrap:wrap;gap:16px;margin:10px 0}.turnscope-summary div{display:flex;gap:6px}
.turnscope-activities{display:grid;gap:6px;margin:0;padding-inline-start:22px}
`

let mountedStyle: HTMLStyleElement | null = null
let styleRefs = 0

export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  styleRefs += 1
  mountedStyle ??= document.querySelector<HTMLStyleElement>(`style[data-plugin="${STYLE_ID}"]`)
  if (mountedStyle === null) {
    mountedStyle = document.createElement('style')
    mountedStyle.dataset.plugin = STYLE_ID
    mountedStyle.textContent = CSS
    document.head.append(mountedStyle)
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    styleRefs -= 1
    if (styleRefs === 0) {
      mountedStyle?.remove()
      mountedStyle = null
    }
  }
}
