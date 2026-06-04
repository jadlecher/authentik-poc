/**
 * api-negative.spec.ts — API negative test suite (no browser, no auth required).
 *
 * All 6 negative cases from CONTRACT §9 that can run without the full brokered login:
 *   1. No token → 401
 *   2. Malformed token → 401
 *   3. Expired token → 401 (forged JWT with exp in past; also fails signature)
 *   4. Wrong issuer → 401 (forged JWT with wrong iss; also fails signature)
 *   5. Wrong audience → 401 (forged JWT with wrong aud; also fails signature)
 *   6. Spoofed X-authentik-* proxy headers (no Bearer) → 401
 *
 * All requests go to http://app.localhost:8000/api/... (through Traefik).
 * No global-setup is required for these tests.
 *
 * NOTE on forged JWTs (cases 3-5):
 *   Forged tokens are signed with a randomly generated RSA keypair.
 *   They will fail BOTH the specific structural check (exp/iss/aud) AND signature
 *   verification against authentik's JWKS. The API must return 401 regardless of
 *   which check fires first. This is documented and expected per the task description.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { generateKeyPair, SignJWT } from 'jose';

const API_BASE = 'http://app.localhost:8000';
const CORRECT_ISSUER = 'http://auth.localhost:8000/application/o/app/';
const CORRECT_AUDIENCE = 'poc-api';

// ─── JWT forge helper ──────────────────────────────────────────────────────────

async function makeForgedJwt(opts: {
  issuer?: string;
  audience?: string | string[];
  expired?: boolean;
  subject?: string;
}): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256');
  const now = Math.floor(Date.now() / 1000);

  const builder = new SignJWT({ email: 'forged@test.local', groups: [] })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(opts.subject ?? 'forged-sub')
    .setIssuer(opts.issuer ?? CORRECT_ISSUER)
    .setAudience(opts.audience ?? CORRECT_AUDIENCE)
    .setIssuedAt(now - 30);

  if (opts.expired) {
    return builder.setNotBefore(now - 20).setExpirationTime(now - 10).sign(privateKey);
  }
  return builder.setExpirationTime('1h').sign(privateKey);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test.describe('API authentication — 6 negative cases (CONTRACT §9)', () => {
  let ctx: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    ctx = await playwright.request.newContext({ baseURL: API_BASE });
  });

  test.afterAll(async () => {
    await ctx.dispose();
  });

  // 1. No token ────────────────────────────────────────────────────────────────
  test('case 1: GET /api/me — no token → 401', async () => {
    const resp = await ctx.get(`${API_BASE}/api/me`);
    let body: unknown;
    try { body = await resp.json(); } catch { body = await resp.text(); }
    console.log('[neg-1] status:', resp.status(), 'body:', JSON.stringify(body));
    expect(resp.status()).toBe(401);
  });

  // 2. Malformed token ─────────────────────────────────────────────────────────
  test('case 2: GET /api/me — malformed token → 401', async () => {
    const resp = await ctx.get(`${API_BASE}/api/me`, {
      headers: { 'Authorization': 'Bearer not-a-jwt-at-all' },
    });
    let body: unknown;
    try { body = await resp.json(); } catch { body = await resp.text(); }
    console.log('[neg-2] status:', resp.status(), 'body:', JSON.stringify(body));
    expect(resp.status()).toBe(401);
  });

  // 3. Expired token ───────────────────────────────────────────────────────────
  // Forged with exp in the past AND signed with random key.
  // Fails BOTH expiry check AND signature verification. API must return 401.
  test('case 3: GET /api/me — expired JWT → 401', async () => {
    const token = await makeForgedJwt({ expired: true });
    const resp = await ctx.get(`${API_BASE}/api/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    let body: unknown;
    try { body = await resp.json(); } catch { body = await resp.text(); }
    console.log('[neg-3] status:', resp.status(), 'body:', JSON.stringify(body));
    expect(resp.status()).toBe(401);
  });

  // 4. Wrong issuer ────────────────────────────────────────────────────────────
  test('case 4: GET /api/me — wrong issuer → 401', async () => {
    const token = await makeForgedJwt({ issuer: 'http://evil.example.com/oidc/' });
    const resp = await ctx.get(`${API_BASE}/api/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    let body: unknown;
    try { body = await resp.json(); } catch { body = await resp.text(); }
    console.log('[neg-4] status:', resp.status(), 'body:', JSON.stringify(body));
    expect(resp.status()).toBe(401);
  });

  // 5. Wrong audience ──────────────────────────────────────────────────────────
  test('case 5: GET /api/me — wrong audience → 401', async () => {
    const token = await makeForgedJwt({ audience: 'wrong-service-not-poc-api' });
    const resp = await ctx.get(`${API_BASE}/api/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    let body: unknown;
    try { body = await resp.json(); } catch { body = await resp.text(); }
    console.log('[neg-5] status:', resp.status(), 'body:', JSON.stringify(body));
    expect(resp.status()).toBe(401);
  });

  // 6. Spoofed X-authentik-* proxy headers — NO Bearer token ──────────────────
  // Proves the API NEVER trusts proxy identity headers as authentication.
  test('case 6: GET /api/me — spoofed X-authentik-* headers only → 401', async () => {
    const resp = await ctx.get(`${API_BASE}/api/me`, {
      headers: {
        'X-authentik-username': 'alice@example.com',
        'X-authentik-groups': 'admins',
        'X-authentik-email': 'alice@example.com',
        'X-authentik-name': 'Alice Admin',
        'X-authentik-uid': 'alice-uid-spoof-attempt',
        // Deliberately NO Authorization: Bearer header
      },
    });
    let body: unknown;
    try { body = await resp.json(); } catch { body = await resp.text(); }
    console.log('[neg-6] status:', resp.status(), 'body:', JSON.stringify(body));
    expect(resp.status()).toBe(401);
  });

  // Additional: GET /api/todos — no token → 401
  test('GET /api/todos — no token → 401', async () => {
    const resp = await ctx.get(`${API_BASE}/api/todos`);
    console.log('[neg-todos] status:', resp.status());
    expect(resp.status()).toBe(401);
  });
});
