import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const checkout = resolve(import.meta.dirname, '..')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE ?? 'web'
const directory = join(home, 'profiles', profile)
const name = '@zhaolianghz/dsh-turnscope'
const link = join(directory, 'node_modules', name)

try {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const declared = manifest.dependencies?.[name]
  const installed = await realpath(link)
  if (declared !== `link:${checkout}` || installed !== checkout) {
    throw new Error(`DSH ${profile} profile runs another checkout: ${installed}\nExpected: ${checkout}`)
  }
  await Promise.all(['lib/index.js', 'lib/client.js'].map(file => stat(join(checkout, file))))
  console.log(`DSH ${profile} profile runs the current checkout: ${checkout}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
