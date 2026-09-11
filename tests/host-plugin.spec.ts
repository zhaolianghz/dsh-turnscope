import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.ts'

describe('host plugin contract', () => {
  it('mounts on a real Cordis context without throwing', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ name, apply })
    await fiber.await()
    await fiber.dispose()
  })

  it('never throws when handed unusable configuration', () => {
    expect(() => apply(new Context(), { retentionDays: 'nope', dataDir: 7 })).not.toThrow()
  })

  it('declares the native DSH web client face and the host bundle patch', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(manifest.dsh.client).toEqual({
      // Load order, not decoration: the client bundle reaches the host through the
      // connection service, so `dsh-client-connection` has to be in the graph
      // before this plugin can ask anything.
      inject: [
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
      platform: 'web',
    })
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['./client'].default).toBe('./lib/client.js')
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  })

  it('ships a patch that inserts exactly this package', () => {
    const patch = readFileSync('cordis.patch.yml', 'utf8')
    expect(patch).toContain('id: turnscope')
    expect(patch).toContain("name: '@zhaolianghz/dsh-turnscope'")
  })
})
