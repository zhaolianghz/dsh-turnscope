/** Owner-only on everything Turnscope creates. */
export declare const DIRECTORY_MODE = 448;
export declare const FILE_MODE = 384;
/** Marks a partially written file, so retention and debugging can spot one. */
export declare const TEMP_SUFFIX = ".tmp";
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
export declare function writeFileAtomic(targetPath: string, bytes: Uint8Array): Promise<void>;
//# sourceMappingURL=atomic.d.ts.map