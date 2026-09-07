import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('host plugin contract', () => {
  it('has a side-effect-free host apply', () => {
    expect(apply()).toBeUndefined()
  })

  it('declares the native DSH web client face', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(manifest.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
      platform: 'web',
    })
    expect(manifest.exports['./client'].default).toBe('./lib/client.js')
  })
})
