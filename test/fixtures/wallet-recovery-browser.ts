import { mkdir, writeFile } from 'node:fs/promises';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import { expect } from 'vitest';
import { walletRecoveryCookie, walletSessionCookie } from '../../src/rest/wallet/http.js';
import type { createLocalWalletRecovery } from '../../src/rest/wallet/recoveryService.js';
import type { PostgresWalletLoginStore } from '../../src/rest/wallet/loginPostgres.js';

/** Joined real browser/HTTP/PG/local EVM journey. Only authenticator hardware and
 * local gas funding are fixtures. The recovery kit remains in memory and is never an artifact. */
export async function exerciseRecoveryBrowser(options: {
  page: Page; context: BrowserContext; cdp: CDPSession; authenticatorId: string; origin: string;
  recovery: ReturnType<typeof createLocalWalletRecovery>; login: PostgresWalletLoginStore; kitText: string;
  requestBodies: string[];
  /** Holds the worker's refresh so the "preparing" phase is observable before login opens. */
  hold: { arm(): void; release(): void };
}) {
  const { page, context, cdp, authenticatorId, origin, recovery, login } = options, kit = JSON.parse(options.kitText);
  const openBackup = async (contents = options.kitText, filename = 'recovery.json') => {
    await page.getByLabel('My backup file', { exact: true }).check();
    const input = page.getByLabel('Open your backup file');
    // setInputFiles bypasses native actionability, including during the state read.
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await expect.poll(() => input.isEnabled(), { timeout: 15000 }).toBe(true);
    await input.setInputFiles({ name: filename, mimeType: 'application/json', buffer: Buffer.from(contents) });
  };
  const contains = async (value: string) => expect.poll(() => page.locator('#wallet-status').textContent(), { timeout: 15000 }).toContain(value);
  const originalSession = (await context.cookies()).find(cookie => cookie.name === walletSessionCookie)!;
  expect(await login.readSession(originalSession.value)).not.toBeNull();
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
  await page.goto(origin + '/recover');
  // The page loads its state first and drops input while busy; the disabled file input still
  // receives a programmatic file, so wait for the initial state before opening the backup.
  await contains('Open your backup file');
  await openBackup();
  await contains('Backup file loaded.');
  await page.getByLabel('New passkey name').fill('Juicebox replacement');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await contains('Create your replacement passkey');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
  await page.getByRole('button', { name: 'Create replacement passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel prompt' }).click();
  await contains('cancelled');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
  await page.getByRole('button', { name: 'Create replacement passkey', exact: true }).click();
  await contains('could not be confirmed');
  await page.getByRole('button', { name: 'Check again' }).click();
  await contains('Prove access');
  // A reload mid-recovery drops the backup from memory; the backup password typed afterwards must carry the proof.
  await page.reload(); await contains('Prove access');
  await page.getByLabel('My backup password').check();
  await page.getByLabel('Backup password', { exact: true }).fill(kit.mnemonic);
  await page.getByRole('button', { name: 'Verify both owners' }).click();
  await contains('Review and approve');
  expect(await page.getByLabel('Backup password', { exact: true }).inputValue()).toBe('');
  const originalFlow = (await context.cookies()).find(cookie => cookie.name === walletRecoveryCookie)!;
  const before = await recovery.status(originalFlow.value);
  expect(before.walletAddress.toLowerCase()).toBe(kit.walletAddress.toLowerCase());
  const wrongKit = JSON.stringify({ ...kit, walletAddress: '0x' + '66'.repeat(20) });
  await openBackup(wrongKit, 'wrong.json');
  await contains('does not match');
  await openBackup(); await contains('Backup file loaded.');
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByRole('button', { name: 'Review passkey replacement' }).click();
  await page.getByRole('button', { name: 'Approve passkey replacement' }).click();
  await contains('could not be confirmed');
  await page.getByRole('button', { name: 'Check again' }).click();
  await contains('Replacing your passkey');
  // Only the host worker may advance retained exact approval; GET merely reconciles.
  // The real page can poll status while the host progresses the same lane.
  // Retry only the pre-work busy result, as the scheduled host worker does.
  const workerDeadline = performance.now() + 20_000;
  for (let index = 0; index < 4;) {
    if (performance.now() >= workerDeadline) throw new Error('Recovery fixture worker did not finish within its deadline');
    try { await recovery.tick(); index++; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'WALLET_RECOVERY_RELAY_BUSY') throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await page.getByRole('button', { name: 'Check again' }).click();
  await contains('replacement passkey is in place');
  await context.clearCookies({ name: walletRecoveryCookie });
  await page.reload();
  await contains('Resume the original recovery');
  expect(await page.locator('#recovery-words').inputValue()).toBe('');
  await openBackup();
  await contains('Backup file loaded.');
  await page.getByText('Resume a recovery you started', { exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await contains('replacement passkey is in place');
  const newFlow = (await context.cookies()).find(cookie => cookie.name === walletRecoveryCookie)!;
  expect(newFlow.value).not.toBe(originalFlow.value);
  await expect(recovery.status(originalFlow.value)).rejects.toThrow();
  expect((await recovery.status(newFlow.value)).id).toBe(before.id);
  // One click, no prompt: the recovery's own proof is the consent; the first reply is lost and
  // checking the recovery finds activation committed and the login being prepared.
  options.hold.arm();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await contains('could not be confirmed');
  await page.getByRole('button', { name: 'Check again' }).click();
  await contains('Preparing to sign in');
  expect(await page.locator('#wallet-status').getAttribute('data-state')).toBe('busy');
  options.hold.release();
  await contains('Your replacement passkey is ready');
  expect(await login.readSession(originalSession.value)).toBeNull();
  const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(persisted.includes(kit.mnemonic)).toBe(false);
  expect(options.requestBodies.some(body => body.includes(kit.mnemonic))).toBe(false);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center:recovery:browser:')))).toEqual([]);
  const out = new URL('../../.generated/wallet-observations/recovery-browser/', import.meta.url); await mkdir(out, { recursive: true });
  await page.screenshot({ path: new URL('recovery-desktop.png', out).pathname, fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: new URL('recovery-mobile.png', out).pathname, fullPage: true });
  await page.getByRole('link', { name: 'Signa in', exact: true }).click();
  // A direct landing visit lands on the signup page; its "log in" link, or the finished signup's button, performs the sign-in.
  await page.getByRole('link', { name: 'Signa in' }).or(page.getByRole('button', { name: 'Signa in', exact: true })).click();
  await contains('You are signed in');
  expect((await page.locator('#wallet-address').textContent())!.toLowerCase()).toBe(kit.walletAddress.toLowerCase());
  expect(await page.locator('#wallet-passkey').textContent()).toBe('Juicebox replacement');
  await writeFile(new URL('summary.json', out), JSON.stringify({ passed: true, evidence: 'real HTTP, PostgreSQL, unforked Anvil; virtual authenticator',
    originalPasskeyRemoved: true, recoveryKitImported: true, wrongKitRejected: true, nativeCancellationRetried: true,
    lostRegistrationReplyRecovered: true, lostApprovalReplyRecovered: true, cookieLostAfterRotationResumedSameRecovery: true,
    lostSetupReplyRecovered: true, oldSessionRejected: true, sameWalletFreshNewPasskeyLogin: true,
    phraseAbsentFromStorageAndRequests: true, mobileWidth: 320 }, null, 2));
}
