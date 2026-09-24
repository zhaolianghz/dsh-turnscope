import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const home = await mkdtemp(join(tmpdir(), 'turnscope-dsh-smoke-'))
const env = { ...process.env, DSH_HOME: home }
const timeoutMs = 45_000
let server

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolveRun(output)
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`))
    })
  })
}

function waitForAddress(child) {
  return new Promise((resolveAddress, reject) => {
    let output = ''
    const safeOutput = () => output.replace(/token=[^\s]+/g, 'token=[redacted]')
    const timer = setTimeout(() => reject(new Error(`DSH did not start within ${timeoutMs} ms\n${safeOutput()}`)), timeoutMs)
    const onData = chunk => {
      output += chunk
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolveAddress(match[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); reject(new Error(`DSH exited before serving (${code})\n${safeOutput()}`)) })
  })
}

try {
  const version = (await run('dsh', ['--version'])).trim()
  await run('dsh', ['plugin', '--profile', 'web', 'add', root])
  const config = await run('dsh', ['--profile', 'web', '--dump-config'])
  if (!config.includes("name: '@zhaolianghz/dsh-turnscope'")) {
    throw new Error('Turnscope is absent from the composed Web profile')
  }

  server = spawn('dsh', ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const address = new URL(await waitForAddress(server))
  const auth = await fetch(address, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie')?.split(';')[0]
  if (auth.status !== 303 || !cookie) throw new Error(`DSH authentication failed (${auth.status})`)

  const origin = address.origin
  const page = await fetch(origin, { headers: { cookie } })
  if (page.status !== 200) throw new Error(`DSH Web page failed (${page.status})`)
  const html = await page.text()
  const entry = html.match(/\{"id":"@zhaolianghz\/dsh-turnscope","url":"([^"]+)"/)
  if (!entry) throw new Error('Turnscope is absent from the browser boot manifest')
  const asset = await fetch(new URL(entry[1], origin), { headers: { cookie } })
  if (asset.status !== 200) throw new Error(`Turnscope browser bundle failed (${asset.status})`)
  const source = await asset.text()
  if (!source.includes('previewRewind') || !source.includes('RecoverySection')) {
    throw new Error('Turnscope browser bundle is missing recovery entry points')
  }

  const contract = await readFile(join(root, 'src/shared/contracts/api.ts'), 'utf8')
  const apiVersion = Number(contract.match(/export const API_VERSION = (\d+)/)?.[1])
  if (!Number.isInteger(apiVersion)) throw new Error('Cannot determine Turnscope API version')
  const response = await fetch(new URL('/api/turnscope/listTurns', origin), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'turnscope-smoke', method: 'turnscope/listTurns',
      payload: { args: { request: { apiVersion, sessionId: 'turnscope-smoke-absent', limit: 1 } } },
    }),
  })
  const result = await response.json()
  const value = result?.result?.value
  if (response.status !== 200 || result?.rpcId !== 'turnscope-smoke' ||
      result?.result?.ok !== true || value?.apiVersion !== apiVersion ||
      !Array.isArray(value?.data?.turns) || value.data.turns.length !== 0) {
    throw new Error(`Turnscope host RPC failed (${response.status}): ${JSON.stringify(result).slice(0, 500)}`)
  }
  console.log(`DSH ${version}: Web profile, boot manifest, browser bundle, and host RPC OK`)
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGINT')
    await Promise.race([
      new Promise(resolveExit => server.once('close', resolveExit)),
      new Promise(resolveTimeout => setTimeout(resolveTimeout, 3_000)),
    ])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
  await rm(home, { recursive: true, force: true })
}
