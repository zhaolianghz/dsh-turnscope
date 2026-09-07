// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

interface RuntimeExports {
  SlotRegistry: new (ctx: Context) => object
}

let runtimePromise: Promise<RuntimeExports> | undefined
function loadRuntime(): Promise<RuntimeExports> {
  runtimePromise ??= (async () => {
    let factory: ((require: (specifier: string) => unknown) => RuntimeExports) | undefined
    ;(window as unknown as { __ModuleLoader__: { load(handoff: { factory: typeof factory }): void } }).__ModuleLoader__ = {
      load: handoff => { factory = handoff.factory },
    }
    await import('@deepseek-ai/dsh-client-runtime/client')
    if (factory === undefined) throw new Error('runtime client bundle did not hand off')
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/cordis', await import('@deepseek-ai/cordis')],
      ['@deepseek-ai/dsh-client-ui-slots', await import('@deepseek-ai/dsh-client-ui-slots')],
    ])
    return factory(specifier => {
      if (!modules.has(specifier)) throw new Error(`unexpected runtime require: ${specifier}`)
      return modules.get(specifier)
    })
  })()
  return runtimePromise
}

async function bench() {
  const ctx = new Context()
  const { SlotRegistry } = await loadRuntime()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('sessions', { binding: () => undefined })
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: string) => key === 'view.title' ? 'Turns' : key,
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('Turnscope browser plugin', () => {
  it('registers the session-scoped conversation view', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('conversation.view')[0]?.options).toMatchObject({
      id: 'turnscope',
      order: 20,
    })
    await fiber.dispose()
  })

  it('shares one style and removes registrations on disposal', async () => {
    const first = await bench()
    const second = await bench()
    expect(document.querySelectorAll('style[data-plugin="@zhaolianghz/dsh-turnscope"]')).toHaveLength(1)
    await first.fiber.dispose()
    expect(first.ctx.slots.entries('conversation.view')).toHaveLength(0)
    expect(second.ctx.slots.entries('conversation.view')).toHaveLength(1)
    expect(document.querySelectorAll('style[data-plugin="@zhaolianghz/dsh-turnscope"]')).toHaveLength(1)
    await second.fiber.dispose()
    expect(second.ctx.slots.entries('conversation.view')).toHaveLength(0)
    expect(document.querySelectorAll('style[data-plugin="@zhaolianghz/dsh-turnscope"]')).toHaveLength(0)
  })
})
