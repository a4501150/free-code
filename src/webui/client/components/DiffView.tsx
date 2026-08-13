import { useMemo } from 'react'
import { diffLines } from 'diff'

/**
 * A line diff with gutter numbers, the way the terminal shows an edit.
 * Deliberately not word-level: a phone screen cannot show that usefully.
 */
export function DiffView({
  before,
  after,
}: {
  before: string
  after: string
}): React.ReactElement {
  const rows = useMemo(() => {
    const out: Array<{
      sign: ' ' | '+' | '-'
      text: string
      oldNo?: number
      newNo?: number
    }> = []
    let oldNo = 1
    let newNo = 1

    for (const part of diffLines(before, after)) {
      const lines = part.value.split('\n')
      if (lines.at(-1) === '') lines.pop()
      for (const text of lines) {
        if (part.added) out.push({ sign: '+', text, newNo: newNo++ })
        else if (part.removed) out.push({ sign: '-', text, oldNo: oldNo++ })
        else out.push({ sign: ' ', text, oldNo: oldNo++, newNo: newNo++ })
      }
    }
    return out
  }, [before, after])

  return (
    <div className="diff">
      {rows.map((row, index) => (
        <div
          key={index}
          className={`diff__row ${
            row.sign === '+'
              ? 'is-add'
              : row.sign === '-'
                ? 'is-del'
                : 'is-same'
          }`}
        >
          <span className="diff__no">{row.oldNo ?? ''}</span>
          <span className="diff__no">{row.newNo ?? ''}</span>
          <span className="diff__sign">{row.sign}</span>
          <span className="diff__text">{row.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
