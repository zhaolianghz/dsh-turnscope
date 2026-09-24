import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const checkout = resolve(import.meta.dirname, '..')
const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function profile(linkTarget: string) {
  const home = await mkdtemp(join(tmpdir(), 'turnscope-profile-check-'))
  homes.push(home)
  const web = join(home, 'profiles', 'web')
  const scope = join(web, 'node_modules', '@zhaolianghz')
  await mkdir(scope, { recursive: true })
  await writeFile(join(web, 'package.json'), JSON.stringify({
    dependencies: { '@zhaolianghz/dsh-turnscope': `link:${linkTarget}` },
  }))
  await symlink(linkTarget, join(scope, 'dsh-turnscope'))
  return home
}

function check(home: string) {
  return spawnSync(process.execPath, [join(checkout, 'scripts', 'check-active-profile.mjs')], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
}

it('reports a Web profile that still runs another checkout', async () => {
  const other = await mkdtemp(join(tmpdir(), 'turnscope-old-checkout-'))
  homes.push(other)
  const result = check(await profile(other))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('another checkout')
})

it('accepts a Web profile linked to the current checkout', async () => {
  const result = check(await profile(checkout))
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('current checkout')
})
