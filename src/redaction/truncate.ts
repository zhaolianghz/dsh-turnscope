import { Buffer } from 'node:buffer'

/** Appended to the text whenever bytes were dropped. */
export const TRUNCATION_MARKER = '…[truncated]'

const MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')

/** Outcome of one truncation. */
export interface TruncateResult {
  /** At most `maxBytes` bytes of UTF-8, never ending mid-codepoint. */
  readonly text: string
  /** True when bytes were dropped, which is when the marker is appended. */
  readonly truncated: boolean
  /** Size of the input in bytes, before truncation. */
  readonly originalBytes: number
}

/** Highest UTF-8 continuation byte, i.e. a byte of the shape `0b10xxxxxx`. */
const CONTINUATION_MASK = 0b1100_0000
const CONTINUATION_BITS = 0b1000_0000

/**
 * Length of the longest prefix of `buffer` that is at most `limit` bytes and
 * does not end inside a codepoint: walk back at most three bytes — the most a
 * single UTF-8 codepoint can span beyond its lead byte.
 */
const prefixLength = (buffer: Buffer, limit: number): number => {
  let cut = Math.min(limit, buffer.byteLength)
  for (let walked = 0; walked < 3 && cut > 0; walked += 1) {
    const byte = buffer[cut]
    if (byte === undefined || (byte & CONTINUATION_MASK) !== CONTINUATION_BITS) break
    cut -= 1
  }
  return cut
}

/**
 * Cut `input` down to at most `maxBytes` bytes of UTF-8.
 *
 * Pure, synchronous and total, like the redactor: it runs in the same write
 * path, so it must not throw and must not emit broken encoding. Byte slicing
 * can land inside a multi-byte codepoint, so the cut walks back to the nearest
 * boundary and the dropped tail is reported by the appended marker rather than
 * surviving as a replacement character. The limit counts bytes, not characters,
 * and it covers the whole result including the marker.
 */
export function truncateBytes(input: string, maxBytes: number): TruncateResult {
  const buffer = Buffer.from(input, 'utf8')
  const originalBytes = buffer.byteLength
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : originalBytes
  if (originalBytes <= limit) {
    return Object.freeze({ text: input, truncated: false, originalBytes })
  }
  // The marker is part of the budget, so the stored value never exceeds the
  // configured cap. When the cap cannot even hold the marker, the truncation is
  // still reported through `truncated`, and only the raw prefix is returned.
  const budget = limit - MARKER_BYTES
  const body = buffer.toString('utf8', 0, prefixLength(buffer, Math.max(0, budget)))
  return Object.freeze({
    text: budget > 0 ? body + TRUNCATION_MARKER : body,
    truncated: true,
    originalBytes,
  })
}
