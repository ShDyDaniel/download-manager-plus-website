/**
 * Static data for the /sync demo window (six clips snapping onto one timeline).
 * Everything is computed once, deterministically, so the markup is stable.
 *
 * All audio clips show their slice of ONE "recording" (the master wave) at
 * their synced position, so once the clips snap into place their peaks line
 * up across lanes — the same idea as the prototype's generator.
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

function masterWave(seed = 11, n = 600): number[] {
  const r = rng(seed)
  const u = (a: number, b: number) => a + (b - a) * r()
  let env = 0.45
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    env = Math.min(0.9, Math.max(0.12, env + u(-0.09, 0.09)))
    let v = env * u(0.55, 1)
    if (r() < 0.05) v = Math.min(0.97, v + u(0.25, 0.45)) // claps, laughs, hits
    if (r() < 0.06) v *= 0.25 // pauses
    out.push(v)
  }
  return out
}

const MASTER = masterWave()

/** Polygon points (viewBox 0 0 200 20) of a clip that starts at `start`% and spans `width`%. */
function wavePoints(start: number, width: number, gain: number): string {
  const n = Math.max(24, Math.floor(width * 2.4))
  const hs: number[] = []
  for (let k = 0; k < n; k++) {
    const x = start + (width * k) / (n - 1)
    const idx = Math.min(MASTER.length - 1, Math.floor((x / 100) * (MASTER.length - 1)))
    hs.push(Math.min(0.97, MASTER[idx] * gain))
  }
  const top = hs.map((v, i) => `${((i * 200) / (n - 1)).toFixed(1)},${(10 - v * 9.5).toFixed(2)}`)
  const bot = hs
    .map((v, i) => `${((i * 200) / (n - 1)).toFixed(1)},${(10 + v * 9.5).toFixed(2)}`)
    .reverse()
  return [...top, ...bot].join(' ')
}

export type SyncClip = {
  file: string
  /** left edge before / after sync, in % of the timeline */
  a: number
  b: number
  width: number
  kind: 'v' | 'a'
  /** audio clips only */
  wave?: string
}

export type SyncGroup = { name: string; kind: 'video' | 'audio'; clips: SyncClip[] }

function clip(file: string, a: number, b: number, width: number, kind: 'v' | 'a'): SyncClip {
  return {
    file,
    a,
    b,
    width,
    kind,
    wave: kind === 'a' ? wavePoints(b, width, file.startsWith('CAM') ? 0.7 : 1) : undefined,
  }
}

export const SYNC_GROUPS: SyncGroup[] = [
  {
    name: 'וידאו',
    kind: 'video',
    clips: [clip('CAM_A_0125.MP4', 2, 5, 46, 'v'), clip('CAM_B_0048.MP4', 2, 43, 40, 'v')],
  },
  {
    name: 'סאונד פנימי',
    kind: 'audio',
    clips: [clip('CAM_A_0125', 2, 5, 46, 'a'), clip('CAM_B_0048', 2, 43, 40, 'a')],
  },
  {
    name: 'סאונד חיצוני',
    kind: 'audio',
    clips: [clip('DJI_03_172445.WAV', 2, 2, 60, 'a'), clip('DJI_02_175539.WAV', 2, 36, 44, 'a')],
  },
]

export const RULER: [number, string][] = [
  [0, '0:00'],
  [25, '15:00'],
  [50, '30:00'],
  [75, '45:00'],
  [100, '1:00:00'],
]

/**
 * Equaliser: 40 bars, each pulsing on its own rhythm (d = half-period,
 * o = phase offset); they turn copper right→left as the percentage rises
 * (t = when bar k lights, over the 3s "analysing" phase).
 */
export const EQ_BARS = (() => {
  const r = rng(7)
  return Array.from({ length: 40 }, (_, k) => ({
    d: (0.35 + 0.4 * r()).toFixed(2),
    o: (-1.5 * r()).toFixed(2),
    t: (((39 - k) / 40) * 3).toFixed(2),
  }))
})()

/** The home page's sync sketch wave, reused in step 2. */
export const SKETCH_WAVE =
  'M0 10 L6 10 L8 4 L10 16 L12 7 L14 13 L16 10 L30 10 L32 2 L34 18 L36 5 L38 15 L40 10 L56 10 L58 6 L60 14 L62 8 L64 12 L66 10 L90 10 L92 3 L94 17 L96 6 L98 14 L100 10 L120 10'
