/**
 * The host's view into the user's worktree.
 *
 * `runner/apply.ts` is the only place allowed to *write* the worktree, so
 * every read it needs (and every read the recovery service needs) goes
 * through this small module. Keeping it here means the runner tests can
 * hand the runner a fake, and the runner's source itself never names
 * `node:fs` (`tests/host/architecture.spec.ts`).
 */
import type { WorktreeReader } from '../recovery/service.ts';
/**
 * Concrete {@link WorktreeReader} the host mounts onto the recovery service.
 *
 * `readFile` returns `undefined` for `ENOENT` so the runner sees "this path
 * is gone" rather than "this path is broken", which is the same boundary the
 * inspector uses when it observes a deleted file (`docs/ARCHITECTURE.md
 * §10.2`). Anything else is a real IO error and propagates.
 */
export declare const createNodeWorktreeReader: () => WorktreeReader;
//# sourceMappingURL=worktree-reader.d.ts.map