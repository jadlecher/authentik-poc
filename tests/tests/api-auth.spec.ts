/**
 * api-auth.spec.ts — API negative/positive test suite.
 *
 * Tests the Go API's JWT authentication middleware through Traefik.
 * All requests go to http://app.localhost:8000/api/... (through Traefik).
 *
 * CONTRACT §9 — API neg/pos cases:
 *   1. No token → 401
 *   2. Malformed token (not a JWT) → 401
 *   3. Expired token (exp in past) → 401
 *   4. Wrong issuer → 401
 *   5. Wrong audience → 401
 *   6. Spoofed proxy header only (X-authentik-username, no Bearer) → 401
 *   7. Valid token → 200 with alice's email + is_admin=true
 *
 * For negative cases 3-5, we forge JWTs using a randomly generated RSA keypair
 * (via the `jose` library). The forged JWTs will fail BOTH:
 *   - Signature verification (wrong key vs authentik's JWKS)
 *   - AND the specific structural check (expired/wrong-iss/wrong-aud)
 * This is documented and expected per the task description.
 *
 * For case 7 (valid token), we obtain a REAL access token by:
 *   1. Launching a browser page and completing the full brokered login as alice.
 *   2. Extracting the access token from sessionStorage (oidc-client-ts storage key).
 *   3. Replaying it as Bearer in direct API requests.
 *
 * NOTE: The api-auth suite depends on the same global-setup that configures the
 * identification stage with the Dex source button.
 */
import { test, expect, request, APIRequestContext, BrowserContext } from '@playwright/test';
import { generateKeyPair, SignJWT } from 'jose';
import { brokeredLogin, getAccessTokenFromPage, ALICE_EMAIL } from './login-helpers';

const API_BASE = 'http://app.localhost:8000';
const CORRECT_ISSUER = 'http://auth.localhost:8000/application/o/app/';
const CORRECT_AUDIENCE = 'poc-api';

// ============================================================================
// Helpers
// ============================================================================

async function apiRequest(
  ctx: APIRequestContext,
  path: string,
  options: {
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
    data?: unknown;
  } = {}
): Promise<{ status: number; body: unknown }> {
  const method = options.method ?? 'GET';
  const response = await (method === 'GET'
    ? ctx.get(`${API_BASE}${path}`, { headers: options.headers ?? {} })
    : ctx.post(`${API_BASE}${path}`, {
        headers: options.headers ?? {},
        data: options.data,
      }));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text();
  }
  return { status: response.status(), body };
}

/**
 * Generate a random RSA key pair and create a signed JWT with given claims.
 * The JWT is signed by the test-generated key, NOT by authentik's private key,
 * so it will fail signature verification regardless of any claim issues.
 */
async function makeForgedJwt(overrides: {
  issuer?: string;
  audience?: string | string[];
  expiresIn?: string;
  subject?: string;
}): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256');
  const now = Math.floor(Date.now() / 1000);

  let jwt = new SignJWT({
    email: 'forged@test.local',
    groups: [],
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(overrides.subject ?? 'forged-sub')
    .setIssuedAt(now - 10);

  // Set issuer
  jwt = jwt.setIssuer(overrides.issuer ?? CORRECT_ISSUER);

  // Set audience
  const aud = overrides.audience ?? CORRECT_AUDIENCE;
  jwt = jwt.setAudience(aud);

  // Set expiry
  if (overrides.expiresIn === 'past') {
    // Already expired (10 seconds ago, issued 20 seconds ago)
    jwt = jwt.setNotBefore(now - 20);
    jwt = jwt.setExpirationTime(now - 10);
  } else {
    jwt = jwt.setExpirationTime('1h');
  }

  return jwt.sign(privateKey);
}

// ============================================================================
// Valid token acquisition via browser login
// ============================================================================

/**
 * Complete the full OIDC login flow as alice and return the access token.
 * Reuses the single shared, reliable login helper (see login-helpers.ts) so the
 * positive case is no longer a flaky second re-implementation of the flow.
 */
async function getAliceAccessToken(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    await brokeredLogin(page);
    const token = await getAccessTokenFromPage(page);
    console.log('[api-auth] Alice access token obtained (first 30 chars):', token.substring(0, 30) + '…');
    return token;
  } finally {
    await page.close();
  }
}

// ============================================================================
// Tests
// ============================================================================

test.describe('API authentication — negative cases (CONTRACT §9)', () => {
  let ctx: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    ctx = await playwright.request.newContext({ baseURL: API_BASE });
  });

  test.afterAll(async () => {
    await ctx.dispose();
  });

  // ─── Case 1: No token → 401 ───────────────────────────────────────────────
  test('GET /api/me — no token → 401', async () => {
    const { status, body } = await apiRequest(ctx, '/api/me');
    expect(status, `Expected 401, got ${status}. Body: ${JSON.stringify(body)}`).toBe(401);
    console.log('[api-auth] case 1 (no token):', status, JSON.stringify(body));
  });

  // ─── Case 2: Malformed token → 401 ───────────────────────────────────────
  test('GET /api/me — malformed token (not a JWT) → 401', async () => {
    const { status, body } = await apiRequest(ctx, '/api/me', {
      headers: { 'Authorization': 'Bearer not-a-jwt-at-all' },
    });
    expect(status, `Expected 401, got ${status}. Body: ${JSON.stringify(body)}`).toBe(401);
    console.log('[api-auth] case 2 (malformed token):', status, JSON.stringify(body));
  });

  // ─── Case 3: Expired token → 401 ─────────────────────────────────────────
  // The forged token uses exp in the past AND is signed with a random key.
  // It will fail BOTH expiry check AND signature verification.
  // The API must reject it with 401 regardless of which check fires first.
  test('GET /api/me — expired token → 401', async () => {
    const expired = await makeForgedJwt({ expiresIn: 'past' });
    const { status, body } = await apiRequest(ctx, '/api/me', {
      headers: { 'Authorization': `Bearer ${expired}` },
    });
    expect(status, `Expected 401, got ${status}. Body: ${JSON.stringify(body)}`).toBe(401);
    console.log('[api-auth] case 3 (expired token):', status, JSON.stringify(body));
  });

  // ─── Case 4: Wrong issuer → 401 ──────────────────────────────────────────
  test('GET /api/me — wrong issuer → 401', async () => {
    const wrongIss = await makeForgedJwt({ issuer: 'http://evil.example.com/oidc/' });
    const { status, body } = await apiRequest(ctx, '/api/me', {
      headers: { 'Authorization': `Bearer ${wrongIss}` },
    });
    expect(status, `Expected 401, got ${status}. Body: ${JSON.stringify(body)}`).toBe(401);
    console.log('[api-auth] case 4 (wrong issuer):', status, JSON.stringify(body));
  });

  // ─── Case 5: Wrong audience → 401 ────────────────────────────────────────
  test('GET /api/me — wrong audience → 401', async () => {
    const wrongAud = await makeForgedJwt({ audience: 'wrong-audience' });
    const { status, body } = await apiRequest(ctx, '/api/me', {
      headers: { 'Authorization': `Bearer ${wrongAud}` },
    });
    expect(status, `Expected 401, got ${status}. Body: ${JSON.stringify(body)}`).toBe(401);
    console.log('[api-auth] case 5 (wrong audience):', status, JSON.stringify(body));
  });

  // ─── Case 6: Spoofed proxy header only (no Bearer) → 401 ─────────────────
  // Proves the API NEVER trusts X-authentik-* headers as authentication.
  // Even a full set of proxy identity headers with NO Bearer token must yield 401.
  test('GET /api/me — spoofed X-authentik-* headers only (no Bearer) → 401', async () => {
    const { status, body } = await apiRequest(ctx, '/api/me', {
      headers: {
        'X-authentik-username': 'alice@example.com',
        'X-authentik-groups': 'admins',
        'X-authentik-email': 'alice@example.com',
        'X-authentik-name': 'Alice',
        'X-authentik-uid': 'alice-uid-spoof',
        // Deliberately NO Authorization: Bearer header
      },
    });
    expect(status, `Expected 401, got ${status}. Body: ${JSON.stringify(body)}`).toBe(401);
    console.log('[api-auth] case 6 (spoofed proxy headers):', status, JSON.stringify(body));
  });
});

test.describe('API authentication — positive case (CONTRACT §9)', () => {
  let validToken: string;

  // Obtain a real token by completing the full OIDC flow in a browser.
  // This runs once and the token is reused for all positive assertions.
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    try {
      validToken = await getAliceAccessToken(context);
    } finally {
      await context.close();
    }
  });

  // ─── Case 7: Valid token → 200 with alice's data ──────────────────────────
  test('GET /api/me — valid token → 200, alice@example.com, is_admin=true', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/me`, {
      headers: { 'Authorization': `Bearer ${validToken}` },
    });

    expect(response.status(), `Expected 200, got ${response.status()}`).toBe(200);

    const body = await response.json() as {
      email?: string;
      is_admin?: boolean;
      groups?: string[];
      sub?: string;
    };

    console.log('[api-auth] case 7 (valid token): status', response.status(), 'body', JSON.stringify(body));

    // Assert required fields
    expect(body.email).toBe(ALICE_EMAIL);
    expect(body.is_admin).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.groups).toContain('admins');
    expect(typeof body.sub).toBe('string');
    expect(body.sub!.length).toBeGreaterThan(0);
  });

  // ─── Case 7b: GET /api/todos — valid token → 200 ─────────────────────────
  test('GET /api/todos — valid token → 200 array', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/todos`, {
      headers: { 'Authorization': `Bearer ${validToken}` },
    });
    expect(response.status(), `Expected 200, got ${response.status()}`).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    console.log('[api-auth] case 7b (todos valid token): status', response.status(), 'count', (body as unknown[]).length);
  });

  // ─── Case 7c: GET /api/todos — no token → 401 ────────────────────────────
  test('GET /api/todos — no token → 401', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/todos`);
    expect(response.status()).toBe(401);
    console.log('[api-auth] case 7c (todos no token):', response.status());
  });
});
