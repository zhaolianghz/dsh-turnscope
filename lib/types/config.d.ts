/** Fully resolved host configuration; every field is present and valid. */
export interface TurnscopeConfig {
    readonly enabled: boolean;
    readonly dataDir: string | undefined;
    readonly retentionDays: number;
    readonly retentionBytes: number;
    readonly maxOutputBytes: number;
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