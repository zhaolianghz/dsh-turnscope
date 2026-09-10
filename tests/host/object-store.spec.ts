import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OBJECT_KINDS, createObjectStore, type ObjectStore } from '../../src/host/storage/object-store.ts'

const KIND = OBJECT_KINDS.ACTIVITY_PAYLOAD
/** The policy every diagnostic-payload call site must declare. */
const REDACTED = { redaction: 'applied' } as const
/** Binary input covering the extremes: a zero byte and a 0xFF byte. */
const BINARY = new Uint8Array([0x00, 0xff, 0x10, 0x00, 0x7f, 0xff])

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Every object file, as `<prefix>/<rest>`, relative to the objects directory. */
const objectFiles = async (objectsDir: string): Promise<string[]> => {
  const found: string[] = []
  let prefixes: string[]
  try {
    prefixes = await readdir(objectsDir)
  } catch {
    return found
  }
  for (const prefix of prefixes.sort()) {
    for (const name of (await readdir(join(objectsDir, prefix))).sort()) {
      found.push(`${prefix}/${name}`)
    }
  }
  return found
}

const permissions = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

let root: string
let store: ObjectStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'turnscope-objects-'))
  store = createObjectStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('OBJECT_KINDS', () => {
  it('pins the two literals, one per side of the redaction boundary', () => {
    expect(OBJECT_KINDS.ACTIVITY_PAYLOAD).toBe('activity-payload')
    expect(OBJECT_KINDS.RECOVERY_BLOB).toBe('recovery-blob')
    expect(Object.isFrozen(OBJECT_KINDS)).toBe(true)
  })
})

describe('the redaction boundary', () => {
  it('stores a recovery blob byte-for-byte, unlike a diagnostic payload', async () => {
    // These are the workspace's own bytes, captured so a recovery can put them
    // back. Redacting them would write the substitution over the user's file.
    const secret = Buffer.from('api_key = sk-abcdefghijklmnopqrstuvwx', 'utf8')

    const { ref } = await store.put(OBJECT_KINDS.RECOVERY_BLOB, secret, { redaction: 'raw-bytes' })

    expect(Buffer.from(await store.get(ref)).toString('utf8')).toBe(secret.toString('utf8'))
  })

  it('refuses a diagnostic payload offered as raw bytes', async () => {
    await expect(
      store.put(OBJECT_KINDS.ACTIVITY_PAYLOAD, BINARY, { redaction: 'raw-bytes' }),
    ).rejects.toThrow(/must be stored with redaction "applied"/)
  })

  it('refuses a recovery blob offered as already redacted', async () => {
    await expect(
      store.put(OBJECT_KINDS.RECOVERY_BLOB, BINARY, { redaction: 'applied' }),
    ).rejects.toThrow(/must be stored with redaction "raw-bytes"/)
  })
})

describe('createObjectStore.put', () => {
  it('returns a sha256 ref and the input size', async () => {
    const result = await store.put(KIND, BINARY, REDACTED)

    expect(result.ref).toBe(`sha256:${sha256Hex(BINARY)}`)
    expect(result.ref).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.sha256).toBe(sha256Hex(BINARY))
    expect(result.byteSize).toBe(BINARY.byteLength)
  })

  it('stores under a two-character prefix directory with mode 0o600', async () => {
    const { ref } = await store.put(KIND, BINARY, REDACTED)
    const hex = ref.slice('sha256:'.length)

    expect(await objectFiles(join(root, 'objects'))).toEqual([
      `${hex.slice(0, 2)}/${hex.slice(2)}`,
    ])
    expect(await permissions(join(root, 'objects'))).toBe(0o700)
    expect(await permissions(join(root, 'objects', hex.slice(0, 2)))).toBe(0o700)
    expect(await permissions(join(root, 'objects', hex.slice(0, 2), hex.slice(2)))).toBe(0o600)
  })

  it('is idempotent: identical bytes reuse the same object file', async () => {
    const first = await store.put(KIND, BINARY, REDACTED)
    const second = await store.put(KIND, BINARY, REDACTED)

    expect(second.ref).toBe(first.ref)
    expect(await objectFiles(join(root, 'objects'))).toHaveLength(1)
  })

  it('rejects an unknown kind rather than filing an unreachable object', async () => {
    await expect(store.put('activity-paylod', BINARY, REDACTED)).rejects.toThrow(/unknown object kind/)
    expect(await store.listRefs()).toEqual([])
  })
})

describe('createObjectStore.get', () => {
  it('round-trips arbitrary binary including 0x00 and 0xFF', async () => {
    const { ref } = await store.put(KIND, BINARY, REDACTED)

    expect(new Uint8Array(await store.get(ref))).toEqual(BINARY)
  })

  it('rejects an unknown ref with an error naming it', async () => {
    const unknown = `sha256:${'0'.repeat(64)}`

    await expect(store.get(unknown)).rejects.toThrow(unknown)
  })

  it('rejects on-disk corruption instead of returning wrong bytes', async () => {
    // A valid-looking sha256 name whose content hashes to something else: the
    // only way to notice is to recompute the digest on read.
    const hex = sha256Hex(new Uint8Array([1, 2, 3]))
    const ref = `sha256:${hex}`
    const directory = join(root, 'objects', hex.slice(0, 2))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, hex.slice(2)), 'not the bytes you hashed')

    await expect(store.get(ref)).rejects.toThrow(ref)
    await expect(store.get(ref)).rejects.toThrow(/corrupt|mismatch/i)
  })
})

describe('createObjectStore.has and stat', () => {
  it('reports false and undefined for an unknown ref', async () => {
    const unknown = `sha256:${'a'.repeat(64)}`

    expect(await store.has(unknown)).toBe(false)
    await expect(store.stat(unknown)).resolves.toBeUndefined()
  })

  it('reports metadata for a stored object', async () => {
    const { ref, sha256, byteSize } = await store.put(KIND, BINARY, REDACTED)

    expect(await store.has(ref)).toBe(true)
    expect(await store.stat(ref)).toEqual({ ref, sha256, byteSize })
  })
})

describe('createObjectStore.listRefs', () => {
  it('is empty before anything is written and lists what is stored', async () => {
    expect(await store.listRefs()).toEqual([])

    const { ref } = await store.put(KIND, BINARY, REDACTED)

    expect(await store.listRefs()).toEqual([ref])
  })

  it('ignores files that are not valid ref names', async () => {
    const { ref } = await store.put(KIND, BINARY, REDACTED)
    await writeFile(join(root, 'objects', 'README'), 'not a ref')

    expect(await store.listRefs()).toEqual([ref])
  })
})
