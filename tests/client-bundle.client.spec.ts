// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Handoff {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

describe('tsdown client artifact', () => {
  it('hands off through the native DSH module loader', async () => {
    const code = readFileSync('lib/client.js', 'utf8')
    let handoff: Handoff | undefined
    ;(window as unknown as { __ModuleLoader__: { load(value: Handoff): void } }).__ModuleLoader__ = {
      load: value => { handoff = value },
    }

    new Function(code)()
    expect(handoff?.id).toBe('@zhaolianghz/dsh-turnscope')
    const modules = new Map<string, unknown>([
      ['react/jsx-runtime', await import('react/jsx-runtime')],
    ])
    const exports = handoff!.factory(specifier => {
      if (!modules.has(specifier)) throw new Error(`unexpected require: ${specifier}`)
      return modules.get(specifier)
    })
    expect(exports.apply).toBeTypeOf('function')
    expect(exports.inject).toEqual(['slots', 'sessions', 'locale'])
  })
})
