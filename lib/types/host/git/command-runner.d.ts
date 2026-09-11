/**
 * The result of one external command.
 *
 * Deliberately flat rather than a rejected promise for a non-zero exit: "the
 * command ran and said no" is a normal answer (`git status` on a clean tree
 * still exits 0, but `git rev-parse HEAD` in a fresh repository exits 128), and
 * collapsing it into a rejection would make every caller wrap the same
 * try/catch. Only *failure to start the process at all* rejects — see
 * {@link CommandRunner.run}.
 *
 * `exitCode` is `undefined` exactly when {@link incomplete} is set: a process
 * killed for exceeding its output budget or its time limit never produced one.
 */
export interface CommandResult {
    readonly exitCode: number | undefined;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    /** Why the process was killed early; absent when it exited on its own. */
    readonly incomplete?: 'output-limit' | 'timeout';
}
/** Where and how long one command may run. */
export interface RunOptions {
    readonly cwd: string;
    /** Hard ceiling on captured stdout+stderr; the process is killed past it. */
    readonly maxOutputBytes?: number;
    /** Wall-clock ceiling; the process is killed past it. */
    readonly timeoutMs?: number;
}
/**
 * Runs one external command from an argv array.
 *
 * The interface takes `readonly string[]` and never a command line, which is
 * the whole defence against shell injection: there is no string to interpolate
 * a path into, so an argument containing `; touch /tmp/pwned` is one argument
 * that a program will reject, not two commands that a shell will run.
 */
export interface CommandRunner {
    /**
     * Run `argv[0]` with the rest as literal arguments.
     *
     * Resolves for any outcome in which the process ran, including a non-zero
     * exit, an output-limit kill and a timeout kill. Rejects only when the
     * process could not be started (a missing binary, a bad cwd) — an environment
     * problem the caller reports rather than interprets.
     */
    run(argv: readonly string[], options: RunOptions): Promise<CommandResult>;
}
/** 8 MiB: large enough for a pathological `git status`, small enough to bound. */
export declare const DEFAULT_MAX_OUTPUT_BYTES: number;
/** 30 s: generous for a cold large repository, still bounded. */
export declare const DEFAULT_TIMEOUT_MS = 30000;
/**
 * The production runner, over `execFile` with `shell: false`.
 *
 * `shell: false` is not a default to be relied on: it is stated here so the one
 * place a process is created is also the one place the argument-versus-command
 * distinction is visible.
 */
export declare function createExecFileRunner(): CommandRunner;
//# sourceMappingURL=command-runner.d.ts.map