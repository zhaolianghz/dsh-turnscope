/**
 * Tests for the V0.2 runner path layout
 * (`src/host/recovery/runner/paths.ts`).
 *
 * The path module is small but the rules it enforces are the contract that
 * keeps the recovery state from fragmenting across working directories: a
 * relative `homeDir` or `dataDir` is a caller bug, not a fallback. The cases
 * below are the ones that have to hold for the rest of the runner to trust
 * its own writes.
 */

import { describe, expect, it } from 'vitest'

import {
  resolveDryRunRoot,
  resolveJournalPath,
  resolveRecoveryDataRoot,
  resolveRecoveryRoot,
} from '../../../../src/host/recovery/runner/paths.ts'

describe('recovery path layout', () => {
  it('prefers an explicit absolute configDataDir over env or home', () => {
    const r = resolveRecoveryDataRoot({ DSH_HOME: '/env/dsh' }, '/home/me', '/var/lib/ts')
    expect(r).toBe('/var/lib/ts')
  })

  it('prefers DSH_HOME over homeDir when configDataDir is absent', () => {
    const r = resolveRecoveryDataRoot({ DSH_HOME: '/env/dsh' }, '/home/me', undefined)
    expect(r).toBe('/env/dsh/turnscope')
  })

  it('falls back to <homeDir>/.dsh/turnscope when both above are absent', () => {
    const r = resolveRecoveryDataRoot({}, '/home/me', undefined)
    expect(r).toBe('/home/me/.dsh/turnscope')
  })

  it('ignores relative configDataDir (does not let cwd leak in)', () => {
    const r = resolveRecoveryDataRoot({}, '/home/me', 'relative/path')
    expect(r).toBe('/home/me/.dsh/turnscope')
  })

  it('ignores empty / unset DSH_HOME', () => {
    const r = resolveRecoveryDataRoot({ DSH_HOME: '' }, '/home/me', undefined)
    expect(r).toBe('/home/me/.dsh/turnscope')
  })

  it('throws on a relative homeDir', () => {
    expect(() => resolveRecoveryDataRoot({}, 'rel', undefined)).toThrow(/absolute/)
  })

  it('lays the recovery root under the data root', () => {
    expect(resolveRecoveryRoot('/var/lib/ts')).toBe('/var/lib/ts/recovery')
  })

  it('lays the dry-run root under the recovery root, with planId as the leaf', () => {
    expect(resolveDryRunRoot('/var/lib/ts/recovery', 't1:plan:e1')).toBe(
      '/var/lib/ts/recovery/dryrun/t1:plan:e1',
    )
  })

  it('lays the journal file under the recovery root, with .jsonl extension', () => {
    expect(resolveJournalPath('/var/lib/ts/recovery', 't1:plan:e1')).toBe(
      '/var/lib/ts/recovery/journal/t1:plan:e1.jsonl',
    )
  })

  it('refuses an empty planId', () => {
    expect(() => resolveDryRunRoot('/var/lib/ts/recovery', '')).toThrow()
    expect(() => resolveJournalPath('/var/lib/ts/recovery', '')).toThrow()
  })
})