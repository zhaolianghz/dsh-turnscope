import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('returns documented defaults for absent input', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG.retentionDays).toBe(30)
    expect(DEFAULT_CONFIG.retentionBytes).toBe(104_857_600)
    expect(DEFAULT_CONFIG.maxOutputBytes).toBe(32_768)
    expect(DEFAULT_CONFIG.ignorePaths).toEqual([])
    expect(DEFAULT_CONFIG.enabled).toBe(true)
  })

  it('accepts well-formed partial input', () => {
    expect(resolveConfig({ retentionDays: 7, ignorePaths: ['secrets/**'] })).toMatchObject({
      retentionDays: 7,
      ignorePaths: ['secrets/**'],
      retentionBytes: 104_857_600,
    })
  })

  it('falls back to safe defaults instead of throwing on garbage', () => {
    for (const bad of [null, 42, 'nope', [], { retentionDays: -1 }, { retentionBytes: 'big' },
                       { ignorePaths: 'not-an-array' }, { dataDir: 123 }, { maxOutputBytes: Number.NaN }]) {
      expect(() => resolveConfig(bad)).not.toThrow()
      const resolved = resolveConfig(bad)
      expect(resolved.retentionDays).toBeGreaterThan(0)
      expect(resolved.retentionBytes).toBeGreaterThan(0)
      expect(resolved.maxOutputBytes).toBeGreaterThan(0)
      expect(Array.isArray(resolved.ignorePaths)).toBe(true)
    }
  })

  it('preserves a valid explicit dataDir and rejects a relative one', () => {
    expect(resolveConfig({ dataDir: '/tmp/turnscope-test' }).dataDir).toBe('/tmp/turnscope-test')
    expect(resolveConfig({ dataDir: 'relative/path' }).dataDir).toBeUndefined()
  })
})
