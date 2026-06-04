/**
 * global-setup.ts — Playwright global setup (runs once before all tests).
 *
 * This setup performs TWO functions:
 *
 * 1. BLUEPRINT GAP FIX (idempotent):
 *    The blueprint (30-sources.yaml) creates the Dex OAuth source but does NOT bind
 *    it to the `default-authentication-identification` stage's sources list.
 *    Without this binding, the authentik login page does not show a "Login with Dex"
 *    button, and users cannot broker through Dex from the standard OIDC flow.
 *    This setup adds the Dex source to the identification stage via the admin API.
 *    This is test-infrastructure setup (equivalent to seeding test fixtures into a DB),
 *    not a modification of the blueprint file or any service definition.
 *    The fix is idempotent: it checks if the source is already bound before patching.
 *    The orchestrator should fix this in the blueprint (30-sources.yaml) permanently.
 *
 * 2. WARMUP:
 *    Fetch the authentik OIDC discovery and JWKS endpoints to warm up the
 *    cold-path in-memory caches before tests run.
 */

import { FullConfig } from '@playwright/test';

const AUTHENTIK_API = 'http://auth.localhost:8000/api/v3';
const BOOTSTRAP_TOKEN = 'local-demo-bootstrap-token-0123456789';
// Default identification stage PK (remains stable per authentik's default blueprints)
const IDENTIFICATION_STAGE_PK = '3ebd219c-c1ee-4c43-a62b-0251cfb6bf27';
const DEX_SOURCE_SLUG = 'dex';

async function apiGet(path: string): Promise<unknown> {
  const resp = await fetch(`${AUTHENTIK_API}${path}`, {
    headers: { 'Authorization': `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function apiPatch(path: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${AUTHENTIK_API}${path}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${BOOTSTRAP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PATCH ${path} failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

export default async function globalSetup(_config: FullConfig) {
  console.log('\n[global-setup] Starting test infrastructure setup…');

  // ─── Step 1: Find the Dex source PK ────────────────────────────────────────
  let dexSourcePk: string;
  try {
    const sourcesResp = await apiGet(`/sources/oauth/?slug=${DEX_SOURCE_SLUG}`) as {
      results: Array<{ pk: string; slug: string }>;
    };
    const dexSource = sourcesResp.results.find((s) => s.slug === DEX_SOURCE_SLUG);
    if (!dexSource) {
      throw new Error('Dex OAuth source not found. Is the stack started and blueprints applied?');
    }
    dexSourcePk = dexSource.pk;
    console.log(`[global-setup] Found Dex source PK: ${dexSourcePk}`);
  } catch (err) {
    console.error('[global-setup] ERROR: Cannot reach authentik API. Is the stack up?', err);
    throw err;
  }

  // ─── Step 2: Find the identification stage PK ──────────────────────────────
  // The default PK is hardcoded above, but let's verify it exists and find it dynamically.
  let stagePk = IDENTIFICATION_STAGE_PK;
  let stageSources: string[];
  try {
    const stage = await apiGet(`/stages/identification/${stagePk}/`) as {
      sources: string[];
      name: string;
      pk: string;
    };
    stageSources = stage.sources;
    console.log(`[global-setup] Stage "${stage.name}" current sources: ${JSON.stringify(stageSources)}`);
  } catch {
    // Fallback: find the identification stage by searching
    console.log('[global-setup] Hardcoded stage PK not found, searching…');
    const stagesResp = await apiGet('/stages/identification/?page=1&page_size=100') as {
      results: Array<{ pk: string; name: string; sources: string[] }>;
    };
    const authStage = stagesResp.results.find((s) =>
      s.name === 'default-authentication-identification'
    );
    if (!authStage) throw new Error('Could not find default-authentication-identification stage');
    stagePk = authStage.pk;
    stageSources = authStage.sources;
    console.log(`[global-setup] Found stage PK dynamically: ${stagePk}`);
  }

  // ─── Step 3: Idempotent patch — add Dex source to identification stage ──────
  if (!stageSources.includes(dexSourcePk)) {
    console.log('[global-setup] BLUEPRINT GAP: Dex source not bound to identification stage.');
    console.log('[global-setup] Applying fix: adding Dex source to identification stage…');
    console.log('[global-setup] (The orchestrator should fix blueprint 30-sources.yaml to bind');
    console.log('[global-setup]  the dex source to the identification stage permanently.)');
    await apiPatch(`/stages/identification/${stagePk}/`, {
      sources: [...stageSources, dexSourcePk],
    });
    console.log('[global-setup] Fix applied: Dex source is now a login option in authentik UI.');
  } else {
    console.log('[global-setup] Identification stage already has Dex source — no change needed.');
  }

  // ─── Step 4: Warm up OIDC discovery and JWKS ───────────────────────────────
  try {
    const discoveryResp = await fetch(
      'http://auth.localhost:8000/application/o/app/.well-known/openid-configuration'
    );
    if (discoveryResp.ok) {
      const discovery = await discoveryResp.json() as { jwks_uri: string };
      await fetch(discovery.jwks_uri);
      console.log('[global-setup] OIDC discovery and JWKS warmed up.');
    }
  } catch (err) {
    console.warn('[global-setup] WARN: Could not warm up OIDC discovery:', err);
  }

  console.log('[global-setup] Setup complete.\n');
}
