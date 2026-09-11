const STYLE_ID = '@zhaolianghz/dsh-turnscope'
/**
 * The panel's styling.
 *
 * Deliberately no per-level colours. `docs/PRD.md §14.4` forbids colour as the
 * only carrier of meaning, and the surest way to obey that is to carry no
 * meaning in colour at all: every state here is a word, and the stylesheet only
 * groups things — a chip is a chip whether it says "Safe" or "Unprotected".
 * (The one exception is inherited from the host's own page: `currentColor` and
 * its border/opacity variables, so the panel matches the theme it is drawn in
 * instead of asserting one.)
 */
const CSS = `
.turnscope-root{display:grid;gap:12px;padding:16px;overflow:auto}
.turnscope-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.turnscope-freshness{font-size:.85em;opacity:.8}
.turnscope-refresh{font:inherit;color:inherit;background:none;cursor:pointer;
  padding:2px 10px;border-radius:6px;border:1px solid currentColor}
.turnscope-refresh:disabled{opacity:.5;cursor:default}
.turnscope-card{border:1px solid var(--border-color,currentColor);border-radius:8px;padding:12px}
.turnscope-header{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.turnscope-status{font-weight:600}
.turnscope-host-status{font-size:.85em;opacity:.8}
.turnscope-summary{display:flex;flex-wrap:wrap;gap:16px;margin:10px 0}.turnscope-summary div{display:flex;gap:6px}
.turnscope-activities{display:grid;gap:6px;margin:0;padding-inline-start:22px}
.turnscope-note{opacity:.8;margin:0}
.turnscope-action{display:flex;gap:6px;margin:0}
.turnscope-action-label{opacity:.7}
.turnscope-safety,.turnscope-evidence{font-size:.85em;padding:1px 6px;border-radius:999px;border:1px solid currentColor;opacity:.9}
.turnscope-evidence{border-style:dashed}
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
