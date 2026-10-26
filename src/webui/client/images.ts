/**
 * Shared pieces of the image lightbox flow, imported by both the transcript
 * rows and the tool cards so the chips and the fetch say the same words.
 */

export function sizeLabel(bytes: number): string {
  // Base64 characters, so the transferred size is about three quarters of it.
  const kb = Math.round((bytes * 0.75) / 1024)
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}

/** One openable image: the id to fetch by and the text to label it with. */
export type WebImageRef = { id: string; label: string }
