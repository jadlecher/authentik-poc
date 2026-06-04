/**
 * login-helpers.ts — shared, proven helpers for driving the full brokered login.
 *
 * Both e2e-login.spec.ts and api-auth.spec.ts use these so there is exactly ONE
 * (reliable) implementation of the SPA → authentik → Dex → callback flow. An
 * earlier duplicate, slightly-different inline copy in api-auth.spec.ts was flaky;
 * consolidating on this single code path removes that flakiness.
 *
 * Selectors (discovered by driving real browsers against authentik 2024.12.3):
 *   - Identification stage renders as <ak-stage-identification> in shadow DOM;
 *     Playwright pierces shadow DOM for role/text locators.
 *   - Dex source button: <button type="button"> with <img alt="Dex"> (icon-only).
 *     getByRole('button', { name: 'Dex' }) matches via the img alt.
 *   - Dex form: input[name="login"], input[name="password"], button[type="submit"];
 *     Dex may first show a connector link a[href*="dex/auth/local"].
 *   - After Dex callback authentik may show a consent page with a primary submit
 *     ("Continue"); for a brand-new user the enrollment flow is non-interactive.
 *   - SPA authenticated state: h2 "Identity (from ID token)".
 */
import { Page, expect } from '@playwright/test';

export const ALICE_EMAIL = 'alice@example.com';
export const ALICE_PASSWORD = 'password';

const SPA_ROOT = 'http://app.localhost:8000/';

/** Click the Dex source button on the authentik identification stage. */
export async function clickDexSourceButton(page: Page): Promise<void> {
  const dexButton = page.getByRole('button', { name: 'Dex' });
  await expect(dexButton).toBeVisible({ timeout: 30_000 });
  await dexButton.click();
}

/** Complete login on the Dex password form (handles the optional connector selector). */
export async function completeDexLogin(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const emailConnectorBtn = page.locator('a[href*="dex/auth/local"]');
  if (await emailConnectorBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await emailConnectorBtn.click();
  }

  const loginInput = page.locator('input[name="login"]');
  await expect(loginInput).toBeVisible({ timeout: 15_000 });
  await loginInput.fill(email);

  const passwordInput = page.locator('input[name="password"]');
  await expect(passwordInput).toBeVisible();
  await passwordInput.fill(password);

  await page.locator('button[type="submit"]').click();
}

/**
 * Click through any authentik consent/enrollment pages after Dex login until we
 * land back on app.localhost. The primary submit ("Continue") lives in the shadow
 * DOM of the consent web component; .first() avoids strict-mode multi-match.
 */
export async function handleAuthentikIntermediatePages(page: Page, maxAttempts = 8): Promise<void> {
  let attempts = 0;
  while (attempts < maxAttempts) {
    const currentUrl = page.url();
    if (currentUrl.includes('app.localhost')) return;
    if (!currentUrl.includes('auth.localhost')) return;

    await page.waitForTimeout(1_500);

    const primarySubmitBtn = page.locator(
      'button[type="submit"].pf-m-primary, button[type="submit"]:not(.pf-m-plain)',
    ).first();

    const isVisible = await primarySubmitBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (isVisible) {
      const btnText = await primarySubmitBtn.textContent().catch(() => '');
      console.log(`[login] Clicking intermediate page button: "${btnText?.trim()}" (attempt ${attempts + 1})`);
      await primarySubmitBtn.click();
      await page.waitForTimeout(2_000);
    } else {
      await page.waitForTimeout(2_000);
    }

    try {
      await page.waitForURL(/app\.localhost/, { timeout: 5_000 });
      return;
    } catch {
      /* not redirected yet — continue */
    }
    attempts++;
  }
}

/**
 * Drive the entire brokered login as the given user and resolve once the SPA's
 * authenticated state has rendered. Leaves the page on the SPA root.
 */
export async function brokeredLogin(
  page: Page,
  email = ALICE_EMAIL,
  password = ALICE_PASSWORD,
): Promise<void> {
  await page.goto(SPA_ROOT);

  const loginButton = page.locator('button.primary', { hasText: 'Login' });
  await expect(loginButton).toBeVisible({ timeout: 10_000 });
  await loginButton.click();

  await page.waitForURL(/auth\.localhost/, { timeout: 30_000 });
  await clickDexSourceButton(page);

  await page.waitForURL(/idp\.localhost/, { timeout: 30_000 });
  await completeDexLogin(page, email, password);

  await page.waitForURL(/auth\.localhost|app\.localhost/, { timeout: 60_000 });
  await handleAuthentikIntermediatePages(page);

  await page.waitForURL(SPA_ROOT, { timeout: 60_000 });
  await expect(page.locator('h2', { hasText: 'Identity (from ID token)' })).toBeVisible({ timeout: 30_000 });
}

/**
 * Extract the oidc-client-ts access token from the SPA's sessionStorage.
 * Must be called after brokeredLogin() has completed on the same page.
 */
export async function getAccessTokenFromPage(page: Page): Promise<string> {
  const token = await page.evaluate((): string | null => {
    const authority = 'http://auth.localhost:8000/application/o/app/';
    const clientId = 'spa-client';
    const raw = sessionStorage.getItem(`oidc.user:${authority}:${clientId}`);
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
    } catch {
      return null;
    }
  });
  if (!token) throw new Error('Could not extract access token from sessionStorage after login');
  return token;
}
