/** Fully resolved host configuration; every field is present and valid. */
export interface TurnscopeConfig {
    readonly enabled: boolean;
    readonly dataDir: string | undefined;
    readonly retentionDays: number;
    readonly retentionBytes: number;
    readonly maxOutputBytes: number;
    /**
     * The largest file whose bytes are copied into a checkpoint.
     *
     * Above it the file is still fingerprinted, so drift is still detectable, but
     * its contents are not stored and the checkpoint drops to `partial`. The
     * budget exists because a checkpoint is taken twice per turn on whatever the
     * user happens to have dirty, and a single stray build artifact should not
     * turn that into a multi-gigabyte copy.
     */
    readonly maxBlobBytes: number;
    readonly ignorePaths: readonly string[];
}
/** Documented defaults, used for absent input and for every invalid field. */
export declare const DEFAULT_CONFIG: TurnscopeConfig;
/**
 * Turn arbitrary loader-supplied configuration into a valid {@link TurnscopeConfig}.
 *
 * Total by construction: unknown input and invalid fields fall back to their
 * default individually, so one bad field never discards the valid ones.
 */
export declare function resolveConfig(input: unknown): TurnscopeConfig;
//# sourceMappingURL=config.d.ts.map