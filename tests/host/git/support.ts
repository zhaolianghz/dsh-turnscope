import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  CheckpointPathState,
  CheckpointRecord,
  ObjectRecord,
} from '../../../src/host/domain/types.ts'
import type { CheckpointSink } from '../../../src/host/git/checkpoint.ts'

/**
 * Run git for test *setup* only.
 *
 * The code under test never uses this: it goes through the port, which is
 * restricted to read-only subcommands. Setup is allowed to write because the
 * fixture has to be a real repository — `git init`, `add`, `commit` — for the
 * observer to have anything true to observe.
 */
export const setupGit = (args: readonly string[], cwd: string): Promise<string> =>
  new Promise<string>((resolvePromise, rejectPromise) => {
    execFile('git', [...args], { cwd }, (error, stdout, stderr) => {
      if (error !== null) {
        rejectPromise(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
        return
      }
      resolvePromise(stdout)
    })
  })

/** A disposable repository with one empty commit, so `HEAD` always resolves. */
export const createRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'turnscope-git-'))
  await setupGit(['init', '-q'], root)
  await setupGit(['config', 'user.email', 'test@turnscope.invalid'], root)
  await setupGit(['config', 'user.name', 'Turnscope Test'], root)
  await setupGit(['config', 'commit.gpgsign', 'false'], root)
  await setupGit(['commit', '--allow-empty', '-q', '-m', 'init'], root)
  return root
}

/** Write a file inside the repository, creating parent directories. */
export const writeRepoFile = async (
  root: string,
  path: string,
  content: string | Uint8Array,
): Promise<void> => {
  const absolute = join(root, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

/** Stage and commit everything currently in the worktree. */
export const commitAll = async (root: string, message: string): Promise<void> => {
  await setupGit(['add', '-A'], root)
  await setupGit(['commit', '-q', '-m', message], root)
}

/** A {@link CheckpointSink} that keeps what it was given, for assertions. */
export interface RecordingSink extends CheckpointSink {
  readonly checkpoints: CheckpointRecord[]
  readonly paths: CheckpointPathState[]
  readonly objects: ObjectRecord[]
}

export const createRecordingSink = (): RecordingSink => {
  const checkpoints: CheckpointRecord[] = []
  const paths: CheckpointPathState[] = []
  const objects: ObjectRecord[] = []
  return {
    checkpoints,
    paths,
    objects,
    putCheckpoint: async record => {
      checkpoints.push(record)
    },
    putCheckpointPath: async record => {
      paths.push(record)
    },
    putObjectRecord: async record => {
      objects.push(record)
    },
  }
}
