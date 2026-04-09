/**
 * Remote skill loader.
 * Stub — the real implementation is not available in this build.
 */
export async function loadRemoteSkill(
  _slug: string,
  _url: string,
): Promise<{
  cacheHit: boolean
  latencyMs: number
  skillPath: string
  content: string
  fileCount: number
  totalBytes: number
  fetchMethod: string
}> {
  throw new Error('Remote skill loading is not available in this build')
}
