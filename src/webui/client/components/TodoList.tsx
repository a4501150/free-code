import type { WebTodo } from '../../protocol/attachSchemas.js'

function box(status: string): string {
  if (status === 'completed') return '×'
  if (status === 'in_progress') return '·'
  return ' '
}

export function TodoList({ todos }: { todos: WebTodo[] }): React.ReactElement {
  const open = todos.filter(t => t.status !== 'completed')

  return (
    <section className="panel">
      <h2 className="panel__title">
        todos{' '}
        {open.length ? (
          <span className="panel__count">{open.length}</span>
        ) : null}
      </h2>
      {todos.length === 0 ? (
        <p className="panel__empty">None.</p>
      ) : (
        <ul className="todos">
          {todos.map((todo, index) => (
            <li key={index} className={`todo is-${todo.status}`}>
              <span className="todo__box">{box(todo.status)}</span>
              <span className="todo__text">
                {todo.status === 'in_progress' && todo.activeForm
                  ? todo.activeForm
                  : todo.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
