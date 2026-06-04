/**
 * AuthenticatedApp — shown when the user has a valid session.
 *
 * Displays:
 *   1. User identity from the ID token (email, name, groups).
 *   2. Profile from GET /api/me (server-side claims validation result).
 *   3. Todos list (GET /api/todos) + create form (POST /api/todos).
 *
 * IMPORTANT: The ACCESS token is sent to the API, NOT the id_token.
 * The id_token is used locally for display only (no server call with it).
 * Tokens are NEVER logged to the console.
 */
import { useAuth } from 'react-oidc-context'
import { UserProfile } from './UserProfile'
import { ApiProfile } from './ApiProfile'
import { Todos } from './Todos'

export function AuthenticatedApp() {
  const auth = useAuth()

  const handleLogout = () => {
    void auth.signoutRedirect()
  }

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>authentik PoC SPA</h1>
        <button className="danger" onClick={handleLogout}>Logout</button>
      </header>

      <UserProfile />
      <ApiProfile accessToken={auth.user?.access_token ?? ''} />
      <Todos accessToken={auth.user?.access_token ?? ''} />
    </div>
  )
}
