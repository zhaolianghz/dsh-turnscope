import { createHash } from 'node:crypto'
import { readdir, readFile, stat as statFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import { resolveObjectsDir } from './paths.ts'

/**
 * The object kinds this slice may store.
 *
 * Frozen, and the only source of valid values: a typo'd kind would file an
 * object where nothing later looks for it, so {@link ObjectStore.put} rejects
 * anything outside this set. A later Restore/Fork plan adds `diff` and
 * `snapshot` by extending this one object.
 */
export const OBJECT_KINDS = Object.freeze({
  /** Redacted, truncated tool and command output. Written by Task 6. */
  ACTIVITY_PAYLOAD: 'activity-payload',
} as const)

const KNOWN_KINDS: ReadonlySet<string> = new Set(Object.values(OBJECT_KINDS))

/** Content address of one stored object. */
export interface ObjectRef {
  /** `sha256:<64 lowercase hex>`, the key an index row stores. */
  readonly ref: string
  /** The bare hex digest, for callers that store it in a column of its own. */
  readonly sha256: string
  /** Size of the stored bytes. */
  readonly byteSize: number
}

export interface ObjectStore {
  /**
   * Store `bytes` and return their content address. Idempotent: identical bytes
   * land on one file, and an object that already exists is not rewritten.
   */
  put(kind: string, bytes: Uint8Array): Promise<ObjectRef>
  /** Read the object, verifying it still hashes to its own name. */
  get(ref: string): Promise<Uint8Array>
  /** Whether an object exists, without reading it. */
  has(ref: string): Promise<boolean>
  /** Metadata for an existing object, or `undefined` when there is none. */
  stat(ref: string): Promise<ObjectRef | undefined>
  /** Every stored ref, sorted, for retention walks. */
  listRefs(): Promise<readonly string[]>
}

const REF_PREFIX = 'sha256:'
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const PREFIX_PATTERN = /^[0-9a-f]{2}$/

const toRef = (hex: string): string => `${REF_PREFIX}${hex}`

/**
 * Parse a ref back to its digest, or `undefined` when it is not a well-formed
 * address. Callers decide whether that is a miss ({@link ObjectStore.has}) or
 * an error ({@link ObjectStore.get}).
 */
const digestFromRef = (ref: string): string | undefined => {
  if (!ref.startsWith(REF_PREFIX)) return undefined
  const hex = ref.slice(REF_PREFIX.length)
  return DIGEST_PATTERN.test(hex) ? hex : undefined
}

/**
 * One level of fan-out keeps any single directory small; two hex characters
 * give 256 buckets, which also makes a listing cheap to resume.
 */
const objectPath = (objectsDir: string, hex: string): string =>
  join(objectsDir, hex.slice(0, 2), hex.slice(2))

/** `stat` that reports absence as `undefined` and lets real errors through. */
const safeStat = async (
  path: string,
): Promise<{ readonly byteSize: number } | undefined> => {
  try {
    const info = await statFile(path)
    return { byteSize: info.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const refOf = (hex: string, byteSize: number): ObjectRef =>
  Object.freeze({ ref: toRef(hex), sha256: hex, byteSize })

/**
 * Open the content-addressed object store rooted at `<root>/objects`.
 *
 * Objects are addressed by the SHA-256 of their bytes, so the name *is* the
 * integrity check: {@link ObjectStore.get} recomputes the digest rather than
 * trusting the filename, which turns silent on-disk corruption (a truncated or
 * scribbled file) into a rejection instead of wrong bytes flowing into a report.
 */
export function createObjectStore(root: string): ObjectStore {
  const objectsDir = resolveObjectsDir(root)

  const put = async (kind: string, bytes: Uint8Array): Promise<ObjectRef> => {
    if (!KNOWN_KINDS.has(kind)) {
      throw new Error(
        `unknown object kind ${JSON.stringify(kind)}; expected one of ${[...KNOWN_KINDS].join(', ')}`,
      )
    }
    const hex = createHash('sha256').update(bytes).digest('hex')
    const byteSize = bytes.byteLength
    const path = objectPath(objectsDir, hex)

    // The digest already identifies the content, so an existing file is
    // already correct and rewriting it would only churn the filesystem.
    if ((await safeStat(path)) === undefined) {
      await writeFileAtomic(path, bytes)
    }
    return refOf(hex, byteSize)
  }

  const get = async (ref: string): Promise<Uint8Array> => {
    const hex = digestFromRef(ref)
    if (hex === undefined) throw new Error(`unknown object ref: ${ref}`)

    let bytes: Buffer
    try {
      bytes = await readFile(objectPath(objectsDir, hex))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`unknown object ref: ${ref}`)
      }
      throw error
    }

    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== hex) {
      throw new Error(
        `object store corruption: stored bytes for ${ref} hash to ${toRef(actual)}`,
      )
    }
    return bytes
  }

  const has = async (ref: string): Promise<boolean> => {
    const hex = digestFromRef(ref)
    if (hex === undefined) return false
    return (await safeStat(objectPath(objectsDir, hex))) !== undefined
  }

  const stat = async (ref: string): Promise<ObjectRef | undefined> => {
    const hex = digestFromRef(ref)
    if (hex === undefined) return undefined
    const info = await safeStat(objectPath(objectsDir, hex))
    return info === undefined ? undefined : refOf(hex, info.byteSize)
  }

  const listRefs = async (): Promise<readonly string[]> => {
    // Reads never create the store: an empty listing and an absent directory
    // are the same answer, so a caller cannot bring a store into being here.
    const prefixes = await readdirSafe(objectsDir)
    const refs: string[] = []
    for (const prefix of prefixes) {
      if (!PREFIX_PATTERN.test(prefix)) continue
      for (const name of await readdirSafe(join(objectsDir, prefix))) {
        const hex = `${prefix}${name}`
        if (DIGEST_PATTERN.test(hex)) refs.push(toRef(hex))
      }
    }
    return refs.sort()
  }

  return { put, get, has, stat, listRefs }
}

/**
 * `readdir` that yields nothing for a path that does not exist or is not a
 * directory. Anything else — a permission problem, say — propagates: reporting
 * an empty store when the store is merely unreadable would hide real breakage
 * from whoever runs retention.
 */
async function readdirSafe(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}
