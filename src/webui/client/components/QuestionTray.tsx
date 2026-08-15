import { useState } from 'react'
import type { WebPermissionRequest } from '../../protocol/attachSchemas.js'

/**
 * The browser surface for AskUserQuestion.
 *
 * The tool always asks, and the terminal answers it by allowing with an
 * enriched input rather than by returning a boolean. This sends the same shape,
 * so `AskUserQuestionTool.call()` receives real answers instead of the empty
 * record a bare allow leaves behind.
 */

type Option = { label: string; description: string; preview?: string }
type Question = {
  question: string
  header: string
  options: Option[]
  multiSelect?: boolean
}

/** The free-text row the terminal always appends. */
const OTHER = 'Other'

export function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is Question =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Question).question === 'string' &&
      Array.isArray((entry as Question).options),
  )
}

type Answer = { labels: string[]; other: string }

/**
 * Serializes one answer the way the terminal does: a label, several labels
 * joined by a comma, or the typed text.
 */
export function serializeAnswer(question: Question, answer: Answer): string {
  if (answer.labels.includes(OTHER)) return answer.other.trim()
  return question.multiSelect
    ? answer.labels.join(', ')
    : (answer.labels[0] ?? '')
}

export function QuestionTray({
  request,
  queued,
  onAnswer,
  onCancel,
}: {
  request: WebPermissionRequest
  queued: number
  onAnswer(updatedInput: Record<string, unknown>): void
  onCancel(): void
}): React.ReactElement {
  const questions = parseQuestions(request.input)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})

  function answerFor(question: Question): Answer {
    return answers[question.question] ?? { labels: [], other: '' }
  }

  function choose(question: Question, label: string): void {
    setAnswers(current => {
      const existing = current[question.question] ?? { labels: [], other: '' }
      const has = existing.labels.includes(label)
      // Multi-select toggles. Anything else replaces, including Other, which
      // must not sit alongside a real option.
      const labels = question.multiSelect
        ? has
          ? existing.labels.filter(l => l !== label)
          : [...existing.labels, label]
        : [label]
      return { ...current, [question.question]: { ...existing, labels } }
    })
  }

  function setOther(question: Question, text: string): void {
    setAnswers(current => {
      const existing = current[question.question] ?? { labels: [], other: '' }
      return {
        ...current,
        [question.question]: { ...existing, other: text },
      }
    })
  }

  const resolved = questions.map(question => ({
    question,
    text: serializeAnswer(question, answerFor(question)),
  }))
  const complete =
    resolved.length > 0 && resolved.every(entry => entry.text.length > 0)

  function submit(): void {
    const answered: Record<string, string> = {}
    const annotations: Record<string, { preview?: string }> = {}
    for (const { question, text } of resolved) {
      answered[question.question] = text
      const chosen = question.options.find(option => option.label === text)
      if (chosen?.preview)
        annotations[question.question] = {
          preview: chosen.preview,
        }
    }
    onAnswer({
      ...request.input,
      answers: answered,
      ...(Object.keys(annotations).length ? { annotations } : {}),
    })
  }

  return (
    <section className="tray" role="alertdialog" aria-label="Question">
      <header className="tray__head">
        <span className="tray__tool">question</span>
        {queued > 1 ? (
          <span className="tray__queued">+{queued - 1} waiting</span>
        ) : null}
      </header>

      {questions.map(question => {
        const answer = answerFor(question)
        const otherPicked = answer.labels.includes(OTHER)
        return (
          <div className="question" key={question.question}>
            <span className="question__header">{question.header}</span>
            <p className="question__text">{question.question}</p>
            <ul className="question__options">
              {question.options.map(option => {
                const picked = answer.labels.includes(option.label)
                return (
                  <li key={option.label}>
                    <button
                      type="button"
                      className={`question__option ${picked ? 'is-picked' : ''}`}
                      onClick={() => choose(question, option.label)}
                    >
                      <span className="question__label">{option.label}</span>
                      <span className="question__desc">
                        {option.description}
                      </span>
                    </button>
                    {picked && option.preview ? (
                      <pre className="question__preview">{option.preview}</pre>
                    ) : null}
                  </li>
                )
              })}
              <li>
                <button
                  type="button"
                  className={`question__option ${otherPicked ? 'is-picked' : ''}`}
                  onClick={() => choose(question, OTHER)}
                >
                  <span className="question__label">{OTHER}</span>
                </button>
                {otherPicked ? (
                  <input
                    className="question__other"
                    value={answer.other}
                    placeholder="Your answer"
                    onChange={event => setOther(question, event.target.value)}
                  />
                ) : null}
              </li>
            </ul>
          </div>
        )
      })}

      <div className="tray__actions">
        <button type="button" className="btn btn--deny" onClick={onCancel}>
          cancel
        </button>
        <button
          type="button"
          className="btn btn--allow"
          onClick={submit}
          disabled={!complete}
        >
          submit
        </button>
      </div>
    </section>
  )
}
