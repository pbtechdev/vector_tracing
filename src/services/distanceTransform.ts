const INF = 1e20

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
 * For every foreground pixel (non-zero), returns the distance to the nearest background pixel centre;
 * background pixels get 0. Pixels outside the grid are not considered background, so pad the input
 * if strokes touching the border should be measured against it.
 */
export function distanceTransform(data: Uint8Array, width: number, height: number): Float32Array {
  const n = width * height
  const grid = new Float64Array(n)
  for (let i = 0; i < n; i++) grid[i] = data[i] ? INF : 0
  const m = Math.max(width, height)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]
    edt1d(f, height, d, v, z)
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]
  }
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) f[x] = grid[row + x]
    edt1d(f, width, d, v, z)
    for (let x = 0; x < width; x++) grid[row + x] = d[x]
  }

  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = grid[i] >= INF / 2 ? Number.POSITIVE_INFINITY : Math.sqrt(grid[i])
  return out
}
