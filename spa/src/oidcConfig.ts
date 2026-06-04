/**
 * OIDC configuration for react-oidc-context / oidc-client-ts.
 *
 * All values come from Vite build-time env vars (VITE_OIDC_*) with the
 * CONTRACT §7 values as defaults so the app works even without a .env override.
 *
 * Token storage: oidc-client-ts defaults to sessionStorage (WebStorageStateStore).
 * sessionStorage is tab-scoped, never persisted to disk, and cleared on tab close.
 * This is appropriate for a local PoC — no long-lived token persistence on disk.
 * If you need persistent login across tab closes, pass a custom userStore using
 * localStorage, but be aware of the XSS risk.
 *
 * The client is PUBLIC (no secret). PKCE S256 is negotiated automatically by
 * oidc-client-ts when response_type=code and no client_secret is provided.
 */
import type { AuthProviderProps } from 'react-oidc-context'

export const oidcConfig: AuthProviderProps = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI,
  post_logout_redirect_uri: import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI,
  scope: import.meta.env.VITE_OIDC_SCOPE,
  response_type: 'code',
  // Automatically redirect back to "/" after the callback is processed.
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, '/')
  },
}
