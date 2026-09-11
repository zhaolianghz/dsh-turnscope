// Inventory a booted DSH web page, to find out what a headless browser can see.
//
// This is the reconnaissance half of proving the `conversation.view` tab in a
// real page: our client plugin is not `immediately: true`, so its contribution
// only lands once the conversation view is mounted, and the view needs an open
// session. Before driving anything, this dumps the tab strip, the buttons that
// look like they create or open a session, and whatever the probe reported.
//
// Not part of the proof (`drive.mjs` is); this exists so that the proof can be
// written against the real DOM instead of a guess about it.
//
// Usage: inspect.mjs [cdpPort] [pageUrl]
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
await new Promise(resolve => setTimeout(resolve, 9000))

const evaluate = async expression =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value

const INVENTORY = `(() => {
  const text = node => (node.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 60)
  const visible = node => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)
  return JSON.stringify({
    title: document.title,
    url: location.href,
    tabs: [...document.querySelectorAll('[role="tab"]')].map(n => text(n)),
    tablist: [...document.querySelectorAll('[role="tablist"]')].map(n => n.getAttribute('aria-label')),
    buttons: [...document.querySelectorAll('button')].filter(visible).map(n => ({
      text: text(n), label: n.getAttribute('aria-label'), testid: n.getAttribute('data-testid'),
    })).slice(0, 30),
    testids: [...document.querySelectorAll('[data-testid]')].map(n => n.getAttribute('data-testid')).slice(0, 40),
    inputs: [...document.querySelectorAll('textarea,[contenteditable=true],[role="textbox"]')]
      .map(n => ({ tag: n.tagName, ce: n.getAttribute('contenteditable'), ph: n.getAttribute('placeholder') ?? n.getAttribute('data-placeholder') })),
    bodySample: (document.body?.innerText ?? '').slice(0, 400),
    htmlChars: document.body?.innerHTML.length ?? 0,
    probe: document.getElementById('ts-probe')?.textContent ?? '(no probe node)',
    bodyChars: (document.body?.textContent ?? '').length,
  }, null, 1)
})()`

console.log('--- inventory (landing) ---')
console.log(await evaluate(INVENTORY))

// A first run found the landing page behind a beta notice whose only action is
// "继续"; nothing below it is reachable until that is dismissed.
const clickByText = async wanted =>
  evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(n => ((n.getAttribute('aria-label') ?? '') + (n.textContent ?? '')).includes(${JSON.stringify(wanted)}))
    if (button === undefined) return 'not found: ' + ${JSON.stringify(wanted)}
    button.click()
    return 'clicked: ' + ${JSON.stringify(wanted)}
  })()`)

for (const label of ['继续', '新建会话']) {
  console.log(`--- ${await clickByText(label)} ---`)
  await new Promise(resolve => setTimeout(resolve, 3000))
}

// The tab ring is gated on `composerPhase !== 'blank'`
// (`ConversationSession` returns null while the session is blank). The phase
// leaves `blank` as soon as a prompt is *attempted* — `promptAttempted` is set
// when send is initiated, not when a model answers — so an unanswerable prompt
// is enough to mount the view area. React owns the textarea's value, hence the
// native setter rather than assignment.
console.log('--- typing and sending a prompt ---')
console.log(
  await evaluate(`(() => {
    const box = document.querySelector('textarea')
    if (box === null) return 'no composer'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, 'hello from the smoke')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed: ' + box.value
  })()`),
)
await new Promise(resolve => setTimeout(resolve, 1000))
console.log(await clickByText('发送消息'))
await new Promise(resolve => setTimeout(resolve, 6000))
console.log('--- inventory (after sending) ---')
console.log(await evaluate(INVENTORY))

console.log('--- console ---')
for (const line of logs.slice(-25)) console.log(line)

process.exit(0)
