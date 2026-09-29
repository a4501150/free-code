/**
 * The blocking-request trays for the attached TUI client.
 *
 * Same terminal as the browser's trays: every request on the wire has one
 * answer here, sent as a `request_respond` command. The pure half — the
 * form a server schema implies, the decision an edited input builds — is
 * the browser's own `webui/client/trayViews.ts`, imported whole.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import { Select } from '../../components/CustomSelect/index.js'
import { AskUserQuestionPermissionRequest } from '../../components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js'
import { ExitPlanModePermissionRequest } from '../../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { ExitPlanModeTool } from '../../tools/ExitPlanModeTool/ExitPlanModeTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import type {
  WirePermissionDecision,
  WirePermissionMode,
  WireRequest,
  WireRequestResponse,
} from '../../session/wire.js'
import {
  ALLOW_SET_MODES,
  buildAllowDecision,
  elicitationContent,
  elicitationFields,
  type ElicitationValues,
} from '../../webui/client/trayViews.js'
import { LineInput } from './LineInput.js'

export type TraySubmit = (
  requestId: string,
  response: WireRequestResponse,
) => void

type DecisionProps = {
  request: Extract<WireRequest, { kind: 'permission' }>
  queued: number
  submit: TraySubmit
}

// ---------------------------------------------------------------------------
// Classic dialog mirrors
//
// Two requests are more than allow/deny: AskUserQuestion renders the full
// option/preview dialog and ExitPlanMode the plan approval with its
// clear-context flow. The viewer mounts the REPL's OWN components for these,
// backed by a synthesized ToolUseConfirm whose callbacks answer the wire
// request. The classic tree reads its contexts (settings, theme, keybindings,
// app state) from the viewer's providers — identical panes, one answer
// channel. The tool callbacks are wired to the request's `input` and
// decision plumbing only; everything the body renders comes from the wire.
// ---------------------------------------------------------------------------

/** The wire decision a classic dialog's onAllow/onReject map onto. */
function useClassicDecision(
  request: Extract<WireRequest, { kind: 'permission' }>,
  submit: TraySubmit,
): {
  respond: (decision: WirePermissionDecision) => void
  confirm: ToolUseConfirm
} {
  const settledRef = useRef(false)
  const respond = useCallback(
    (decision: WirePermissionDecision) => {
      // The classic dialogs call onDone/onReject/onAllow in sequence and a
      // stray second call must not answer an already-answered request.
      if (settledRef.current) return
      settledRef.current = true
      submit(request.requestId, { kind: 'permission', decision })
    },
    [request.requestId, submit],
  )

  const confirm = useMemo(
    () =>
      ({
        // The dialog bodies consume `input`, `onAllow`, `onReject` and
        // `permissionResult`; the rest of the ToolUseConfirm shape exists
        // for the REPL's queue bookkeeping, which the wire request replaced.
        assistantMessage: { message: { usage: undefined } },
        description: request.description,
        input: request.input,
        toolUseID: request.toolUseId,
        permissionResult: { behavior: 'ask' },
        permissionPromptStartTimeMs: request.openedAt,
        onUserInteraction: () => {},
        onAbort: () => respond({ behavior: 'deny' }),
        recheckPermission: async () => {},
        onAllow: (
          updatedInput: Record<string, unknown>,
          permissionUpdates: PermissionUpdate[],
          feedback?: string,
        ) => {
          const modeUpdate = permissionUpdates?.find(
            update => update.type === 'setMode',
          )
          const merged = { ...request.input, ...(updatedInput ?? {}) }
          respond({
            behavior: 'allow',
            updatedInput: merged,
            setMode:
              (modeUpdate as { mode?: WirePermissionMode } | undefined)?.mode ??
              undefined,
            feedback,
          })
        },
        onReject: (feedback?: string) =>
          respond({ behavior: 'deny', message: feedback ?? 'cancelled' }),
      }) as unknown as ToolUseConfirm,
    [
      request.input,
      request.description,
      request.toolUseId,
      request.openedAt,
      respond,
    ],
  )

  return { respond, confirm }
}

function ClassicQuestionDialog({
  request,
  submit,
}: {
  request: Extract<WireRequest, { kind: 'permission' }>
  submit: TraySubmit
}): React.ReactNode {
  const { confirm } = useClassicDecision(request, submit)
  return (
    <AskUserQuestionPermissionRequest
      toolUseConfirm={confirm}
      toolUseContext={undefined as unknown as ToolUseContext}
      onDone={() => {}}
      onReject={() => {}}
      verbose={false}
    />
  )
}

function ClassicPlanDialog({
  request,
  submit,
}: {
  request: Extract<WireRequest, { kind: 'permission' }>
  submit: TraySubmit
}): React.ReactNode {
  const { confirm } = useClassicDecision(request, submit)
  const ui = request.ui
  return (
    <ExitPlanModePermissionRequest
      toolUseConfirm={confirm}
      toolUseContext={undefined as unknown as ToolUseContext}
      onDone={() => {}}
      onReject={() => {}}
      verbose={false}
      wirePlan={
        ui?.kind === 'plan'
          ? { filePath: ui.planFilePath, content: ui.planContent }
          : undefined
      }
    />
  )
}

function PermissionTray({
  request,
  queued,
  submit,
}: DecisionProps): React.ReactNode {
  const [pane, setPane] = useState<'main' | 'edit' | 'mode'>('main')
  const [editedInput, setEditedInput] = useState<string | null>(null)
  const [persist, setPersist] = useState(false)
  const [setMode, setSetMode] = useState<WirePermissionMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ui = request.ui
  if (ui?.kind === 'question') {
    return <ClassicQuestionDialog request={request} submit={submit} />
  }
  if (ui?.kind === 'plan') {
    return <ClassicPlanDialog request={request} submit={submit} />
  }

  function allow(decision: WirePermissionDecision): void {
    submit(request.requestId, { kind: 'permission', decision })
  }

  function approve(): void {
    const built = buildAllowDecision({
      persist,
      setMode,
      editedInput,
      originalInput: request.input,
    })
    if (!built.ok) {
      setError(built.error)
      return
    }
    allow(built.decision)
  }

  const queuedNote = queued > 1 ? ` (+${queued - 1} waiting)` : ''

  return (
    <PermissionDialog title={`Permission${queuedNote}`} color="permission">
      <Box flexDirection="column" paddingTop={1}>
        <Text bold>{request.toolName}</Text>
        {request.description ? <Text>{request.description}</Text> : null}
        {request.blockedPath ? (
          <Text color="warning">Path: {request.blockedPath}</Text>
        ) : null}
        {request.agentId ? (
          <Text dimColor>agent {request.agentId.slice(0, 8)}</Text>
        ) : null}
        <Box maxHeight={8} overflow="hidden">
          <Text dimColor>{JSON.stringify(request.input, null, 1)}</Text>
        </Box>
        {/* The classic dialogs all ask the same question above their
            options ("Do you want to proceed?"); the tray asks it too. */}
        <Text>Do you want to proceed?</Text>
        <Text dimColor>
          persist {persist ? '✓' : '·'} · mode {setMode ?? 'unchanged'}
          {error ? ` · ${error}` : ''}
        </Text>
        {pane === 'edit' ? (
          <Box paddingTop={1}>
            <LineInput
              value={editedInput ?? JSON.stringify(request.input)}
              onChange={text => {
                setEditedInput(text)
                setError(null)
              }}
              onSubmit={() => approve()}
              onCancel={() => setPane('main')}
              placeholder="Tool input as JSON"
            />
          </Box>
        ) : pane === 'mode' ? (
          <Box paddingTop={1}>
            <Select
              options={[
                ...ALLOW_SET_MODES.map(mode => ({
                  label: `allow + switch to ${mode}`,
                  value: mode,
                })),
                { label: 'no mode change', value: 'none' },
              ]}
              onChange={(value: string) => {
                setSetMode(
                  value === 'none' ? null : (value as WirePermissionMode),
                )
                setPane('main')
              }}
              onCancel={() => setPane('main')}
            />
          </Box>
        ) : (
          <Box paddingTop={1}>
            <Select
              options={[
                { label: 'Allow', value: 'allow' },
                {
                  label: persist
                    ? 'stop asking this session (off)'
                    : 'stop asking this session (on)',
                  value: 'persist',
                },
                { label: 'edit tool input…', value: 'edit' },
                { label: 'allow + change mode…', value: 'mode' },
                { label: 'Deny', value: 'deny' },
              ]}
              onChange={(value: string) => {
                setError(null)
                switch (value) {
                  case 'allow':
                    approve()
                    return
                  case 'persist':
                    setPersist(p => !p)
                    return
                  case 'edit':
                    setPane('edit')
                    return
                  case 'mode':
                    setPane('mode')
                    return
                  case 'deny':
                    allow({ behavior: 'deny' })
                    return
                }
              }}
              onCancel={() => allow({ behavior: 'deny', message: 'cancelled' })}
            />
          </Box>
        )}
      </Box>
    </PermissionDialog>
  )
}

function HookPromptTray({
  request,
  queued,
  submit,
}: {
  request: Extract<WireRequest, { kind: 'hook_prompt' }>
  queued: number
  submit: TraySubmit
}): React.ReactNode {
  const queuedNote = queued > 1 ? ` (+${queued - 1} waiting)` : ''
  return (
    <PermissionDialog title={`Hook prompt${queuedNote}`} color="permission">
      <Box flexDirection="column" paddingTop={1}>
        <Text>{request.message}</Text>
        <Box paddingTop={1}>
          <Select
            options={request.options.map(option => ({
              label: option.label,
              value: option.key,
              description: option.description,
            }))}
            onChange={(key: string) =>
              submit(request.requestId, { kind: 'hook_prompt', selected: key })
            }
            onCancel={() =>
              submit(request.requestId, {
                kind: 'hook_prompt',
                selected: request.options[0]?.key ?? '',
              })
            }
          />
        </Box>
      </Box>
    </PermissionDialog>
  )
}

type ElicitPane = 'fields' | 'text' | 'decision'

function ElicitationTray({
  request,
  queued,
  submit,
}: {
  request: Extract<WireRequest, { kind: 'elicitation' }>
  queued: number
  submit: TraySubmit
}): React.ReactNode {
  const fields = useMemo(
    () => elicitationFields(request.params),
    [request.params],
  )
  const [values, setValues] = useState<ElicitationValues>({})
  const [pane, setPane] = useState<ElicitPane>('fields')
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const message = (request.params as { message?: string } | null)?.message
  const queuedNote = queued > 1 ? ` (+${queued - 1} waiting)` : ''

  function accept(): void {
    const built = elicitationContent(fields, values)
    if (!built.ok) {
      setError(built.error)
      return
    }
    submit(request.requestId, {
      kind: 'elicitation',
      action: 'accept',
      content: built.content,
    })
  }

  const actions: Array<{
    label: string
    value: string
    description?: string
  }> = []
  fields.forEach((field, i) => {
    const shown =
      field.type === 'checkbox'
        ? values[field.name] === true
          ? '✓'
          : '·'
        : typeof values[field.name] === 'string' && values[field.name]
          ? String(values[field.name])
          : '(empty)'
    actions.push({
      label: `${i + 1}. ${field.label}${field.required ? ' *' : ''}`,
      value: `field:${field.name}`,
      description: `${shown}${field.description ? ` — ${field.description}` : ''}`,
    })
  })
  actions.push(
    { label: 'Accept', value: 'accept' },
    { label: 'Decline', value: 'decline' },
    { label: 'Cancel', value: 'cancel' },
  )

  return (
    <PermissionDialog title={`Elicitation${queuedNote}`} color="permission">
      <Box flexDirection="column" paddingTop={1}>
        <Text bold>{request.serverName}</Text>
        {message ? <Text>{message}</Text> : null}
        {request.waiting ? (
          <Text color="warning">waiting for the browser step…</Text>
        ) : null}
        {error ? <Text color="error">{error}</Text> : null}
        {pane === 'text' && editing ? (
          <Box paddingTop={1}>
            <LineInput
              value={
                typeof values[editing] === 'string'
                  ? String(values[editing])
                  : ''
              }
              onChange={text => {
                setValues(v => ({ ...v, [editing]: text }))
                setError(null)
              }}
              onSubmit={() => setPane('fields')}
              onCancel={() => setPane('fields')}
              placeholder="value"
            />
          </Box>
        ) : (
          <Box paddingTop={1}>
            <Select
              options={actions}
              onChange={(value: string) => {
                setError(null)
                if (value.startsWith('field:')) {
                  const name = value.slice('field:'.length)
                  const field = fields.find(
                    candidate => candidate.name === name,
                  )
                  if (!field) return
                  if (field.type === 'checkbox') {
                    setValues(v => ({ ...v, [name]: v[name] !== true }))
                    return
                  }
                  if (field.type === 'select') {
                    // Cycle the enum in place — the schema's own choices.
                    const choices = field.options ?? []
                    if (choices.length === 0) return
                    const at = choices.indexOf(String(values[name] ?? ''))
                    const nextValue = choices[(at + 1) % choices.length]!
                    setValues(v => ({ ...v, [name]: nextValue }))
                    return
                  }
                  setEditing(name)
                  setPane('text')
                  return
                }
                switch (value) {
                  case 'accept':
                    accept()
                    return
                  case 'decline':
                    submit(request.requestId, {
                      kind: 'elicitation',
                      action: 'decline',
                    })
                    return
                  case 'cancel':
                    submit(request.requestId, {
                      kind: 'elicitation',
                      action: 'cancel',
                    })
                    return
                }
              }}
              onCancel={() =>
                submit(request.requestId, {
                  kind: 'elicitation',
                  action: 'cancel',
                })
              }
            />
          </Box>
        )}
      </Box>
    </PermissionDialog>
  )
}

/**
 * One active tray at a time, oldest request first — the same discipline the
 * browser's shell keeps, so requests stack visibly and retire on close.
 */
export function AttachedTrays({
  requests,
  submit,
}: {
  requests: WireRequest[]
  submit: TraySubmit
}): React.ReactNode {
  const active = requests[0]
  if (!active) return null
  const queued = requests.length
  if (active.kind === 'permission') {
    return <PermissionTray request={active} queued={queued} submit={submit} />
  }
  if (active.kind === 'hook_prompt') {
    return <HookPromptTray request={active} queued={queued} submit={submit} />
  }
  return <ElicitationTray request={active} queued={queued} submit={submit} />
}
