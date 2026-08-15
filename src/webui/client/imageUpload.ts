/**
 * Turns a picked or pasted file into something small enough to send.
 *
 * A phone photo is several megabytes and the uplink is usually a tunnel, so the
 * browser resizes and re-encodes before anything leaves the device.
 *
 * The budget below is stated here rather than imported from the protocol
 * module, which would pull zod into the browser bundle for one number. It must
 * stay under `MAX_SUBMIT_IMAGE_BASE64`.
 */

/** Above this edge length the API gains nothing. */
const MAX_EDGE = 1568

/** Base64 characters. Leaves room under the protocol cap for the JSON around it. */
const TARGET_BASE64 = 900_000

const JPEG_QUALITIES = [0.8, 0.65, 0.5, 0.35]

export type PendingImage = {
  /** Distinguishes two attachments with the same name. */
  id: string
  name: string
  mediaType: 'image/png' | 'image/jpeg'
  data: string
  /** Object URL for the thumbnail. The composer revokes it. */
  previewUrl: string
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // btoa takes a string, and spreading the whole array overflows the argument
  // limit on anything but a small image.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Rejects with a message worth showing when the browser cannot read the file,
 * which is what an unsupported camera format looks like.
 */
export async function prepareImage(file: File): Promise<PendingImage> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`cannot read ${file.name || 'that image'}`)
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('this browser cannot resize images')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    // PNG first when the source was one, because PNG holds screenshot text and
    // a screenshot is most of what anyone sends a coding agent from a phone.
    // JPEG qualities descend only until the result fits.
    const attempts: Array<{
      type: 'image/png' | 'image/jpeg'
      quality?: number
    }> =
      file.type === 'image/png'
        ? [
            { type: 'image/png' },
            ...JPEG_QUALITIES.map(quality => ({
              type: 'image/jpeg' as const,
              quality,
            })),
          ]
        : JPEG_QUALITIES.map(quality => ({
            type: 'image/jpeg' as const,
            quality,
          }))

    let best: {
      blob: Blob
      type: 'image/png' | 'image/jpeg'
      data: string
    } | null = null
    for (const attempt of attempts) {
      const blob = await toBlob(canvas, attempt.type, attempt.quality)
      if (!blob) continue
      const data = await toBase64(blob)
      best = { blob, type: attempt.type, data }
      if (data.length <= TARGET_BASE64) break
    }

    if (!best) throw new Error(`cannot encode ${file.name || 'that image'}`)
    if (best.data.length > TARGET_BASE64) {
      throw new Error(`${file.name || 'that image'} is too large to send`)
    }

    return {
      id: crypto.randomUUID(),
      name: file.name || 'image',
      mediaType: best.type,
      data: best.data,
      previewUrl: URL.createObjectURL(best.blob),
    }
  } finally {
    bitmap.close()
  }
}

/** Every image file among a drop, a paste or a picker selection. */
export function imageFilesFrom(
  items: ArrayLike<File> | DataTransferItemList,
): File[] {
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]
    if (entry instanceof File) {
      if (entry.type.startsWith('image/')) files.push(entry)
      continue
    }
    const item = entry as DataTransferItem
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}
