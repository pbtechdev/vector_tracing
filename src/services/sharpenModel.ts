import type { InferenceSession } from 'onnxruntime-web/wasm'
import type { InferFn } from './inkSharpener'

const MODEL_URL = `${import.meta.env.BASE_URL}models/ink-sharpener-x4.onnx`

let session: Promise<{ session: InferenceSession; Tensor: typeof import('onnxruntime-web/wasm').Tensor }> | null = null

/**
 * Loads the bundled ONNX model once per worker. Everything is served by this app: the model file
 * and the WebAssembly runtime are local assets, and images never leave the device.
 */
async function load() {
  const ort = await import('onnxruntime-web/wasm')
  const wasm = (await import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url')).default
  ort.env.wasm.wasmPaths = { wasm }
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  ort.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`The sharpening model could not be loaded (${res.status}).`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  return { session: s, Tensor: ort.Tensor }
}

export async function getSharpenModel(): Promise<InferFn> {
  if (!session) {
    session = load()
    session.catch(() => {
      session = null
    })
  }
  const { session: s, Tensor } = await session
  return async (input, width, height) => {
    const out = await s.run({ image: new Tensor('float32', input, [1, 1, height, width]) })
    return out.ink.data as Float32Array
  }
}
