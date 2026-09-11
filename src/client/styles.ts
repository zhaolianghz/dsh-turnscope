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
.turnscope-expand{font:inherit;color:inherit;background:none;cursor:pointer;justify-self:start;
  padding:2px 10px;border-radius:6px;border:1px solid currentColor}
.turnscope-detail{display:grid;gap:14px;margin-top:10px;padding-top:10px;
  border-top:1px solid var(--border-color,currentColor)}
.turnscope-section{display:grid;gap:6px}
.turnscope-section h4{display:flex;align-items:center;gap:8px;margin:0;font-size:.95em}
.turnscope-count{font-weight:400;opacity:.7}
.turnscope-detail-note{margin:0;opacity:.8;font-size:.9em}
.turnscope-recovery-note{font-style:italic}
.turnscope-changes,.turnscope-tests,.turnscope-commands,.turnscope-reasons{display:grid;gap:6px;margin:0;
  padding-inline-start:18px}
.turnscope-change{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-path,.turnscope-command-text,.turnscope-reason-path,.turnscope-rename,
.turnscope-validation-kind,.turnscope-result,.turnscope-confidence,.turnscope-baseline{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
.turnscope-kind,.turnscope-attribution,.turnscope-confidence,.turnscope-baseline,
.turnscope-validation-kind,.turnscope-result,.turnscope-evaluated{opacity:.85}
.turnscope-kind,.turnscope-attribution,.turnscope-confidence,.turnscope-baseline{
  font-size:.85em;padding:0 6px;border-radius:4px;border:1px solid currentColor}
.turnscope-kind,.turnscope-confidence{font-family:inherit}
.turnscope-reason{display:grid;gap:2px}
.turnscope-reason-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-reason-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;opacity:.8}
.turnscope-reason-detail{margin:0;opacity:.9}
.turnscope-reason-evidence{font-size:.85em;opacity:.7}
.turnscope-verdict{flex-wrap:wrap}
.turnscope-evaluated{font-size:.85em;margin-inline-start:auto}
.turnscope-allowed{margin:0;display:flex;gap:6px}
.turnscope-command,.turnscope-test{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-test-summary{opacity:.9}
.turnscope-path-button{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:inherit;background:none;cursor:pointer;padding:0;border:0;border-bottom:1px dotted currentColor}
.turnscope-diff-toggle{font-size:.8em;opacity:.7}
.turnscope-diff{display:grid;gap:8px;margin-top:8px;padding:8px;border-radius:6px;
  border:1px solid var(--border-color,currentColor)}
.turnscope-diff-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.turnscope-diff-side{font-size:.85em;opacity:.8}
.turnscope-diff-nonewline{margin-inline-start:6px}
.turnscope-hunks{display:grid;gap:8px}
.turnscope-hunk{display:grid;gap:2px}
.turnscope-hunk-head,.turnscope-hunk-body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
.turnscope-hunk-head{opacity:.75}
.turnscope-hunk-body{margin:0;white-space:pre;overflow-x:auto}
.turnscope-diff-line{display:block}
/* The mark and the number are the meaning; nothing below relies on colour. */
.turnscope-diff-mark{display:inline-block;width:1ch}
.turnscope-diff-number{display:inline-block;width:5ch;text-align:end;padding-inline-end:1ch;opacity:.55}
.turnscope-diff-note{margin:0;font-size:.9em;opacity:.85}
.turnscope-diff-reason{font-weight:600}
/* V0.2 recovery section. No new colours; the apply button's disabled state
   inherits the rest of the panel's muted look. */
.turnscope-recovery{display:grid;gap:8px;padding-top:8px;
  border-top:1px dashed var(--border-color,currentColor)}
.turnscope-recovery-header{display:flex;align-items:baseline;gap:8px}
.turnscope-recovery-actions{display:flex;flex-wrap:wrap;gap:8px}
.turnscope-preview,.turnscope-apply,.turnscope-refresh-list{font:inherit;color:inherit;
  background:none;cursor:pointer;padding:2px 10px;border-radius:6px;border:1px solid currentColor}
.turnscope-preview:disabled,.turnscope-apply:disabled,.turnscope-refresh-list:disabled{
  opacity:.5;cursor:default}
.turnscope-recovery-ops{margin:0;padding-inline-start:18px;font-family:ui-monospace,SFMono-Regular,
  Menlo,monospace;font-size:.85em}
.turnscope-recovery-failure{margin:0;font-size:.9em}
.turnscope-recovery-result{margin:0;font-size:.9em}
.turnscope-recovery-list{margin:0;font-size:.9em;opacity:.85}
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
