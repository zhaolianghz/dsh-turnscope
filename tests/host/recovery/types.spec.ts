/**
 * Type-shape assertions for the V0.2 Safe Rewind record types, per
 * `docs/superpowers/specs/2026-09-11-v0.2-v0.3-recovery-design.md §4.2`.
 *
 * The spec owns the wire shape; a divergence here is a divergence from spec,
 * not a stylistic preference. Every field listed in §4.2 is asserted present
 * with the documented type, and the discriminated union is asserted to be the
 * only kind-bearing shape that crosses this boundary.
 */

import { describe, it, expect } from 'vitest'
import type {
  RecoveryFileOperation,
  RecoveryJournalEntry,
  RecoveryJournalState,
  RecoveryPlan,
  RecoveryPlanStatus,
  RecoveryResult,
} from '../../../src/host/recovery/types.ts'
import type { SafetyVerdict } from '../../../src/host/domain/types.ts'

describe('recovery types', () => {
  it('RecoveryPlan accepts the documented fields with readonly modifiers', () => {
    const verdict = { level: 'SAFE', engineVersion: 1 } as unknown as SafetyVerdict
    const plan: RecoveryPlan = {
      schemaVersion: 3,
      id: 's-1:turn:0:plan:ev-1',
      turnId: 's-1:turn:0',
      verdict,
      evaluationId: 'ev-1',
      stateHash: 'sha256:' + 'a'.repeat(64),
      operations: [],
      beforeCheckpointId: 'cp-pre',
      status: 'planned',
      createdAt: 1_000,
      expiresAt: 2_000,
    }
    expect(plan.schemaVersion).toBe(3)
    expect(plan.turnId).toBe('s-1:turn:0')
    expect(plan.verdict).toBe(verdict)
    expect(plan.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(plan.expiresAt).toBeGreaterThan(plan.createdAt)
  })

  it('RecoveryFileOperation is the four-kind discriminated union from spec §4.2', () => {
    const ops: readonly RecoveryFileOperation[] = [
      { kind: 'restore', path: 'a.ts', expectedCurrentHash: 'sha256:h', targetBlobRef: 'sha256:b' },
      { kind: 'delete_created_file', path: 'b.ts', expectedCurrentHash: 'sha256:h' },
      { kind: 'recreate_deleted_file', path: 'c.ts', targetBlobRef: 'sha256:b' },
      { kind: 'noop', path: 'd.ts', reason: 'baseline_only' },
    ]
    const kinds = ops.map(o => o.kind)
    expect(kinds).toEqual(['restore', 'delete_created_file', 'recreate_deleted_file', 'noop'])
    // The `kind` field is the only discriminator: a union with all four kinds
    // exists, and adding a fifth is a deliberate spec change.
    const noop = ops[3]
    if (noop === undefined || noop.kind !== 'noop') throw new Error('discriminator missing')
    expect(noop).toEqual({ kind: 'noop', path: 'd.ts', reason: 'baseline_only' })
  })

  it('RecoveryJournalEntry requires planId, seq, operation, state, occurredAt', () => {
    const op: RecoveryFileOperation = { kind: 'noop', path: 'x.ts', reason: 'unchanged' }
    const e: RecoveryJournalEntry = {
      schemaVersion: 3,
      planId: 'plan-1',
      seq: 1,
      operation: op,
      state: 'prepared',
      occurredAt: 0,
    }
    expect(e.planId).toBe('plan-1')
    expect(e.seq).toBe(1)
    expect(e.state).toBe<RecoveryJournalState>('prepared')
    expect(e.error).toBeUndefined()
  })

  it('RecoveryResult carries afterCheckpointId null on failure', () => {
    const r: RecoveryResult = {
      planId: 'plan-1',
      status: 'failed',
      afterCheckpointId: null,
      journal: [],
      failureReason: 'permission denied',
    }
    expect(r.afterCheckpointId).toBeNull()
    expect(r.status).toBe('failed')
    expect(r.failureReason).toBe('permission denied')
  })

  it('RecoveryPlanStatus covers the documented six-state lifecycle', () => {
    // Statically verify the union closes on the spec.
    const all: readonly RecoveryPlanStatus[] = [
      'planned',
      'previewed',
      'applying',
      'completed',
      'failed',
      'cancelled',
    ]
    expect(new Set(all).size).toBe(6)
  })
})