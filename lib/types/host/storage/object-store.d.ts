/**
 * The object kinds this slice may store.
 *
 * Frozen, and the only source of valid values: a typo'd kind would file an
 * object where nothing later looks for it, so {@link ObjectStore.put} rejects
 * anything outside this set. A later Restore/Fork plan adds `diff` and
 * `snapshot` by extending this one object.
 */
export declare const OBJECT_KINDS: Readonly<{
    /** Redacted, truncated tool and command output. Written by Task 6. */
    readonly ACTIVITY_PAYLOAD: "activity-payload";
}>;
/** Content address of one stored object. */
export interface ObjectRef {
    /** `sha256:<64 lowercase hex>`, the key an index row stores. */
    readonly ref: string;
    /** The bare hex digest, for callers that store it in a column of its own. */
    readonly sha256: string;
    /** Size of the stored bytes. */
    readonly byteSize: number;
}
export interface ObjectStore {
    /**
     * Store `bytes` and return their content address. Idempotent: identical bytes
     * land on one file, and an object that already exists is not rewritten.
     */
    put(kind: string, bytes: Uint8Array): Promise<ObjectRef>;
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