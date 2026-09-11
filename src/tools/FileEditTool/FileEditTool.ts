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
import {
  approveEdit,
  type ApprovalNote,
  type ApprovalResult,
} from '../../utils/editApproval.js'
import { planEdit } from '../../utils/editMatch.js'
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
import { withFileLock } from '../../utils/fileLock.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
  stripBom,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { type ToolUseDiff } from '../../utils/gitDiff.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  isScratchpadPath,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { FILE_EDIT_TOOL_NAME } from './constants.js'
import { coerceEditInput } from './legacyInput.js'
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

type EditRequest = {
  oldString: string
  newString: string
  replaceAll: boolean
}

function requestFromInput(input: FileEditInput): EditRequest {
  return {
    oldString: input.old_string,
    newString: input.new_string,
    replaceAll: input.replace_all ?? false,
  }
}

function fileDoesNotExistError(fullFilePath: string): {
  result: false
  behavior: 'ask'
  message: string
  errorCode: number
} {
  const similarFilename = findSimilarFile(fullFilePath)
  const cwdSuggestion = suggestPathUnderCwdSync(fullFilePath)
  let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
  if (cwdSuggestion) {
    message += ` Did you mean ${cwdSuggestion}?`
  } else if (similarFilename) {
    message += ` Did you mean ${similarFilename}?`
  }
  return { result: false, behavior: 'ask', message, errorCode: 4 }
}

function suggestPathUnderCwdSync(fullFilePath: string): string | null {
  // suggestPathUnderCwd is async; validateInput awaits it separately when it
  // can. This sync helper only handles the cheap already-under-cwd case.
  const cwd = getCwd()
  return fullFilePath.startsWith(cwd + sep) ? fullFilePath : null
}

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    return getEditToolDescription()
  },
  coerceInput: coerceEditInput,
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
    return `${input.file_path}: ${JSON.stringify(input.old_string)} -> ${JSON.stringify(input.new_string)}`
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
    const { old_string, new_string } = input
    // Use expandPath for consistent path normalization (especially on Windows
    // where "/" vs "\" can cause readFileState lookup mismatches)
    const fullFilePath = expandPath(input.file_path)

    // Reject edits to team memory files that introduce secrets.
    const secretError = checkTeamMemSecrets(
      fullFilePath,
      old_string + '\n' + new_string,
    )
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

    if (old_string === new_string) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        errorCode: 1,
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

    if (fileContent === null) {
      // Creation mode: an empty old_string against a missing file writes
      // new_string as the whole file (the Write tool is the other door).
      if (old_string === '') {
        return { result: true }
      }
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }
      return { result: false, behavior: 'ask', message, errorCode: 4 }
    }

    if (old_string === '') {
      return {
        result: false,
        behavior: 'ask',
        message: 'Cannot create new file - file already exists.',
        errorCode: 3,
      }
    }

    const planned = planEdit(fileContent, requestFromInput(input))
    if (!planned.ok) {
      return {
        result: false,
        behavior: 'ask',
        message: planned.failure.message,
        meta: {
          isFilePathAbsolute: String(isAbsolute(input.file_path)),
        },
        errorCode: planned.failure.errorCode,
      }
    }

    // Logic-based placement approval: what the model was shown (any source)
    // and current disk content decide, never a bare timestamp. Scratchpad
    // files are exempt: session temp notes have no meaningful seen-claim
    // and multiple agents (subagents, prior sessions) write them freely.
    const approval: ApprovalResult = isScratchpadPath(fullFilePath)
      ? { ok: true, note: 'fresh' }
      : approveEdit({
          state: toolUseContext.readFileState.get(fullFilePath),
          // Ledger contents are BOM-free; the plan still runs against the raw
          // bytes so the write-back keeps the BOM.
          currentContent: stripBom(fileContent),
          plan: planned.plan,
        })
    if (!approval.ok) {
      return {
        result: false,
        behavior: 'ask',
        message: approval.message,
        meta: {
          isFilePathAbsolute: String(isAbsolute(input.file_path)),
        },
        errorCode: approval.errorCode,
      }
    }

    // Additional validation for Claude settings files, against the simulated
    // post-edit content.
    const settingsValidationResult = validateInputForSettingsFileEdit(
      fullFilePath,
      fileContent,
      () => planned.plan.updatedContent,
    )

    if (settingsValidationResult !== null) {
      return settingsValidationResult
    }

    return { result: true }
  },
  inputsEquivalent(input1, input2) {
    return (
      input1.file_path === input2.file_path &&
      input1.old_string === input2.old_string &&
      input1.new_string === input2.new_string &&
      (input1.replace_all ?? false) === (input2.replace_all ?? false)
    )
  },
  async call(
    input: FileEditInput,
    {
      readFileState,
      userModified,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
    },
    _,
    parentMessage,
  ) {
    const { file_path } = input

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

    // 2-6. Read, re-plan, approve, patch, write and re-record — inside the
    // per-file lock so parallel Edits of one file in a single response
    // serialize and each sees the previous edit's result.
    const data = await withFileLock(absoluteFilePath, () => {
      // 2. Load current state and approve placement against it.
      // Please avoid async operations between here and writing to disk to preserve atomicity
      const {
        content: originalFileContents,
        fileExists,
        encoding,
        lineEndings: endings,
      } = readFileForEdit(absoluteFilePath)

      // 3. Compute the updated content. The IDE-amend flow supplies the final
      // content directly; otherwise plan the replacement against the file as
      // it stands now (validateInput already planned against a pre-permission
      // snapshot — re-planning covers edits that landed during the prompt).
      let updatedFile: string
      let editCount: number
      let approvalNote: ApprovalNote
      let gitDiff: ToolUseDiff | undefined
      if (input._overrideContent) {
        updatedFile = input._overrideContent.newContent
        editCount = 1
        approvalNote = 'fresh'
      } else if (!fileExists) {
        if (input.old_string !== '') {
          throw new Error(fileDoesNotExistError(absoluteFilePath).message)
        }
        updatedFile = input.new_string
        editCount = 1
        approvalNote = 'fresh'
      } else if (input.old_string === '') {
        throw new Error('Cannot create new file - file already exists.')
      } else {
        const planned = planEdit(originalFileContents, requestFromInput(input))
        if (!planned.ok) {
          throw new Error(planned.failure.message)
        }
        const approval: ApprovalResult = isScratchpadPath(absoluteFilePath)
          ? { ok: true, note: 'fresh' }
          : approveEdit({
              state: readFileState.get(absoluteFilePath),
              currentContent: stripBom(originalFileContents),
              plan: planned.plan,
            })
        if (!approval.ok) {
          throw new Error(approval.message)
        }
        updatedFile = planned.plan.updatedContent
        editCount = planned.plan.spans.length
        approvalNote = approval.note
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
      notifyVscodeFileUpdated(
        absoluteFilePath,
        originalFileContents,
        updatedFile,
      )

      // 6. Re-record the ledger: the model authored (or kept) this content, it
      // is current in its context, so self-inflicted staleness never trips.
      // BOM-free to match how approvals compare disk bytes.
      readFileState.set(absoluteFilePath, {
        content: stripBom(updatedFile),
        timestamp: getFileModificationTime(absoluteFilePath),
        offset: undefined,
        limit: undefined,
        source: 'edit',
      })

      // 7. Log events
      countLinesChanged(patch)

      logFileOperation({
        operation: 'edit',
        tool: 'FileEditTool',
        filePath: absoluteFilePath,
      })

      // 8. Build the result.
      return {
        filePath: file_path,
        originalFile: originalFileContents,
        structuredPatch: patch,
        userModified: userModified ?? false,
        editCount,
        approvalNote,
        ...(gitDiff && { gitDiff }),
      } satisfies FileEditOutput
    })

    return { data }
  },
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const { filePath, userModified, structuredPatch, approvalNote } = data
    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''
    // The size of the change, so an old_string that swallowed one line too
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
    const contextNote =
      approvalNote === 'fresh'
        ? ' (file state is current in your context — no need to Read it back)'
        : approvalNote === 'recovered'
          ? ' (note: the file had been modified on disk since you last saw it — the edit applied cleanly, but the file contains other changes not in your context)'
          : approvalNote === 'blind-placement'
            ? ' (note: the edited lines were outside the part of this file you have seen — the replacement was verified against current disk content)'
            : approvalNote === 'blind'
              ? ' (note: you had not opened this file — the edit was verified against current disk content and matched exactly once)'
              : ''

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.${deltaNote}${contextNote}`,
    }
  },
} satisfies ToolDef<typeof inputSchema, FileEditOutput>)

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
