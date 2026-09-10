/**
 * The object kinds this store may hold.
 *
 * Frozen, and the only source of valid values: a typo'd kind would file an
 * object where nothing later looks for it, so {@link ObjectStore.put} rejects
 * anything outside this set.
 *
 * The two kinds exist because they are **different data**, not different sizes
 * or lifetimes — `docs/ARCHITECTURE.md §12.3` and its decision 6 draw the line:
 *
 * - `ACTIVITY_PAYLOAD` is diagnostic: command and tool output shown to a user.
 *   Secrets are masked before it is stored, and masking is lossy on purpose.
 * - `RECOVERY_BLOB` is a file's exact bytes as the workspace held them. It is
 *   **not** redacted, because a redacted snapshot cannot restore anything — the
 *   substitution would be written back over the user's file. Its protection is
 *   different in kind: it never leaves the machine, it is written `0o600` inside
 *   the plugin-private root, and retention bounds it.
 *
 * That reversal is the whole reason {@link ObjectStore.put} takes an explicit
 * {@link RedactionPolicy} rather than inferring one. A caller has to say which
 * of the two it is storing, and the store refuses a pair that disagrees.
 */
export declare const OBJECT_KINDS: Readonly<{
    /** Redacted, truncated tool and command output. */
    readonly ACTIVITY_PAYLOAD: "activity-payload";
    /** A file's exact bytes, captured so a recovery can put them back. */
    readonly RECOVERY_BLOB: "recovery-blob";
}>;
export type ObjectKind = (typeof OBJECT_KINDS)[keyof typeof OBJECT_KINDS];
/**
 * Whether the bytes handed to {@link ObjectStore.put} were redacted first.
 *
 * `applied` means the caller ran the redactor; `raw-bytes` means the bytes are
 * the workspace's own and must stay byte-identical. There is deliberately no
 * default: a default would let a new call site inherit whichever policy happened
 * to be convenient, which is precisely the mistake this parameter exists to
 * make impossible.
 */
export type RedactionPolicy = 'applied' | 'raw-bytes';
/** Content address of one stored object. */
export interface ObjectRef {
    /** `sha256:<64 lowercase hex>`, the key an index row stores. */
    readonly ref: string;
    /** The bare hex digest, for callers that store it in a column of its own. */
    readonly sha256: string;
    /** Size of the stored bytes. */
    readonly byteSize: number;
}
/** How one object is being stored. */
export interface PutOptions {
    /**
     * Which side of the redaction boundary these bytes are on.
     *
     * Required, and checked against the kind: see {@link OBJECT_KINDS}.
     */
    readonly redaction: RedactionPolicy;
}
export interface ObjectStore {
    /**
     * Store `bytes` and return their content address. Idempotent: identical bytes
     * land on one file, and an object that already exists is not rewritten.
     *
     * `options.redaction` must agree with `kind`; a pair that disagrees rejects.
     */
    put(kind: string, bytes: Uint8Array, options: PutOptions): Promise<ObjectRef>;
    /** Read the object, verifying it still hashes to its own name. */
    get(ref: string): Promise<Uint8Array>;
    /** Whether an object exists, without reading it. */
    has(ref: string): Promise<boolean>;
    /** Metadata for an existing object, or `undefined` when there is none. */
    stat(ref: string): Promise<ObjectRef | undefined>;
    /** Every stored ref, sorted, for retention walks. */
    listRefs(): Promise<readonly string[]>;
}
/**
 * Open the content-addressed object store rooted at `<root>/objects`.
 *
 * Objects are addressed by the SHA-256 of their bytes, so the name *is* the
 * integrity check: {@link ObjectStore.get} recomputes the digest rather than
 * trusting the filename, which turns silent on-disk corruption (a truncated or
 * scribbled file) into a rejection instead of wrong bytes flowing into a report.
 */
export declare function createObjectStore(root: string): ObjectStore;
//# sourceMappingURL=object-store.d.ts.map