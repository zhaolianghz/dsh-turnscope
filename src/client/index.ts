import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createTurnscopeView } from './TurnscopeView.tsx'
import { createHostApi } from './host-api.ts'
import { en, NS, zh } from './locales.ts'
import { installStyles } from './styles.ts'

/**
 * `connection` joins the list because the panel has to *ask* the host what it
 * recorded: the timeline is assembled in the browser, but whether a turn is safe
 * to undo is a statement about a repository on the host, and only the host can
 * make it. Without the connection the panel could still render the timeline, but
 * it would render verdicts it does not have.
 */
export const inject = ['slots', 'sessions', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  const host = createHostApi(connectionOf(ctx).rpc)
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turnscope: dictionaries')
  ctx.effect(installStyles, 'turnscope: styles')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'turnscope',
    order: 20,
    locale: NS,
    // A thunk, not the key: `resolveSlotLabel` translates nothing — it calls
    // thunks and passes plain strings through verbatim, so a bare `'view.title'`
    // reaches the tab strip as the literal text `view.title` beside the
    // first-party tabs. The `locale: NS` above only synthesizes the component's
    // own `t`; it does not reach this label. Being a thunk also means the tab
    // re-reads the dictionary when the reader switches language, which a string
    // resolved once at registration could not do.
    label: () => t('view.title'),
  }, createTurnscopeView(host)))
}

/**
 * Read the connection service.
 *
 * The assertion is written here rather than as a `declare module` augmentation
 * because `connection` means something else in the host program
 * (`HostConnectionHandle`, the host's own RPC registry) and a merged interface
 * would hand host code a type for a service that is not there. What makes the
 * assertion true is the `inject` list above: cordis does not start a plugin
 * whose declared services are missing, so by the time this body runs the service
 * exists. If it ever does not, that is a framework-level change and it should
 * fail here, loudly, rather than render a panel that silently shows nothing.
 */
const connectionOf = (ctx: ClientContext): ConnectionHandle => {
  const { connection } = ctx as ClientContext & { readonly connection: ConnectionHandle | undefined }
  if (connection === undefined) {
    throw new Error('turnscope: the connection service is missing despite `inject`')
  }
  return connection
}
