import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TurnscopeView } from './TurnscopeView.tsx'
import { en, NS, zh } from './locales.ts'
import { installStyles } from './styles.ts'

export const inject = ['slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turnscope: dictionaries')
  ctx.effect(installStyles, 'turnscope: styles')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'turnscope',
    order: 20,
    locale: NS,
    label: 'view.title',
  }, TurnscopeView))
}
