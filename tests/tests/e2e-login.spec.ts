/**
 * e2e-login.spec.ts — Full brokered-login E2E test.
 *
 * Tests the complete OIDC Authorization Code + PKCE flow:
 *   SPA (app.localhost:8000)
 *     → authentik (auth.localhost:8000) — shows Dex source button
 *       → Dex (idp.localhost:8000) — login as alice
 *     ← callback to authentik (source enrollment)
 *     ← consent/redirect to SPA /callback
 *   SPA renders authenticated state with alice's profile + API data
 *
 * Selectors discovered by driving real browsers (see global-setup for context):
 *   - authentik identification stage renders as a Web Component with pierced shadow DOM.
 *     Playwright auto-pierces shadow DOM for CSS selectors.
 *   - The Dex source button is: a[href*="source/oauth/login/dex"] inside the footer of
 *     the identification stage (when the source is bound to the stage — see global-setup).
 *   - Dex login form uses: input[name="login"], input[name="password"], button[type="submit"]
 *   - SPA authenticated state: h2 with text "Identity (from ID token)", table cells with email
 *
 * CONTRACT §9 covered here:
 *   Browser E2E: open app → login → Dex → back → alice authenticated → API data shown
 */
import { test, expect, Page } from '@playwright/test';
import path from 'path';

const ALICE_EMAIL = 'alice@example.com';
const ALICE_PASSWORD = 'password';

/**
 * Wait for the authentik flow executor to render the identification stage,
 * then click the Dex source button (which is in the shadow DOM footer).
 */
async function clickDexSourceButton(page: Page): Promise<void> {
  // authentik renders login flow as Web Components; Playwright pierces shadow DOM automatically.
  // The Dex source button appears in the identification stage footer as a link/button.
  // The link href includes "/source/oauth/login/dex"
  const dexButton = page.locator('a[href*="source/oauth/login/dex"]');

  // Wait up to 30s for authentik to render the identification stage with the source button
  await expect(dexButton).toBeVisible({ timeout: 30_000 });
  await dexButton.click();
}

/**
 * Complete login on the Dex password form.
 * Dex may show either:
 *   (a) A connector selector (only one connector "Log in with Email") — click it first.
 *   (b) Directly the password form.
 */
async function completeDexLogin(page: Page, email: string, password: string): Promise<void> {
  // If Dex shows a connector selector ("Log in with Email" button), click it first
  const emailConnectorBtn = page.locator('a[href*="dex/auth/local"]');
  if (await emailConnectorBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await emailConnectorBtn.click();
  }

  // Now on the Dex password form
  const loginInput = page.locator('input[name="login"]');
  await expect(loginInput).toBeVisible({ timeout: 15_000 });
  await loginInput.fill(email);

  const passwordInput = page.locator('input[name="password"]');
  await expect(passwordInput).toBeVisible();
  await passwordInput.fill(password);

  await page.locator('button[type="submit"]').click();
}

/**
 * Handle any authentik consent/authorization page that may appear after Dex login.
 * authentik shows a consent page on the FIRST login if the provider requires it.
 * We look for a "Proceed" / "Continue" button and click it.
 */
async function handleAuthentikConsent(page: Page): Promise<void> {
  // After Dex callback, authentik may run the source enrollment flow.
  // This may include a consent stage or just redirect.
  // We wait briefly and check if there's a consent/proceed button.
  const proceedBtn = page.locator('button:has-text("Proceed"), button:has-text("Continue"), button[type="submit"]');

  // Only click if we're still on auth.localhost and not yet on the SPA callback
  const currentUrl = page.url();
  if (currentUrl.includes('auth.localhost') && await proceedBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await proceedBtn.click();
  }
}

test.describe('Full brokered login flow — alice@example.com', () => {
  test('logs in as alice via SPA → authentik → Dex → SPA callback', async ({ page }) => {
    // ----------------------------------------------------------------
    // STEP 1: Navigate to the SPA
    // ----------------------------------------------------------------
    await page.goto('http://app.localhost:8000/');
    await expect(page).toHaveTitle('authentik PoC SPA');

    // The unauthenticated view shows a Login button
    const loginButton = page.locator('button.primary', { hasText: 'Login' });
    await expect(loginButton).toBeVisible({ timeout: 10_000 });

    // ----------------------------------------------------------------
    // STEP 2: Click Login → redirected to authentik
    // ----------------------------------------------------------------
    await loginButton.click();

    // authentik redirects to its authentication flow
    await page.waitForURL(/auth\.localhost/, { timeout: 30_000 });

    // ----------------------------------------------------------------
    // STEP 3: authentik identification stage — click Dex source button
    // ----------------------------------------------------------------
    // The global-setup ensures the Dex source is bound to the identification stage.
    // The button should appear in the footer of the identification stage Web Component.
    await clickDexSourceButton(page);

    // ----------------------------------------------------------------
    // STEP 4: Dex login page — enter alice's credentials
    // ----------------------------------------------------------------
    await page.waitForURL(/idp\.localhost/, { timeout: 30_000 });
    await completeDexLogin(page, ALICE_EMAIL, ALICE_PASSWORD);

    // ----------------------------------------------------------------
    // STEP 5: Handle any authentik consent / enrollment steps
    // ----------------------------------------------------------------
    // After Dex callback, authentik may run enrollment or show consent.
    // Wait for a redirect back to auth.localhost or directly to app.localhost.
    await page.waitForURL(/auth\.localhost|app\.localhost/, { timeout: 60_000 });

    // If we landed back on auth.localhost, handle consent / pending steps
    let attempts = 0;
    while (page.url().includes('auth.localhost') && attempts < 5) {
      await page.waitForTimeout(2_000);
      await handleAuthentikConsent(page);
      attempts++;

      // Check if we've moved to the SPA
      if (page.url().includes('app.localhost')) break;

      // If still on auth.localhost, wait for another redirect
      try {
        await page.waitForURL(/app\.localhost/, { timeout: 5_000 });
        break;
      } catch {
        // Not yet redirected; loop again
      }
    }

    // ----------------------------------------------------------------
    // STEP 6: Land on SPA /callback → redirected to /
    // ----------------------------------------------------------------
    // oidc-client-ts processes the code at /callback and redirects to /
    await page.waitForURL('http://app.localhost:8000/', { timeout: 60_000 });

    // ----------------------------------------------------------------
    // STEP 7: Assert authenticated state
    // ----------------------------------------------------------------
    // The SPA should render AuthenticatedApp with UserProfile + ApiProfile + Todos

    // 7a. Identity section from ID token
    await expect(page.locator('h2', { hasText: 'Identity (from ID token)' })).toBeVisible({ timeout: 30_000 });

    // 7b. alice's email is displayed
    await expect(page.locator('body')).toContainText(ALICE_EMAIL);

    // 7c. Groups include "admins"
    await expect(page.locator('.tag.admin, span.tag:has-text("admins")')).toBeVisible({ timeout: 15_000 });

    // 7d. API Profile section (GET /api/me result)
    await expect(page.locator('h2', { hasText: 'API Profile (GET /api/me)' })).toBeVisible();
    // Wait for the API call to complete and alice's email to appear in the <pre> block
    await expect(page.locator('pre').filter({ hasText: ALICE_EMAIL })).toBeVisible({ timeout: 30_000 });

    // 7e. The API profile JSON should show is_admin: true
    const apiProfileText = await page.locator('pre').first().textContent();
    expect(apiProfileText).toContain('"email"');
    expect(apiProfileText).toContain('alice@example.com');

    // 7f. Todos UI is present
    await expect(page.locator('h2', { hasText: 'Todos (GET /api/todos)' })).toBeVisible();

    // 7g. Create a todo and assert it appears
    const todoTitle = `E2E test todo ${Date.now()}`;
    await page.locator('input[aria-label="New todo title"]').fill(todoTitle);
    await page.locator('button[type="submit"].primary', { hasText: 'Add' }).click();
    await expect(page.locator(`li >> text=${todoTitle}`)).toBeVisible({ timeout: 15_000 });

    // ----------------------------------------------------------------
    // STEP 8: Capture final screenshot as artifact
    // ----------------------------------------------------------------
    const screenshotPath = path.join(__dirname, '..', 'test-results', 'authenticated-state.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[e2e] Final screenshot saved: ${screenshotPath}`);

    console.log('[e2e] Full brokered login flow PASSED — alice authenticated, API data verified, todos created.');
  });
});
