import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Owner-only on everything Turnscope creates. */
export const DIRECTORY_MODE = 0o700
export const FILE_MODE = 0o600

/** Marks a partially written file, so retention and debugging can spot one. */
export const TEMP_SUFFIX = '.tmp'

/**
 * Suffix that makes the temp path unpredictable as well as unique. Predictable
 * temp names are what makes symlink planting at that path possible; `wx` in
 * {@link writeFileAtomic} already refuses an existing path, and an unguessable
 * name keeps an attacker from pre-creating a regular file there either.
 */
const randomSuffix = (): string => randomBytes(8).toString('hex')

/**
 * Write `bytes` to `targetPath` so the path is never observed half-written.
 *
 * The temp file lives in the *same* directory as the target, so the final
 * `rename` cannot cross a filesystem boundary — a cross-device rename fails
 * outright, and a copy fallback would not be atomic. The handle is `fsync`ed
 * before the rename so the bytes are durable before the name points at them,
 * and the containing directory is `fsync`ed afterwards (best effort: not every
 * platform permits opening a directory) so the rename itself survives a crash.
 *
 * On any failure the temp file is removed and the original error rethrown; the
 * target is left exactly as it was.
 */
export async function writeFileAtomic(targetPath: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(targetPath)
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })

  const tempPath = join(
    directory,
    `${basename(targetPath)}.${randomSuffix()}${TEMP_SUFFIX}`,
  )

  let handle: FileHandle | undefined
  try {
    // `wx` fails if the path exists, including when it is a dangling symlink.
    handle = await open(tempPath, 'wx', FILE_MODE)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, targetPath)
  } catch (error) {
    // Closing can itself fail on a handle whose write already failed; the
    // original error is the one worth reporting.
    await handle?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }

  await syncDirectory(directory)
}

/** Best-effort directory `fsync`; unsupported platforms simply skip it. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Windows denies opening a directory, and some filesystems reject `fsync`
    // on one. Neither is a reason to fail a completed write.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
