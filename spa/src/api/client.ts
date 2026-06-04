/**
 * Typed API client wrapping openapi-fetch.
 *
 * Types are generated from api/openapi/openapi.yaml via:
 *   npm run gen:api
 * which runs `openapi-typescript ../api/openapi/openapi.yaml -o src/api/schema.d.ts`
 *
 * IMPORTANT: We always send the ACCESS token (auth.user.access_token), NOT the
 * id_token. The Go API validates the access token's aud=poc-api, iss, and RS256
 * signature. The id_token is for the client only (user identity display).
 *
 * Tokens are NEVER logged. The Authorization header is set programmatically.
 */
import createClient from 'openapi-fetch'
import type { paths } from './schema.d.ts'

/**
 * Create a new API client that attaches the provided access token as Bearer.
 * Call this once per render cycle where you have auth.user available.
 */
export function createApiClient(accessToken: string) {
  const client = createClient<paths>({
    baseUrl: '/',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  return client
}
