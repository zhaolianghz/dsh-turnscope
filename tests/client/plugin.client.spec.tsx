// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../../src/client/index.ts'
import { API_VERSION } from '../../src/shared/contracts/api.ts'

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
    await import('@deepseek-ai/dsh-client-ui-renderer/client')
    if (factory === undefined) throw new Error('renderer client bundle did not hand off')
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/cordis', await import('@deepseek-ai/cordis')],
      ['@deepseek-ai/dsh-client-ui-slots', await import('@deepseek-ai/dsh-client-ui-slots')],
      ['react', await import('react')],
      ['react-dom', await import('react-dom')],
      ['react-dom/client', await import('react-dom/client')],
      ['react/jsx-runtime', await import('react/jsx-runtime')],
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
  // The plugin asks the host what it recorded, so it declares the connection as
  // a dependency and cordis will not start it without one. The answer itself is
  // not read here — these tests are about registration and lifetime — but the
  // shape has to be one a render could survive.
  ctx.provide('connection', {
    rpc: {
      call: async () => ({
        ok: true,
        value: { apiVersion: API_VERSION, data: { turns: [] } },
      }),
    },
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

  // A real page caught this: the tab strip showed the literal `view.title`
  // beside 对话 and 轨迹, because `resolveSlotLabel` translates nothing — it
  // calls thunks and returns plain strings as they are. The assertion is on the
  // resolved label rather than on `typeof label === 'function'`, so it states the
  // requirement (readable text) instead of today's way of meeting it.
  it('shows the tab a translated label, not the dictionary key', async () => {
    const { ctx, fiber } = await bench()
    const { label } = ctx.slots.entries('conversation.view')[0]?.options ?? {}
    expect(resolveSlotLabel(label)).toBe('Turns')
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
