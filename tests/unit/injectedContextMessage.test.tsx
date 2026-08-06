import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { InjectedContextMessage } from '../../src/components/messages/InjectedContextMessage.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'

const BODY = `The task tools haven't been used recently.
Consider using TaskCreate.
<task-id>abc</task-id>`

describe('InjectedContextMessage', () => {
  test('collapsed shows the label and line count, not the body', async () => {
    const rendered = await renderToAnsiString(
      <InjectedContextMessage
        addMargin={false}
        label="System reminder · task_reminder"
        content={BODY}
        verbose={false}
      />,
    )

    expect(rendered).toContain('System reminder · task_reminder')
    expect(rendered).toContain('(3 lines)')
    expect(rendered).not.toContain('TaskCreate')
    // Not the ⎿ tool-result glyph: these rows often have no parent line at
    // all, so a disclosure triangle is used instead.
    expect(rendered).toContain('▸')
    expect(rendered).not.toContain('⎿')
  })

  test('expanded shows the body verbatim, nested XML included', async () => {
    const rendered = await renderToAnsiString(
      <InjectedContextMessage
        addMargin={false}
        label="System reminder"
        content={BODY}
        verbose={true}
      />,
    )

    expect(rendered).toContain('TaskCreate')
    expect(rendered).toContain('▾')
    // Rendered as plain text, so notification metadata survives rather than
    // being interpreted as markup.
    expect(rendered).toContain('<task-id>abc</task-id>')
  })

  test('a single-line body is not pluralized', async () => {
    const rendered = await renderToAnsiString(
      <InjectedContextMessage
        addMargin={false}
        label="User context"
        content="just one line"
        verbose={false}
      />,
    )

    expect(rendered).toContain('(1 line)')
    expect(rendered).not.toContain('(1 lines)')
  })

  test('renders nothing when the body is blank', async () => {
    const rendered = await renderToAnsiString(
      <InjectedContextMessage
        addMargin={false}
        label="System reminder"
        content={'   \n  '}
        verbose={true}
      />,
    )

    expect(rendered.trim()).toBe('')
  })
})
