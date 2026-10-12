import type { Bitmap } from './imagePreprocessing'

/**
 * Zhang–Suen thinning on a grid with a one-pixel background border (`pw` = padded width).
 * Modifies `img` in place.
 */
export function thinInPlace(img: Uint8Array, pw: number, ph: number): void {
  let candidates: Int32Array
  {
    const list: number[] = []
    for (let y = 1; y < ph - 1; y++) for (let x = 1; x < pw - 1; x++) if (img[y * pw + x]) list.push(y * pw + x)
    candidates = Int32Array.from(list)
  }
  const del = new Int32Array(candidates.length)
  let changed = true
  while (changed) {
    changed = false
    for (let step = 0; step < 2; step++) {
      let nd = 0
      for (let c = 0; c < candidates.length; c++) {
        const i = candidates[c]
        if (!img[i]) continue
        const p2 = img[i - pw]
        const p3 = img[i - pw + 1]
        const p4 = img[i + 1]
        const p5 = img[i + pw + 1]
        const p6 = img[i + pw]
        const p7 = img[i + pw - 1]
        const p8 = img[i - 1]
        const p9 = img[i - pw - 1]
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
        if (b < 2 || b > 6) continue
        const a =
          (p2 === 0 && p3 === 1 ? 1 : 0) +
          (p3 === 0 && p4 === 1 ? 1 : 0) +
          (p4 === 0 && p5 === 1 ? 1 : 0) +
          (p5 === 0 && p6 === 1 ? 1 : 0) +
          (p6 === 0 && p7 === 1 ? 1 : 0) +
          (p7 === 0 && p8 === 1 ? 1 : 0) +
          (p8 === 0 && p9 === 1 ? 1 : 0) +
          (p9 === 0 && p2 === 1 ? 1 : 0)
        if (a !== 1) continue
        if (step === 0) {
          if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue
        } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) {
          continue
        }
        del[nd++] = i
      }
      if (nd > 0) {
        changed = true
        for (let k = 0; k < nd; k++) img[del[k]] = 0
      }
    }
    let live = 0
    for (let c = 0; c < candidates.length; c++) if (img[candidates[c]]) candidates[live++] = candidates[c]
    candidates = candidates.subarray(0, live)
  }
}

/** Yokoi 8-connectivity number: 1 means removing the pixel keeps its neighbours connected. */
function yokoi8(img: Uint8Array, i: number, pw: number): number {
  const e = 1 - img[i + 1]
  const ne = 1 - img[i - pw + 1]
  const n = 1 - img[i - pw]
  const nw = 1 - img[i - pw - 1]
  const w = 1 - img[i - 1]
  const sw = 1 - img[i + pw - 1]
  const s = 1 - img[i + pw]
  const se = 1 - img[i + pw + 1]
  return e - e * ne * n + (n - n * nw * w) + (w - w * sw * s) + (s - s * se * e)
}

/**
 * Removes "staircase" pixels Zhang–Suen leaves behind (an L of three pixels where the corner is
 * redundant), giving a strictly 8-connected one-pixel skeleton in which line pixels have
 * exactly two neighbours. Works on a padded grid, in place.
 */
export function removeStaircases(img: Uint8Array, pw: number, ph: number): void {
  for (let y = 1; y < ph - 1; y++) {
    for (let x = 1; x < pw - 1; x++) {
      const i = y * pw + x
      if (!img[i]) continue
      const vertical = img[i - pw] || img[i + pw]
      const horizontal = img[i - 1] || img[i + 1]
      if (!vertical || !horizontal) continue
      const count =
        img[i - pw] + img[i - pw + 1] + img[i + 1] + img[i + pw + 1] + img[i + pw] + img[i + pw - 1] + img[i - 1] + img[i - pw - 1]
      if (count < 2) continue
      if (yokoi8(img, i, pw) === 1) img[i] = 0
    }
  }
}

/** Zhang–Suen thinning of an unpadded bitmap. Returns a one-pixel-wide, 8-connected skeleton. */
export function zhangSuenThin(bitmap: Bitmap): Bitmap {
  const { width: w, height: h } = bitmap
  const pw = w + 2
  const ph = h + 2
  const img = new Uint8Array(pw * ph)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[(y + 1) * pw + x + 1] = bitmap.data[y * w + x]
  thinInPlace(img, pw, ph)
  removeStaircases(img, pw, ph)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = img[(y + 1) * pw + x + 1]
  return { data: out, width: w, height: h }
}
