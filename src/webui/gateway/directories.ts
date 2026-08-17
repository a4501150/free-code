import type { Dirent } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { getFsImplementation } from '../../utils/fsOperations.js'

export type DirectoryEntry = { name: string; path: string }

export type DirectoryListing = {
  /** The directory the entries came from, always absolute. */
  base: string
  /** One level up, or null at the root of the volume. */
  parent: string | null
  entries: DirectoryEntry[]
  /** More directories matched than `MAX_ENTRIES`. */
  truncated: boolean
}

export type PathErrorCode =
  | 'bad_path'
  | 'directory_not_found'
  | 'directory_not_readable'
  | 'path_not_absolute'
  | 'path_not_directory'
  | 'path_not_local'
  | 'cwd_not_absolute'
  | 'cwd_not_directory'
  | 'cwd_not_found'
  | 'cwd_not_local'
  | 'cwd_unreadable'

export class PathError extends Error {
  constructor(readonly code: PathErrorCode) {
    super(code)
    this.name = 'PathError'
  }
}

const MAX_ENTRIES = 200
const MAX_PATH_CHARS = 4096

/**
 * A `stat` on `\\server\share` starts SMB authentication, which hands an NTLM
 * exchange to whoever named the server. The file tools refuse the same shape.
 */
function isNetworkPath(value: string): boolean {
  return value.startsWith('\\\\') || value.startsWith('//')
}

function guardShape(
  value: string,
  codes: { notAbsolute: PathErrorCode; notLocal: PathErrorCode },
): void {
  if (value.length > MAX_PATH_CHARS || value.includes('\0')) {
    throw new PathError('bad_path')
  }
  if (isNetworkPath(value)) throw new PathError(codes.notLocal)
  if (!isAbsolute(value)) throw new PathError(codes.notAbsolute)
}

function endsWithSeparator(value: string): boolean {
  return value.endsWith('/') || value.endsWith(sep)
}

function classify(error: unknown): PathError {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return new PathError('directory_not_found')
  if (code === 'ENOTDIR') return new PathError('path_not_directory')
  if (code === 'EACCES' || code === 'EPERM') {
    return new PathError('directory_not_readable')
  }
  return new PathError('bad_path')
}

/**
 * True for a directory, and for a symlink that leads to one. A link is kept
 * under its own name: resolving it would make the `..` row climb out of the
 * tree the user was browsing.
 */
async function leadsToDirectory(entry: Dirent, path: string): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return (await getFsImplementation().stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Lists the directories a partial path could continue into.
 *
 * A trailing separator means "everything inside this directory". Without one,
 * the last segment filters the contents of its parent, so a half-typed name
 * narrows the list instead of failing.
 *
 * Nothing is cached. The gateway outlives any cache worth having, and a
 * directory the user just created has to appear.
 */
export async function listDirectories(
  rawPath: string,
  showHidden: boolean,
): Promise<DirectoryListing> {
  const trimmed = rawPath.trim()
  let base: string
  let prefix: string

  if (!trimmed) {
    // resolve, because HOME itself can carry a stray or doubled separator.
    base = resolve(homedir())
    prefix = ''
  } else {
    guardShape(trimmed, {
      notAbsolute: 'path_not_absolute',
      notLocal: 'path_not_local',
    })
    // resolve, not normalize: it drops a trailing separator while leaving the
    // root of the volume alone. The path is already absolute, so the working
    // directory of this process never enters into it.
    const path = resolve(trimmed)
    if (endsWithSeparator(trimmed)) {
      base = path
      prefix = ''
    } else {
      base = dirname(path)
      prefix = basename(path)
    }
  }

  let dirents: Dirent[]
  try {
    dirents = await getFsImplementation().readdir(base)
  } catch (error) {
    throw classify(error)
  }

  const needle = prefix.toLowerCase()
  const candidates = dirents.filter(entry => {
    if (!showHidden && entry.name.startsWith('.')) return false
    return entry.name.toLowerCase().startsWith(needle)
  })

  const entries: DirectoryEntry[] = []
  for (const entry of candidates) {
    const path = join(base, entry.name)
    if (await leadsToDirectory(entry, path)) {
      entries.push({ name: entry.name, path })
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const parent = dirname(base)
  return {
    base,
    parent: parent === base ? null : parent,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  }
}

/**
 * Checks a working directory before it reaches `spawn`, which reports a bare
 * errno the browser cannot explain. `stat` follows a link, so a symlinked
 * project directory stays valid while a link to a file does not.
 */
export async function validateSessionCwd(cwd: string): Promise<void> {
  guardShape(cwd, {
    notAbsolute: 'cwd_not_absolute',
    notLocal: 'cwd_not_local',
  })

  let isDirectory: boolean
  try {
    isDirectory = (await getFsImplementation().stat(cwd)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new PathError('cwd_unreadable')
    }
    if (code === 'ENOTDIR') throw new PathError('cwd_not_directory')
    throw new PathError('cwd_not_found')
  }
  if (!isDirectory) throw new PathError('cwd_not_directory')
}

export const PATH_ERROR_STATUS: Record<PathErrorCode, number> = {
  bad_path: 400,
  directory_not_found: 404,
  directory_not_readable: 403,
  path_not_absolute: 400,
  path_not_directory: 422,
  path_not_local: 403,
  cwd_not_absolute: 400,
  cwd_not_directory: 422,
  cwd_not_found: 404,
  cwd_not_local: 403,
  cwd_unreadable: 403,
}
