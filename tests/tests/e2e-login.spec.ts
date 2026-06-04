/**
 * e2e-login.spec.ts — Full brokered-login E2E test.
 *
 * Tests the complete OIDC Authorization Code + PKCE flow:
 *   SPA (app.localhost:8000)
 *     → authentik (auth.localhost:8000) — shows Dex source button
 *       → Dex (idp.localhost:8000) — login as alice
 *     ← callback to authentik (source enrollment/authentication flow)
 *     ← authentik may show an app consent page → click "Continue"
 *     ← redirect to SPA /callback → redirect to /
 *   SPA renders authenticated state with alice's profile + API data
 *
 * Selectors discovered by driving real browsers:
 *   - authentik 2024.12.3 renders the identification stage as <ak-stage-identification>
 *     with a shadow DOM. Playwright pierces shadow DOM for role/text locators.
 *   - Dex source button: <button type="button"> with <img alt="Dex"> inside (icon-only).
 *     Accessible name comes from img alt → getByRole('button', { name: 'Dex' }) works.
 *   - There is NO <a href*="source/oauth/login/dex"> — old selector was WRONG.
 *   - After Dex login, authentik shows a consent page with a "Continue"
 *     button (button[type="submit"] inside shadow DOM).
 *   - Dex login form: input[name="login"], input[name="password"], button[type="submit"]
 *   - SPA authenticated state: h2 with text "Identity (from ID token)", spans with class "tag admin"
 *   - The SPA renders both a "Groups" row (with "admins" tag) and a "Role" row (with "admin" tag).
 *     Use .first() on the groups tag locator to avoid strict-mode violation.
 *
 * CONTRACT §9 covered here:
 *   Browser E2E: open app → login → Dex → back → alice authenticated → API data shown
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import {
  clickDexSourceButton,
  completeDexLogin,
  handleAuthentikIntermediatePages,
  ALICE_EMAIL,
  ALICE_PASSWORD,
} from './login-helpers';

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
    // The global-setup ensures the Dex source is bound to the identification stage
    // and the consumer_secret matches Dex's actual secret.
    // The button appears in the footer of the identification stage Web Component.
    await clickDexSourceButton(page);

    // ----------------------------------------------------------------
    // STEP 4: Dex login page — enter alice's credentials
    // ----------------------------------------------------------------
    await page.waitForURL(/idp\.localhost/, { timeout: 30_000 });
    await completeDexLogin(page, ALICE_EMAIL, ALICE_PASSWORD);

    // ----------------------------------------------------------------
    // STEP 5: Handle any authentik consent / enrollment steps
    // ----------------------------------------------------------------
    // After Dex callback, authentik runs the source authentication flow.
    // For first-time users this includes enrollment. After that, authentik
    // may show a consent page ("Redirecting to PoC App - Continue").
    // We click through any intermediate pages until we land on app.localhost.
    await page.waitForURL(/auth\.localhost|app\.localhost/, { timeout: 60_000 });
    await handleAuthentikIntermediatePages(page);

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

    // 7c. Groups include "admins" — use .first() because the SPA renders both
    //     a "Groups" tag ("admins") and a "Role" tag ("admin") with class "tag admin".
    //     .first() avoids strict-mode violation from the dual match.
    await expect(page.locator('span.tag.admin').first()).toBeVisible({ timeout: 15_000 });
    const firstTagText = await page.locator('span.tag.admin').first().textContent();
    expect(firstTagText?.trim()).toBe('admins');

    // 7d. API Profile section (GET /api/me result)
    await expect(page.locator('h2', { hasText: 'API Profile (GET /api/me)' })).toBeVisible();
    // Wait for the API call to complete and alice's email to appear in the <pre> block
    await expect(page.locator('pre').filter({ hasText: ALICE_EMAIL })).toBeVisible({ timeout: 30_000 });

    // 7e. The API profile JSON should show is_admin: true
    const apiProfilePre = page.locator('pre').filter({ hasText: ALICE_EMAIL });
    const apiProfileText = await apiProfilePre.textContent();
    expect(apiProfileText).toContain('"email"');
    expect(apiProfileText).toContain('alice@example.com');
    expect(apiProfileText).toContain('"is_admin": true');

    // 7f. Todos UI is present
    await expect(page.locator('h2', { hasText: 'Todos (GET /api/todos)' })).toBeVisible();

    // 7g. Create a todo and assert it appears
    const todoTitle = `E2E test todo ${Date.now()}`;
    await page.locator('input[aria-label="New todo title"]').fill(todoTitle);
    await page.locator('button[type="submit"].primary', { hasText: 'Add' }).click();
    await expect(page.locator('li').filter({ hasText: todoTitle })).toBeVisible({ timeout: 15_000 });

    // ----------------------------------------------------------------
    // STEP 8: Capture final screenshot as artifact
    // ----------------------------------------------------------------
    const screenshotPath = path.join(__dirname, '..', 'test-results', 'authenticated-state.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[e2e] Final screenshot saved: ${screenshotPath}`);

    console.log('[e2e] Full brokered login flow PASSED — alice authenticated, API data verified, todos created.');
  });
});
