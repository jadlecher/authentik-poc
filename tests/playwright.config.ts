import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Playwright configuration for the authentik identity-broker PoC test suite.
 *
 * baseURL: http://app.localhost:8000 — the SPA served through Traefik.
 * auth.localhost:8000 — authentik (OIDC broker)
 * idp.localhost:8000  — Dex (upstream IdP)
 *
 * PREREQUISITE (applies once before tests):
 *   The authentik identification stage must have the Dex source bound to it so
 *   the "Login with Dex" button appears. This is a one-time idempotent fix for
 *   a blueprint gap in 30-sources.yaml. Run the setup script before tests:
 *
 *     node scripts/setup-authentik.js
 *
 *   The test:e2e Taskfile task runs this automatically. See scripts/setup-authentik.js.
 *
 * Timeouts are generous because:
 *   - authentik's cold OIDC paths can take 2-5 seconds per step
 *   - Dex login form rendering may be slow on first hit
 *   - The full brokered login flow spans 4 redirects across 3 origins
 *   - First-login enrollment creates the user account, adding latency
 */
export default defineConfig({
  testDir: './tests',
  /* Global setup: runs once before all tests to fix authentik configuration gaps */
  globalSetup: path.resolve(__dirname, './global-setup.ts'),
  /* Global timeout per test */
  timeout: 120_000,
  /* Expect timeout for individual assertions */
  expect: {
    timeout: 15_000,
  },
  /* Run tests in sequence (not parallel) — browser flows share session state */
  workers: 1,
  /* Retry once on failure to handle transient redirect timing issues */
  retries: 1,
  /* Reporter: list for CI output, html for local browsing */
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    /* Base URL for page.goto('/') calls */
    baseURL: 'http://app.localhost:8000',
    /* Always collect trace for debugging */
    trace: 'on-first-retry',
    /* Capture screenshots on failure */
    screenshot: 'only-on-failure',
    /* Navigation timeout — authentik redirects can be slow */
    navigationTimeout: 60_000,
    /* Action timeout (clicks, fills, etc.) */
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /* Run headless; set PWHEADLESS=false to observe the browser */
        headless: true,
        /* Accept HTTP (no TLS in this PoC) */
        ignoreHTTPSErrors: true,
      },
    },
  ],
  /* Output directory for test artifacts (screenshots, traces) */
  outputDir: 'test-results',
});
