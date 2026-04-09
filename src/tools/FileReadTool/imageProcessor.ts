// Pure-JS image processing via jimp, exposed through a sharp-compatible API.
// This replaces the native `image-processor-napi` (private Anthropic package)
// and the `sharp` npm package (which requires native libvips bindings).
// The sharp-style chaining interface (e.g. sharp(buf).resize().jpeg().toBuffer())
// is preserved so that callers like imageResizer.ts don't need to change.

import type { Buffer } from 'buffer'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

/**
 * Get image processor using jimp (pure JS, no native deps).
 * Works reliably in compiled Bun binaries without native addon issues.
 */
export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  const jimpSharp = await createJimpSharpAdapter()
  imageProcessorModule = { default: jimpSharp }
  return jimpSharp
}

/**
 * Get image creator for generating new images from scratch.
 * Uses jimp to create blank images with a solid background.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  const { createJimp } = await import('@jimp/core')
  const { default: png } = await import('@jimp/js-png')

  const Jimp = createJimp({ formats: [png] })

  const creator: SharpCreator = (options: SharpCreatorOptions) => {
    const { width, height, background } = options.create
    const image = new Jimp({ width, height, color: ((background.r << 24) | (background.g << 16) | (background.b << 8) | 0xff) >>> 0 })

    const instance: SharpInstance = {
      async metadata() {
        return { width, height, format: 'png' }
      },
      resize() { return instance },
      jpeg() { return instance },
      png() { return instance },
      webp() { return instance },
      async toBuffer() {
        return Buffer.from(await image.getBuffer('image/png'))
      },
    }
    return instance
  }

  imageCreatorModule = { default: creator }
  return creator
}

/**
 * Create a sharp-compatible adapter backed by jimp (pure JS, no native deps).
 * Uses @jimp/core with only the plugins we need, avoiding @jimp/plugin-print
 * which has a broken dependency (simple-xml-to-json).
 */
async function createJimpSharpAdapter(): Promise<SharpFunction> {
  const { createJimp } = await import('@jimp/core')
  const { default: jpeg } = await import('@jimp/js-jpeg')
  const { default: png } = await import('@jimp/js-png')
  const { default: bmp } = await import('@jimp/js-bmp')
  const { methods: resizeMethods } = await import('@jimp/plugin-resize')

  const Jimp = createJimp({ formats: [jpeg, png, bmp], plugins: [resizeMethods] })

  return function jimpSharp(input: Buffer): SharpInstance {
    let pendingResize: { width: number; height: number; options?: { fit?: string; withoutEnlargement?: boolean } } | null = null
    let pendingFormat: { type: 'jpeg'; quality: number } | { type: 'png'; options?: { compressionLevel?: number } } | null = null

    const instance: SharpInstance = {
      async metadata() {
        const image = await Jimp.read(input)
        const mime = image.mime
        let format = 'unknown'
        if (mime === 'image/png') format = 'png'
        else if (mime === 'image/jpeg') format = 'jpeg'
        else if (mime === 'image/bmp' || mime === 'image/x-ms-bmp') format = 'bmp'
        return { width: image.width, height: image.height, format }
      },
      resize(width: number, height: number, options?: { fit?: string; withoutEnlargement?: boolean }) {
        pendingResize = { width, height, options }
        return instance
      },
      jpeg(options?: { quality?: number }) {
        pendingFormat = { type: 'jpeg', quality: options?.quality ?? 80 }
        return instance
      },
      png(options?: { compressionLevel?: number }) {
        pendingFormat = { type: 'png', options }
        return instance
      },
      webp() {
        // jimp core doesn't support webp output; fall back to png
        pendingFormat = { type: 'png' }
        return instance
      },
      async toBuffer() {
        const image = await Jimp.read(input)

        if (pendingResize) {
          const { width, height, options } = pendingResize
          let targetW = width
          let targetH = height
          if (options?.withoutEnlargement) {
            targetW = Math.min(width, image.width)
            targetH = Math.min(height, image.height)
          }
          if (options?.fit === 'inside') {
            const ratio = Math.min(targetW / image.width, targetH / image.height)
            targetW = Math.round(image.width * ratio)
            targetH = Math.round(image.height * ratio)
          }
          image.resize({ w: targetW, h: targetH })
        }

        if (pendingFormat?.type === 'jpeg') {
          return Buffer.from(await image.getBuffer('image/jpeg', { quality: pendingFormat.quality }))
        }
        return Buffer.from(await image.getBuffer('image/png'))
      },
    }
    return instance
  }
}
