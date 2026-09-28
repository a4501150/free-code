/**
 * The blocking-request trays for the attached TUI client.
 *
 * Same terminal as the browser's trays: every request on the wire has one
 * answer here, sent as a `request_respond` command. The pure half — the
 * form a server schema implies, the decision an edited input builds — is
 * the browser's own `webui/client/trayViews.ts`, imported whole.
 */
import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import { Select } from '../../components/CustomSelect/index.js'
import { SelectMulti } from '../../components/CustomSelect/SelectMulti.js'
import { Markdown } from '../../components/Markdown.js'
import type {
  WirePermissionDecision,
  WirePermissionMode,
  WireQuestion,
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

/** The free-text row the browser's question tray always appends. */
const OTHER = '__other__'

function serializeAnswer(
  question: WireQuestion,
  labels: string[],
  other: string,
): string {
  if (labels.includes(OTHER)) return other.trim()
  return question.multiSelect ? labels.join(', ') : (labels[0] ?? '')
}

function QuestionFlow({
  request,
  questions,
  submit,
}: {
  request: Extract<WireRequest, { kind: 'permission' }>
  questions: WireQuestion[]
  submit: TraySubmit
}): React.ReactNode {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [other, setOther] = useState('')
  const question = questions[index]!

  function answer(labels: string[], otherText: string): void {
    const text = serializeAnswer(question, labels, otherText)
    if (!text) return
    const next = { ...answers, [question.question]: text }
    if (index + 1 < questions.length) {
      setAnswers(next)
      setIndex(index + 1)
      setOther('')
      return
    }
    const annotations: Record<string, { preview?: string }> = {}
    const chosen = question.options.find(option => option.label === text)
    if (chosen?.preview)
      annotations[question.question] = { preview: chosen.preview }
    submit(request.requestId, {
      kind: 'permission',
      decision: {
        behavior: 'allow',
        updatedInput: {
          ...request.input,
          answers: next,
          ...(Object.keys(annotations).length ? { annotations } : {}),
        },
      },
    })
  }

  const suffix =
    questions.length > 1 ? ` (${index + 1}/${questions.length})` : ''
  return (
    <PermissionDialog title={`Question${suffix}`} color="permission">
      <Box flexDirection="column" paddingTop={1}>
        <Text bold>{question.header}</Text>
        <Text>{question.question}</Text>
        <Box paddingTop={1}>
          {question.multiSelect ? (
            <SelectMulti
              options={question.options.map(option => ({
                label: option.label,
                value: option.label,
                description: option.description,
              }))}
              submitButtonText="Submit"
              onSubmit={(values: string[]) => answer(values, other)}
              onCancel={() => answer([], other)}
            />
          ) : (
            <Select
              options={[
                ...question.options.map(option => ({
                  label: option.label,
                  value: option.label,
                  description: option.description,
                })),
                { label: 'Other…', value: OTHER },
              ]}
              onChange={(value: string) => {
                if (value !== OTHER) answer([value], '')
                else setOther('__typing__')
              }}
              onCancel={() =>
                submit(request.requestId, {
                  kind: 'permission',
                  decision: { behavior: 'deny', message: 'cancelled' },
                })
              }
            />
          )}
        </Box>
        {other !== '' && !question.multiSelect && (
          <Box paddingTop={1}>
            <LineInput
              value={other === '__typing__' ? '' : other}
              onChange={setOther}
              onSubmit={text => answer([OTHER], text)}
              placeholder="Type an answer"
            />
          </Box>
        )}
      </Box>
    </PermissionDialog>
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
    return (
      <QuestionFlow
        request={request}
        questions={ui.questions}
        submit={submit}
      />
    )
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

  if (ui?.kind === 'plan') {
    return (
      <PermissionDialog title={`Plan${queuedNote}`} color="permission">
        <Box flexDirection="column" paddingTop={1} maxHeight={18}>
          <Markdown>{ui.planContent}</Markdown>
          <Box paddingTop={1}>
            <Select
              options={[
                {
                  label: 'Implement the plan — auto-accept edits',
                  value: 'acceptEdits',
                },
                { label: 'Keep planning', value: 'default' },
                { label: 'Deny', value: 'deny' },
              ]}
              onChange={(value: string) => {
                if (value === 'deny') {
                  allow({ behavior: 'deny', message: 'plan not approved' })
                  return
                }
                allow({
                  behavior: 'allow',
                  setMode: value as WirePermissionMode,
                })
              }}
              onCancel={() => allow({ behavior: 'deny', message: 'cancelled' })}
            />
          </Box>
        </Box>
      </PermissionDialog>
    )
  }

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
