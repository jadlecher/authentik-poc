/**
 * App.tsx — root component.
 *
 * Routing is minimal:
 *   /callback  — react-oidc-context handles the OIDC callback automatically
 *                when it detects the `code` query param. onSigninCallback in
 *                oidcConfig.ts redirects to "/" after processing.
 *   /          — main application view (login or authenticated content)
 *
 * nginx is configured with `try_files $uri /index.html` so ALL paths (including
 * /callback) serve this HTML file, allowing react-oidc-context to process them.
 */
import { useAuth } from 'react-oidc-context'
import { AuthenticatedApp } from './components/AuthenticatedApp'

export default function App() {
  const auth = useAuth()

  if (auth.isLoading) {
    return (
      <div>
        <h1>authentik PoC SPA</h1>
        <p>Loading…</p>
      </div>
    )
  }

  if (auth.error) {
    return (
      <div>
        <h1>authentik PoC SPA</h1>
        <p className="error">Authentication error: {auth.error.message}</p>
        <button
          className="primary"
          onClick={() => void auth.signinRedirect()}
        >
          Try again
        </button>
      </div>
    )
  }

  if (!auth.isAuthenticated) {
    return (
      <div>
        <h1>authentik PoC SPA</h1>
        <p>You are not logged in.</p>
        <button
          className="primary"
          onClick={() => void auth.signinRedirect()}
        >
          Login
        </button>
      </div>
    )
  }

  return <AuthenticatedApp />
}
