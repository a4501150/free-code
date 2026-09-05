import { dirname, isAbsolute, sep } from 'path'

import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged, getPatchFromContents } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  convertLeadingTabsToSpaces,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import {
  applyHashlineEdits,
  formatAnchoredRegions,
  hashLengthForLineCount,
  type ResolutionContext,
} from '../../utils/hashline.js'
import type { AppliedPatch } from '../../utils/editState.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { type ToolUseDiff } from '../../utils/gitDiff.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import {
  FILE_EDIT_TOOL_NAME,
  FILE_UNEXPECTEDLY_MODIFIED_ERROR,
} from './constants.js'
import { getEditToolDescription } from './prompt.js'
import {
  type FileEditInput,
  type FileEditOutput,
  inputSchema,
  outputSchema,
} from './types.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit. Multi-byte UTF-8 files
// can be larger on disk per character, but 1 GiB is a safe byte-level guard
// that prevents OOM without being unnecessarily restrictive.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    return getEditToolDescription()
  },
  userFacingName,
  compactParamKeys: ['file_path'],
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing ${summary}` : 'Editing file'
  },
  get inputSchema() {
    return inputSchema
  },
  get outputSchema() {
    return outputSchema
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${JSON.stringify(input.edits)}`
  },
  getPath(input): string {
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  async validateInput(input: FileEditInput, toolUseContext: ToolUseContext) {
    const { file_path, edits } = input
    // Use expandPath for consistent path normalization (especially on Windows
    // where "/" vs "\" can cause readFileState lookup mismatches)
    const fullFilePath = expandPath(file_path)

    // Reject edits to team memory files that introduce secrets. Scan the
    // combined replacement text across all edits.
    const replacementText = edits
      .map(e => ('lines' in e ? (e.lines ?? '') : ''))
      .join('\n')
    const secretError = checkTeamMemSecrets(fullFilePath, replacementText)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }

    // Check if path should be ignored based on permission settings
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()

    // Prevent OOM on multi-GB files.
    try {
      const { size } = await fs.stat(fullFilePath)
      if (size > MAX_EDIT_FILE_SIZE) {
        return {
          result: false,
          behavior: 'ask',
          message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
          errorCode: 10,
        }
      }
    } catch (e) {
      if (!isENOENT(e)) {
        throw e
      }
    }

    // Read the file as bytes first so we can detect encoding from the buffer
    // instead of calling detectFileEncoding (which does its own sync readSync
    // and would fail with a wasted ENOENT when the file doesn't exist).
    let fileContent: string | null
    try {
      const fileBuffer = await fs.readFileBytes(fullFilePath)
      const encoding: BufferEncoding =
        fileBuffer.length >= 2 &&
        fileBuffer[0] === 0xff &&
        fileBuffer[1] === 0xfe
          ? 'utf16le'
          : 'utf8'
      fileContent = fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
    } catch (e) {
      if (isENOENT(e)) {
        fileContent = null
      } else {
        throw e
      }
    }

    // File doesn't exist. Hashline edits reference existing lines, so the file
    // must be read first — creation goes through the Write tool.
    if (fileContent === null) {
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`

      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        behavior: 'ask',
        message,
        errorCode: 4,
      }
    }

    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File has not been read yet. Read it first before writing to it.',
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 6,
      }
    }

    // Check if file exists and get its last modified time
    if (readTimestamp) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      if (lastWriteTime > readTimestamp.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives.
        const isFullRead =
          readTimestamp.offset === undefined &&
          readTimestamp.limit === undefined
        if (isFullRead && fileContent === readTimestamp.content) {
          // Content unchanged, safe to proceed
        } else {
          toolUseContext.editState?.invalidate(
            fullFilePath,
            'File has been modified since read.',
          )
          return {
            result: false,
            behavior: 'ask',
            message:
              'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
            errorCode: 7,
          }
        }
      }
    }

    const file = fileContent

    // Materialize the response baseline: after the staleness checks the disk
    // content still corresponds to what the model was shown, so it can anchor
    // remaps for later edits of this file in the same response.
    const editState = toolUseContext.editState
    if (editState && !editState.get(fullFilePath)?.remapUnavailableReason) {
      editState.beginBaseline(fullFilePath, file, readTimestamp)
    }
    const resolution = resolutionContext(editState, fullFilePath)

    // Dry-run the hashline edits to validate anchors against current content.
    // On failure the error already includes fresh anchors for the model.
    const dryRun = applyHashlineEdits(file, edits, resolution)
    if (!dryRun.ok) {
      return {
        result: false,
        behavior: 'ask',
        message: dryRun.error,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 8,
      }
    }

    // Additional validation for Claude settings files, against the simulated
    // post-edit content.
    const settingsValidationResult = validateInputForSettingsFileEdit(
      fullFilePath,
      file,
      () => dryRun.updatedContent,
    )

    if (settingsValidationResult !== null) {
      return settingsValidationResult
    }

    return { result: true }
  },
  inputsEquivalent(input1, input2) {
    return (
      input1.file_path === input2.file_path &&
      JSON.stringify(input1.edits) === JSON.stringify(input2.edits)
    )
  },
  async call(
    input: FileEditInput,
    {
      readFileState,
      editState,
      userModified,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
    },
    _,
    parentMessage,
  ) {
    const { file_path, edits } = input

    // 1. Get current state
    const fs = getFsImplementation()
    const absoluteFilePath = expandPath(file_path)

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(
        [absoluteFilePath],
        cwd,
      )
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([absoluteFilePath], cwd)
    }

    await diagnosticTracker.beforeFileEdited(absoluteFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // These awaits must stay OUTSIDE the critical section below — a yield between
    // the staleness check and writeTextContent lets concurrent edits interleave.
    await fs.mkdir(dirname(absoluteFilePath))
    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state).
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        absoluteFilePath,
        parentMessage.uuid,
      )
    }

    // 2. Load current state and confirm no changes since last read
    // Please avoid async operations between here and writing to disk to preserve atomicity
    const {
      content: originalFileContents,
      fileExists,
      encoding,
      lineEndings: endings,
    } = readFileForEdit(absoluteFilePath)

    if (fileExists) {
      // Permission prompts can take minutes: confirm the file still matches
      // what this response's own edits left on disk before applying more.
      const st = editState?.get(absoluteFilePath)
      if (
        !input._overrideContent &&
        st?.expectedCurrentContent !== undefined &&
        st.expectedCurrentContent !== originalFileContents
      ) {
        editState?.invalidate(
          absoluteFilePath,
          FILE_UNEXPECTEDLY_MODIFIED_ERROR,
        )
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
      const lastWriteTime = getFileModificationTime(absoluteFilePath)
      const lastRead = readFileState.get(absoluteFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives.
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        const contentUnchanged =
          isFullRead && originalFileContents === lastRead.content
        if (!contentUnchanged) {
          editState?.invalidate(
            absoluteFilePath,
            FILE_UNEXPECTEDLY_MODIFIED_ERROR,
          )
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    // 3. Compute the updated content. The IDE-amend flow supplies the final
    // content directly; otherwise apply the hashline edits by anchor, resolved
    // against the response baseline plus this response's own patches.
    editState?.beginBaseline(absoluteFilePath, originalFileContents)
    let updatedFile: string
    let editCount: number
    let appliedPatches: AppliedPatch[] = []
    let lineDelta = 0
    if (input._overrideContent) {
      updatedFile = input._overrideContent.newContent
      editCount = edits.length
    } else {
      const r = applyHashlineEdits(
        originalFileContents,
        edits,
        resolutionContext(editState, absoluteFilePath),
      )
      if (!r.ok) {
        throw new Error(r.error)
      }
      updatedFile = r.updatedContent
      editCount = r.editCount
      appliedPatches = r.appliedPatches
      lineDelta = r.lineDelta
    }

    // 4. Generate the display patch. Leading tabs are rendered as spaces to
    // match the TUI's diff styling (display-only — disk gets the raw content).
    const patch = getPatchFromContents({
      filePath: absoluteFilePath,
      oldContent: convertLeadingTabsToSpaces(originalFileContents),
      newContent: convertLeadingTabsToSpaces(updatedFile),
    })

    // 5. Write to disk
    writeTextContent(absoluteFilePath, updatedFile, encoding, endings)

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
      // didChange: Content has been modified
      lspManager
        .changeFile(absoluteFilePath, updatedFile)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${absoluteFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${absoluteFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, updatedFile)

    // 6. Update read timestamp, to invalidate stale writes
    readFileState.set(absoluteFilePath, {
      content: updatedFile,
      timestamp: getFileModificationTime(absoluteFilePath),
      offset: undefined,
      limit: undefined,
    })
    if (input._overrideContent) {
      editState?.replaceSnapshot(absoluteFilePath, {
        content: updatedFile,
        timestamp: getFileModificationTime(absoluteFilePath),
        offset: undefined,
        limit: undefined,
      })
    } else {
      editState?.recordEdit(absoluteFilePath, updatedFile, appliedPatches)
    }

    // 7. Log events
    countLinesChanged(patch)

    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: absoluteFilePath,
    })

    let gitDiff: ToolUseDiff | undefined

    // 8. Yield result
    // Anchors for what was just written. Without them a follow-up edit to this
    // file has to Read it again: every anchor the model still holds predates
    // this write, and the ones below the edit have shifted. Sliced from the
    // raw content, never the tab-converted display copy, or the hashes would
    // not match what the next edit validates against.
    const changedRegionAnchors = formatAnchoredRegions(
      updatedFile,
      patch.map(hunk => ({
        start: Math.max(1, hunk.newStart),
        count: hunk.newLines,
      })),
    )
    // Label length is chosen from the whole-file line count; when an edit
    // moves the count across a boundary, every held anchor is the wrong hash.
    const anchorsStale =
      hashLengthForLineCount(originalFileContents.split('\n').length) !==
      hashLengthForLineCount(updatedFile.split('\n').length)

    const data = {
      filePath: file_path,
      originalFile: originalFileContents,
      structuredPatch: patch,
      userModified: userModified ?? false,
      editCount,
      ...(lineDelta !== 0 && { lineDelta }),
      ...(anchorsStale && { anchorsStale: true }),
      ...(changedRegionAnchors && { changedRegionAnchors }),
      ...(gitDiff && { gitDiff }),
    }
    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const {
      filePath,
      userModified,
      changedRegionAnchors,
      lineDelta,
      anchorsStale,
      structuredPatch,
    } = data
    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''
    // Where the model's held anchors went, so a follow-up edit below the
    // hunk is not a guess: the shift is uniform below the last hunk.
    const shiftNote =
      lineDelta !== undefined && lineDelta !== 0
        ? `\n\nNet line shift below the edited hunks: ${lineDelta > 0 ? `+${lineDelta}` : lineDelta}. Anchors from your earlier copy of the file sit at different lines below the edit.`
        : ''
    const staleNote = anchorsStale
      ? '\n\nThe file changed enough to change its anchor hash length: every anchor from your earlier copy is stale. Read the file again before editing it.'
      : ''
    const anchorNote = changedRegionAnchors
      ? `\n\nAnchors for the changed lines. Use them to edit this file again without reading it first:\n${changedRegionAnchors}`
      : ''
    // The size of the change, so an anchor range that swallowed one line too
    // many is visible in the success message, not only when a lost line later
    // breaks the typecheck.
    let removed = 0
    let added = 0
    for (const hunk of structuredPatch) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
    }
    const deltaNote =
      removed + added > 0
        ? `\n\nThe edit removed ${removed} line(s) and added ${added}.`
        : ''

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.${deltaNote}${shiftNote}${staleNote}${anchorNote}`,
    }
  },
} satisfies ToolDef<typeof inputSchema, FileEditOutput>)

// --
// What Edit resolution may consult for this file in this response: the
// response baseline and the patches this response already applied, when the
// file has one.
function resolutionContext(
  editState: ToolUseContext['editState'],
  filePath: string,
): ResolutionContext {
  const st = editState?.get(filePath)
  return {
    filePath,
    baselineContent: st?.baselineContent,
    patches: st?.patches,
    remapUnavailableReason: st?.remapUnavailableReason,
  }
}

function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}
