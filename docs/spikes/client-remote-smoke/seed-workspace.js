// Register one workspace on the booted host, so the page has a directory to
// open a session in.
//
// Why this exists: our client plugin is not `immediately: true` — its
// `conversation.view` contribution only lands once the conversation view is
// mounted, and that view needs an open session. The real app will not open one
// without a workspace: reconnaissance (`INSPECT=1 run.sh`) found the landing
// page offering only a workspace picker, its composer disabled with
// "选择一个工作区开始". A picker click would open a native/browse directory
// dialog, which CDP cannot drive.
//
// So the workspace is created the way the app itself creates one:
// `ctx.workspaceRegistry.create(path)`, the published API of
// `@deepseek-ai/dsh-workspace`. Nothing is forged into the storage files — the
// registry canonicalizes the path, stamps the record, and commits its own
// durable order, so what the page reads is a record the real code wrote.
//
// This is a fixture, not part of the claim: it puts the app into the state a
// user reaches by picking a directory. What is being proved happens after it.
export const name = 'ts-seed-workspace'

export const inject = ['workspaceRegistry']

export function apply(ctx) {
  const path = process.env.TS_SEED_WORKSPACE
  if (path === undefined) return
  // `create` is async and boot does not await us; failing loudly on the console
  // is what we want, because a silent miss here would look like the panel
  // failing to render.
  ctx.workspaceRegistry.create(path, 'turnscope smoke').then(
    workspace => console.log(`[ts-seed-workspace] workspace ${workspace.id} -> ${workspace.path}`),
    error => console.error(`[ts-seed-workspace] create failed: ${error?.stack ?? error}`),
  )
}
