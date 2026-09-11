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

console.log('--- probe node ---')
console.log(await evaluate('document.getElementById("ts-probe")?.textContent ?? "(no probe node)"'))
console.log('--- page signals ---')
console.log(
  await evaluate(
    'JSON.stringify({title:document.title, boot:!!window.__DSH_BOOT__, entries:window.__DSH_BOOT__?.entries?.length})',
  ),
)
console.log('--- console ---')
for (const line of logs.slice(-40)) console.log(line)

process.exit(0)
