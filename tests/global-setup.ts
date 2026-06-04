/**
 * global-setup.ts — Playwright global setup (runs once before all tests).
 *
 * This setup performs WARMUP ONLY. It does NOT mutate any authentik or Dex
 * configuration.
 *
 * The PoC's hard requirement is that `task dev:clean && task dev && task validate`
 * works from a cold start with ZERO runtime config edits — every piece of identity
 * configuration must come from the mounted authentik blueprints and the Dex config
 * file. Earlier iterations of this file PATCHed the identification stage's source
 * binding and PUT the Dex source's consumer_secret; both were band-aids over real
 * bugs that are now fixed at the source:
 *   - The Dex source ↔ identification-stage binding lives in
 *     authentik/blueprints/30-sources.yaml.
 *   - The Dex client secret is inlined to the CONTRACT §3 value in dex/config.yml
 *     (Dex v2.41.1 does not expand `$DEX_CLIENT_SECRET`), matching the blueprint's
 *     consumer_secret byte-for-byte.
 * So this setup intentionally seeds nothing — it only warms cold caches.
 */

import { FullConfig } from '@playwright/test';

export default async function globalSetup(_config: FullConfig) {
  console.log('\n[global-setup] Warming OIDC discovery + JWKS (no config mutation)…');

  try {
    const discoveryResp = await fetch(
      'http://auth.localhost:8000/application/o/app/.well-known/openid-configuration'
    );
    if (discoveryResp.ok) {
      const discovery = await discoveryResp.json() as { jwks_uri: string };
      await fetch(discovery.jwks_uri);
      console.log('[global-setup] OIDC discovery and JWKS warmed up.');
    } else {
      console.warn(`[global-setup] WARN: discovery returned ${discoveryResp.status}.`);
    }
  } catch (err) {
    console.warn('[global-setup] WARN: Could not warm up OIDC discovery:', err);
  }

  console.log('[global-setup] Setup complete.\n');
}
