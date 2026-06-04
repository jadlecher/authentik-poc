/**
 * ApiProfile — fetches GET /api/me using the access token.
 *
 * Demonstrates that the Go API correctly validates the JWT and returns
 * server-side profile data derived from the access token claims.
 *
 * The access token is sent as Authorization: Bearer <access_token>.
 * It is NEVER logged.
 */
import { useEffect, useState } from 'react'
import { createApiClient } from '../api/client'
import type { components } from '../api/schema.d.ts'

type User = components['schemas']['User']

interface Props {
  accessToken: string
}

export function ApiProfile({ accessToken }: Props) {
  const [profile, setProfile] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!accessToken) return

    const client = createApiClient(accessToken)
    setLoading(true)
    setError(null)

    client.GET('/api/me')
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(typeof apiError === 'object' && 'error' in apiError
            ? String((apiError as { error: unknown }).error)
            : 'Unknown error')
        } else if (data) {
          setProfile(data)
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Network error')
      })
      .finally(() => setLoading(false))
  }, [accessToken])

  return (
    <div className="card">
      <h2>API Profile (GET /api/me)</h2>
      {loading && <p>Loading…</p>}
      {error && <p className="error">Error: {error}</p>}
      {profile && (
        <pre>{JSON.stringify(profile, null, 2)}</pre>
      )}
    </div>
  )
}
