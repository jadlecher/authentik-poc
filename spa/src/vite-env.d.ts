/// <reference types="vite/client" />

/**
 * OIDC configuration exposed as Vite build-time env vars (CONTRACT §7).
 * Values are read from .env at build time and baked into the JS bundle.
 * These are NOT secrets — this is a public OIDC client (PKCE, no client_secret).
 */
interface ImportMetaEnv {
  readonly VITE_OIDC_AUTHORITY: string
  readonly VITE_OIDC_CLIENT_ID: string
  readonly VITE_OIDC_REDIRECT_URI: string
  readonly VITE_OIDC_POST_LOGOUT_REDIRECT_URI: string
  readonly VITE_OIDC_SCOPE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
