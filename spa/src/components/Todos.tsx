/**
 * Todos — lists and creates todos via the Go API.
 *
 * GET /api/todos  — lists todos owned by the authenticated user (scoped by sub).
 * POST /api/todos — creates a new todo; owner is set server-side from JWT sub.
 *
 * The access token is sent as Authorization: Bearer <access_token>.
 * It is NEVER logged.
 */
import { useEffect, useState, useRef } from 'react'
import { createApiClient } from '../api/client'
import type { components } from '../api/schema.d.ts'

type Todo = components['schemas']['Todo']

interface Props {
  accessToken: string
}

export function Todos({ accessToken }: Props) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const fetchTodos = () => {
    if (!accessToken) return
    const client = createApiClient(accessToken)
    setLoading(true)
    setError(null)
    client.GET('/api/todos')
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(typeof apiError === 'object' && 'error' in apiError
            ? String((apiError as { error: unknown }).error)
            : 'Unknown error')
        } else if (data) {
          setTodos(data)
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Network error')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchTodos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken])

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title || !accessToken) return

    const client = createApiClient(accessToken)
    setCreating(true)
    setError(null)

    client.POST('/api/todos', {
      body: { title, done: false },
    })
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(typeof apiError === 'object' && 'error' in apiError
            ? String((apiError as { error: unknown }).error)
            : 'Unknown error')
        } else if (data) {
          setTodos(prev => [...prev, data])
          setNewTitle('')
          inputRef.current?.focus()
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Network error')
      })
      .finally(() => setCreating(false))
  }

  return (
    <div className="card">
      <h2>Todos (GET /api/todos)</h2>
      {error && <p className="error">Error: {error}</p>}

      <form onSubmit={handleCreate} style={{ marginBottom: '1rem' }}>
        <input
          ref={inputRef}
          type="text"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          placeholder="New todo title…"
          disabled={creating}
          aria-label="New todo title"
        />
        <button type="submit" className="primary" disabled={creating || !newTitle.trim()}>
          {creating ? 'Creating…' : 'Add'}
        </button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : todos.length === 0 ? (
        <p style={{ color: '#666' }}>No todos yet. Add one above.</p>
      ) : (
        <ul>
          {todos.map(todo => (
            <li key={todo.id}>
              <span style={{ textDecoration: todo.done ? 'line-through' : 'none' }}>
                {todo.title}
              </span>
              {todo.done && <span className="tag" style={{ marginLeft: '0.5rem' }}>done</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
