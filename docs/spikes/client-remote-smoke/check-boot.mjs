// Assert that both third-party packages reached the served boot graph.
//
// Read from the index HTML rather than assumed from the config tree: the config
// tree only says the loader was asked to load them, while `__DSH_BOOT__` is
// what the browser is actually handed. A package that failed to resolve, that
// declared no `./client` export, or that named a non-web platform would be
// missing here and present there.
import { readFileSync } from 'node:fs'

const html = readFileSync(process.argv[2], 'utf8')
const start = html.indexOf('__DSH_BOOT__')
if (start === -1) {
  console.error('no __DSH_BOOT__ in the served index — is this the web app?')
  process.exit(1)
}

// Brace matching rather than a regex: the payload is JSON embedded in a script
// tag, and a lazy match either stops early or swallows the rest of the page.
const open = html.indexOf('{', start)
let depth = 0
let end = open
for (; end < html.length; end += 1) {
  if (html[end] === '{') depth += 1
  else if (html[end] === '}') {
    depth -= 1
    if (depth === 0) break
  }
}

const boot = JSON.parse(html.slice(open, end + 1))
console.log(`entries: ${boot.entries.length}`)
for (const entry of boot.entries) {
  if (entry.id.startsWith('@zhaolianghz/')) console.log(JSON.stringify(entry))
}

const ours = boot.entries.filter(entry => entry.id === '@zhaolianghz/dsh-turnscope')
if (ours.length !== 1) {
  console.error('turnscope is not in the boot graph exactly once')
  process.exit(1)
}
