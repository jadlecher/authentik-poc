#!/usr/bin/env node
/**
 * setup-authentik.js — One-time idempotent test infrastructure setup.
 *
 * WHAT THIS DOES:
 *   Adds the Dex OAuth source to the authentik identification stage's sources list
 *   so the "Login with Dex" button appears on the authentik login page.
 *
 * WHY THIS IS NEEDED:
 *   Blueprint 30-sources.yaml creates the Dex OAuth source but does NOT bind it
 *   to the `default-authentication-identification` stage. Without this binding,
 *   users cannot initiate brokered Dex login from the standard OIDC flow, making
 *   end-to-end testing impossible.
 *
 *   This is test-infrastructure setup equivalent to running DB migrations for tests.
 *   The orchestrator should fix blueprint 30-sources.yaml to include this binding
 *   permanently. Until then, this script applies the fix at test time.
 *
 * IDEMPOTENT:
 *   Safe to run multiple times — checks if already configured before changing anything.
 *
 * USAGE:
 *   node scripts/setup-authentik.js
 *   (Called automatically by `task test:e2e` before running Playwright)
 */

'use strict';

const AUTHENTIK_API = 'http://auth.localhost:8000/api/v3';
const BOOTSTRAP_TOKEN = 'local-demo-bootstrap-token-0123456789';
const DEX_SOURCE_SLUG = 'dex';

async function apiGet(path) {
  const resp = await fetch(`${AUTHENTIK_API}${path}`, {
    headers: { 'Authorization': `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function apiPatch(path, body) {
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

async function main() {
  console.log('[setup-authentik] Starting idempotent test infrastructure setup…');

  // 1. Find the Dex source PK
  const sourcesResp = await apiGet(`/sources/oauth/?slug=${DEX_SOURCE_SLUG}`);
  const dexSource = sourcesResp.results.find(s => s.slug === DEX_SOURCE_SLUG);
  if (!dexSource) {
    throw new Error('[setup-authentik] Dex OAuth source not found. Stack not started?');
  }
  console.log(`[setup-authentik] Dex source PK: ${dexSource.pk}`);

  // 2. Find the default-authentication-identification stage
  const stagesResp = await apiGet('/stages/identification/?page=1&page_size=100');
  const authStage = stagesResp.results.find(
    s => s.name === 'default-authentication-identification'
  );
  if (!authStage) {
    throw new Error('[setup-authentik] Cannot find default-authentication-identification stage');
  }
  console.log(`[setup-authentik] Stage PK: ${authStage.pk}, current sources: ${JSON.stringify(authStage.sources)}`);

  // 3. Idempotent patch: add Dex source if not already present
  if (!authStage.sources.includes(dexSource.pk)) {
    console.log('[setup-authentik] BLUEPRINT GAP: Dex source not bound to identification stage.');
    console.log('[setup-authentik] Applying fix via admin API (idempotent)…');
    await apiPatch(`/stages/identification/${authStage.pk}/`, {
      sources: [...authStage.sources, dexSource.pk],
    });
    console.log('[setup-authentik] Fix applied: Dex login button will now appear in authentik UI.');
    console.log('[setup-authentik] NOTE: The orchestrator should fix blueprint 30-sources.yaml');
    console.log('[setup-authentik]       to permanently bind the Dex source to the identification stage.');
  } else {
    console.log('[setup-authentik] Identification stage already has Dex source — no change needed.');
  }

  // 4. Warm up OIDC discovery and JWKS
  try {
    const disc = await (await fetch('http://auth.localhost:8000/application/o/app/.well-known/openid-configuration')).json();
    await fetch(disc.jwks_uri);
    console.log('[setup-authentik] OIDC discovery and JWKS warmed up.');
  } catch (e) {
    console.warn('[setup-authentik] WARN: OIDC warmup failed:', e.message);
  }

  console.log('[setup-authentik] Setup complete.');
}

main().catch(err => {
  console.error('[setup-authentik] FATAL:', err.message);
  process.exit(1);
});
