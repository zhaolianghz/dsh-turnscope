// Open the served app in the already-running headless Chrome and read back what
// the probe wrote, plus every console message.
//
// CDP over the built-in `WebSocket` client, so this needs no dependency and no
// `npm install` inside a spike directory. `--dump-dom` was tried first and is
// not usable here: the page holds a websocket open, so virtual time never
// drains and the dump never happens.
const cdpPort = Number(process.argv[2] ?? 9333)
const pageUrl = process.argv[3] ?? 'http://127.0.0.1:38517/'

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const page = targets.find(target => target.type === 'page')
if (page === undefined) {
  console.error('no page target in the browser')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })

const logs = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    pending.get(message.id)?.(message)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(
      `console.${message.params.type}: ` +
        message.params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '),
    )
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    logs.push('exception: ' + (details.exception?.description ?? details.text))
  }
})

await new Promise(resolve => socket.addEventListener('open', resolve))
await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: pageUrl })
// The app boots its plugin graph, then our probe awaits one round trip. Nine
// seconds is generous and deterministic enough for a smoke; nothing here is a
// performance measurement.
await new Promise(resolve => setTimeout(resolve, 9000))

const evaluate = async expression =>
  (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Click the first visible button whose accessible name or text contains `wanted`.
 *
 * Text, not a selector: the app ships no `data-testid` anywhere (reconnaissance
 * via `INSPECT=1 run.sh` found `testids: []` on every screen), so its own labels
 * are the only handle a driver has.
 */
const clickByText = async wanted =>
  evaluate(`(() => {
    const wanted = ${JSON.stringify(wanted)}
    const button = [...document.querySelectorAll('button')]
      .find(n => ((n.getAttribute('aria-label') ?? '') + (n.textContent ?? '')).includes(wanted))
    if (button === undefined) return 'not found: ' + wanted
    button.click()
    return 'clicked: ' + wanted
  })()`)

console.log('--- probe node ---')
console.log(await evaluate('document.getElementById("ts-probe")?.textContent ?? "(no probe node)"'))
console.log('--- page signals ---')
console.log(
  await evaluate(
    'JSON.stringify({title:document.title, boot:!!window.__DSH_BOOT__, entries:window.__DSH_BOOT__?.entries?.length})',
  ),
)

// ---------------------------------------------------------------------------
// The panel: reach the tab our plugin contributes, and read what it rendered.
//
// Everything above is the interface (page → gateway → host → sqlite). This part
// is the panel, and it needs the app walked into a state where the tab ring
// exists at all. Three gates, each found by reconnaissance rather than guessed:
//
//   1. a beta notice whose only action is 「继续」;
//   2. no session opens without a workspace — `run.sh` seeds one host-side,
//      because the picker opens a directory dialog CDP cannot drive;
//   3. `ConversationSession` returns null while `composerPhase === 'blank'`, so
//      the tab strip does not exist until a prompt is *attempted*. Attempted,
//      not answered: the phase leaves `blank` when send is initiated, so no
//      model credentials are needed and the prompt is expected to fail.
// ---------------------------------------------------------------------------
console.log('--- opening a session ---')
for (const label of ['继续', '新建会话']) {
  console.log(await clickByText(label))
  await settle(3000)
}
console.log(await clickByText('稍后配置'))
await settle(1000)

const composer = await evaluate(`(() => {
  const box = document.querySelector('[contenteditable="true"][role="textbox"],textarea')
  if (box === null) return 'no composer'
  box.focus()
  return box.tagName
})()`)
if (composer === 'no composer') {
  console.log('--- session screen ---')
  console.log(await evaluate(`JSON.stringify({
    text: document.body.innerText.slice(0, 1200),
    inputs: [...document.querySelectorAll('textarea,input,[contenteditable]')].map(n => ({tag:n.tagName,placeholder:n.getAttribute('placeholder'),role:n.getAttribute('role')})),
    buttons: [...document.querySelectorAll('button')].map(n => (n.getAttribute('aria-label') ?? n.textContent ?? '').trim()).filter(Boolean).slice(0, 40)
  })`))
}
if (composer === 'DIV') {
  await send('Input.insertText', { text: 'a prompt that only has to be attempted' })
  console.log('typed into the composer')
} else {
  console.log(await evaluate(`(() => {
    const box = document.querySelector('textarea')
    if (box === null) return 'no composer'
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      .call(box, 'a prompt that only has to be attempted')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed into the composer'
  })()`))
}
await settle(1000)
console.log(await clickByText('发送消息'))
await settle(6000)

console.log('--- the tab strip ---')
console.log(await evaluate(`JSON.stringify([...document.querySelectorAll('[role="tab"]')].map(n => n.textContent))`))

// Click by the tab's *translated* text. A real run showed the literal key
// `view.title` here — `resolveSlotLabel` calls thunks but passes plain strings
// through untranslated — so asserting the readable label is asserting the fix.
console.log('--- opening the turnscope tab ---')
console.log(
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find(n => (n.textContent ?? '').trim() === '轮次')
    if (tab === undefined) {
      const seen = [...document.querySelectorAll('[role="tab"]')].map(n => (n.textContent ?? '').trim())
      return 'no turnscope tab; tabs are: ' + JSON.stringify(seen)
    }
    tab.click()
    return 'clicked the turnscope tab'
  })()`),
)
await settle(4000)

console.log('--- panel ---')
console.log(
  await evaluate(`(() => {
    const root = document.querySelector('.turnscope-root')
    if (root === null) return JSON.stringify({ panel: 'absent' })
    return JSON.stringify({
      panel: 'present',
      freshness: root.getAttribute('data-freshness'),
      cards: root.querySelectorAll('.turnscope-card').length,
      note: root.querySelector('.turnscope-note')?.textContent ?? null,
      text: (root.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    })
  })()`),
)

console.log('--- console ---')
for (const line of logs.slice(-40)) console.log(line)

process.exit(0)
