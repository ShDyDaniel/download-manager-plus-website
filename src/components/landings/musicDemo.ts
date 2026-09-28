/**
 * Static data for the /music demo (a song splitting into stems, then the
 * mixer). Everything is computed once, deterministically, so the markup is
 * stable between renders.
 *
 * Each stem gets its own believable shape (vocals come in phrases, drums hit on
 * the beat, bass holds, the rest swells), and the full mix is built from the
 * four of them — so the "before" waveform really is the sum of the "after".
 * Waveforms are drawn like the app's mixer: one thin bar per peak, centred.
 */

/** Small seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Number of bars across a lane (the SVG viewBox is `0 0 BARS 40`). */
export const BARS = 132

/** Song sections, as fractions of the length: intro · verse · chorus · verse · chorus. */
const loud = (x: number) => (x < 0.12 ? 0.55 : x < 0.4 ? 0.8 : x < 0.6 ? 1 : x < 0.8 ? 0.82 : 1)

function vocals(): number[] {
  const r = rng(3)
  const out: number[] = []
  let on = false
  let left = 0
  for (let i = 0; i < BARS; i++) {
    const x = i / BARS
    if (left <= 0) {
      on = !on
      left = on ? 6 + Math.floor(r() * 7) : 1 + Math.floor(r() * 3)
    }
    left--
    if (x < 0.13) out.push(0.02) // no vocals in the intro
    else out.push(on ? Math.min(0.92, loud(x) * (0.42 + 0.4 * r())) : 0.03 + 0.04 * r())
  }
  return out
}

function drums(): number[] {
  const r = rng(5)
  return Array.from({ length: BARS }, (_, i) => {
    const x = i / BARS
    const g = x < 0.06 ? 0.15 : loud(x)
    const hit = i % 4 === 0 ? 0.88 : i % 4 === 2 ? 0.7 : 0.26 + 0.12 * r()
    return Math.min(0.95, hit * g * (0.9 + 0.1 * r()))
  })
}

function bass(): number[] {
  const r = rng(9)
  return Array.from({ length: BARS }, (_, i) => {
    const x = i / BARS
    if (x < 0.08) return 0.03
    return Math.min(0.9, loud(x) * (0.5 + 0.12 * Math.sin(i / 3.1) + 0.08 * r()))
  })
}

function other(): number[] {
  const r = rng(13)
  return Array.from({ length: BARS }, (_, i) => {
    const x = i / BARS
    return Math.min(0.9, (0.3 + 0.28 * loud(x)) * (0.72 + 0.2 * Math.sin(i / 7.3) + 0.14 * r()))
  })
}

/** Bar path (viewBox 0 0 BARS 40): one thin centred bar per peak, like the app's Waveform. */
function barsPath(peaks: number[]): string {
  return peaks
    .map((p, i) => {
      const h = Math.max(1, p * 38)
      return `M${i + 0.1} ${((40 - h) / 2).toFixed(2)}h0.72v${h.toFixed(2)}h-0.72z`
    })
    .join('')
}

const V = vocals()
const D = drums()
const B = bass()
const O = other()
const MIX = (() => {
  const raw = V.map((_, i) => Math.sqrt(V[i] ** 2 + D[i] ** 2 + B[i] ** 2 + O[i] ** 2))
  const max = Math.max(...raw)
  return raw.map((v) => (v / max) * 0.94)
})()

export type StemKey = 'v' | 'd' | 'b' | 'o'

/** The four lanes of the 4-stem split, in the app's order ("שאר" always last). */
export const STEMS: { key: StemKey; label: string; wave: string }[] = [
  { key: 'v', label: 'שירה', wave: barsPath(V) },
  { key: 'd', label: 'תופים', wave: barsPath(D) },
  { key: 'b', label: 'בס', wave: barsPath(B) },
  { key: 'o', label: 'שאר', wave: barsPath(O) },
]

/** The original song, before the split. */
export const MIX_WAVE = barsPath(MIX)

/** The app's "separating" equaliser: 28 bars in two copper tones, each on its own rhythm. */
export const EQ = Array.from({ length: 28 }, (_, i) => ({
  d: (0.7 + (i % 5) * 0.13).toFixed(2),
  o: (i * 0.045).toFixed(2),
}))
