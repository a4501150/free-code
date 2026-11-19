import { randomUUID } from 'crypto'
import type { DomainUserContentBlock } from '../../types/domain.js'
import * as React from 'react'
import { BashModeProgress } from 'src/components/BashModeProgress.js'
import type { SetToolJSXFn } from 'src/Tool.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { PowerShellTool } from 'src/tools/PowerShellTool/PowerShellTool.js'
import type {
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import type { ShellProgress } from 'src/types/tools.js'

import { errorMessage, ShellError } from '../errors.js'
import {
  createSyntheticUserCaveatMessage,
  createUserInterruptionMessage,
  createUserMessage,
  prepareUserContent,
} from '../messages.js'
import { isPtySupported, normalizePtyOutput } from '../shell/ptyShell.js'
import { resolveDefaultShell } from '../shell/resolveDefaultShell.js'
import { isPowerShellToolEnabled } from '../shell/shellToolUtils.js'
import { processToolResultBlock } from '../toolResultStorage.js'
import { escapeXml } from '../xml.js'
import type { ProcessUserInputContext } from './processUserInput.js'
import { InteractiveBashProgress } from 'src/components/InteractiveBashProgress.js'

export async function processBashCommand(
  inputString: string,
  precedingInputBlocks: Array<DomainUserContentBlock | DomainUserContentBlock>,
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
): Promise<{
  messages: (UserMessage | AttachmentMessage | SystemMessage)[]
  shouldQuery: boolean
}> {
  // Shell routing (docs/design/ps-shell-selection.md §5.2): consult
  // defaultShell, fall back to bash. isPowerShellToolEnabled() applies the
  // same platform + env-var gate as tools.ts so input-box routing matches
  // tool-list visibility. Computed up front so telemetry records the
  // actual shell, not the raw setting.
  const usePowerShell =
    isPowerShellToolEnabled() && resolveDefaultShell() === 'powershell'

  const userMessage = createUserMessage({
    content: prepareUserContent({
      inputString: `<bash-input>${inputString}</bash-input>`,
      precedingInputBlocks,
    }),
  })

  // The tool's own live UI payload (set via bashModeContext.setToolJSX —
  // e.g. the background-shell hint). We capture the FULL payload, not just
  // jsx: the merged progress row re-uses the tool's jsx and
  // shouldHidePromptInput, and the remaining flags (shouldContinueAnimation,
  // showSpinner) stay readable here because bash-mode owns the spinner row.
  let toolJSX: Parameters<SetToolJSXFn>[0]

  // Interactive (PTY) mode: every `!` command runs under a PTY on supported
  // platforms, so password prompts (sudo/ssh) work and typed keys reach the
  // child through the InteractiveBashProgress view. PowerShell and Windows
  // keep today's piped execution.
  const interactive =
    isPtySupported() && !usePowerShell
      ? {
          cols: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
        }
      : undefined

  const Progress = interactive ? InteractiveBashProgress : BashModeProgress

  // PTY output carries the line discipline's CRLF; the transcript wants LF.
  // The capture file keeps raw bytes for the WebUI terminal, so this applies
  // at the persist edge only — success and failure paths alike.
  const normalizePty = (text: string): string =>
    interactive ? normalizePtyOutput(text) : text

  // Just show initial UI. In interactive mode the prompt input is hidden —
  // keystrokes belong to the child until it exits or is killed/backgrounded.
  setToolJSX({
    jsx: (
      <Progress
        input={inputString}
        progress={null}
        verbose={context.options.verbose}
      />
    ),
    shouldHidePromptInput: !!interactive,
  })

  try {
    const bashModeContext: ProcessUserInputContext = {
      ...context,
      setToolJSX: args => {
        toolJSX = args
      },
    }

    // Progress UI — shared across both shell backends (both emit ShellProgress)
    const onProgress = (progress: { data: ShellProgress }) => {
      setToolJSX({
        jsx: (
          <>
            <Progress
              input={inputString!}
              progress={progress.data}
              verbose={context.options.verbose}
            />
            {toolJSX?.jsx}
          </>
        ),
        shouldHidePromptInput:
          !!interactive || (toolJSX?.shouldHidePromptInput ?? false),
        showSpinner: false,
      })
    }

    const selectedPowerShell = usePowerShell ? PowerShellTool : null
    const shellTool = selectedPowerShell ?? BashTool

    const response = selectedPowerShell
      ? await selectedPowerShell.call(
          { command: inputString },
          bashModeContext,
          undefined,
          undefined,
          onProgress,
        )
      : await BashTool.call(
          {
            command: inputString,
            ...(interactive ? { _interactive: interactive } : {}),
          },
          bashModeContext,
          undefined,
          undefined,
          onProgress,
        )
    const data = response.data

    if (!data) {
      throw new Error('No result received from shell command')
    }

    const stderr = data.stderr
    // Reuse the same formatting pipeline as inline !`cmd` bash (promptShellExecution)
    // and model-initiated Bash. When BashTool.call() persists large output to disk,
    // data.persistedOutputPath is set and the formatter wraps in <persisted-output>.
    // Pass stderr:'' to keep it separate for the <bash-stderr> UI tag.
    const mapped = await processToolResultBlock(
      shellTool,
      { ...data, stderr: '' },
      randomUUID(),
    )
    // mapped.content may contain our own <persisted-output> wrapper (trusted
    // XML from buildLargeToolResultMessage). Escaping it would turn structural
    // tags into &lt;persisted-output&gt;, breaking the model's parse and
    // UserBashOutputMessage's extractTag. Escape the raw fallback only.
    const stdout =
      typeof mapped.content === 'string'
        ? normalizePty(mapped.content)
        : normalizePty(escapeXml(data.stdout))
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    }
  } catch (e) {
    if (e instanceof ShellError) {
      if (e.interrupted) {
        return {
          messages: [
            createSyntheticUserCaveatMessage(),
            userMessage,
            createUserInterruptionMessage({ toolUse: false }),
            ...attachmentMessages,
          ],
          shouldQuery: false,
        }
      }
      return {
        messages: [
          createSyntheticUserCaveatMessage(),
          userMessage,
          ...attachmentMessages,
          createUserMessage({
            content: `<bash-stdout>${normalizePty(escapeXml(e.stdout))}</bash-stdout><bash-stderr>${normalizePty(escapeXml(e.stderr))}</bash-stderr>`,
          }),
        ],
        shouldQuery: false,
      }
    }
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stderr>Command failed: ${escapeXml(errorMessage(e))}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    }
  } finally {
    setToolJSX(null)
  }
}
