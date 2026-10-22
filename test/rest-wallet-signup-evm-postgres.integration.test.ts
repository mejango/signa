// Joined service proof: real PostgreSQL, unforked Anvil, P256 owners and browser-key consent.
// Test-only treasury and synthetic genesis balances. This does not qualify production Base fees.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { hashTypedData, toHex, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { walletEnrollmentDocument } from "../src/rest/wallet/enrollment.js";
import { PostgresWalletDeploymentStore } from "../src/rest/wallet/deploymentPostgres.js";
import { walletDeploymentDocument } from "../src/rest/wallet/deployment.js";
import { createWalletDeploymentExecution } from "../src/rest/wallet/deploymentExecution.js";
import { createLocalAnvilWalletDeploymentTransport } from "../src/rest/wallet/deploymentLocalAnvil.js";
import { createLocalAnvilWalletDeploymentSettlement } from "../src/rest/wallet/deploymentSettlementLocalAnvil.js";
import { createSmartAccountService } from "../src/rest/smartAccounts/service.js";
import { PostgresSmartAccountRegistry } from "../src/rest/smartAccounts/postgres.js";
import { PostgresOnboardingStore } from "../src/rest/smartAccounts/onboardingPostgres.js";
import { createSafe7579Inspector } from "../src/rest/smartAccounts/inspector.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { createWalletAuthorityChain } from "../src/rest/wallet/authorityChain.js";
import { createWalletAuthorityService } from "../src/rest/wallet/authorityService.js";
import { PostgresWalletLoginStore } from "../src/rest/wallet/loginPostgres.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { startWalletDeploymentAnvil } from "./fixtures/wallet-deployment-anvil.js";
import { walletLoginTestMigrations } from "./fixtures/wallet-login-setup.js";
import { PostgresWalletSignupStore } from "../src/rest/wallet/signupPostgres.js";
import { createLocalWalletSignup } from "../src/rest/wallet/signup.js";
import { exerciseSignupBrowser } from "./fixtures/wallet-signup-browser.js";
import { exerciseWalletRecoveryEvm } from "./fixtures/wallet-recovery-evm.js";
import { exerciseWalletDeviceEvm } from "./fixtures/wallet-device-evm.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const issuer = "https://wallet.juicebox.center", rpId = "wallet.juicebox.center";
suite("joined wallet signup against real PostgreSQL and unforked EVM", () => {
  const schema = `rest_wallet_signup_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  const count = async (table: string) => Number((await pool.query(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count);
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 });
    for (const name of [...new Set([...walletLoginTestMigrations, "016_rest_wallet_deployments.sql", "036_wallet_deployment_approval_v2.sql",
      "018_rest_wallet_deployment_observations.sql", "021_rest_wallet_deployment_dispatch.sql", "026_wallet_deployment_settlement.sql", "034_wallet_deployment_base.sql", "054_wallet_deployment_inclusion_release.sql", "056_wallet_deployment_release_after_settled_dispatch.sql", "027_wallet_signup.sql",
      "028_wallet_recovery.sql", "029_wallet_recovery_mapping.sql", "033_wallet_unproved_recovery_expiry.sql", "030_wallet_recovery_flow.sql", "031_wallet_recovery_dispatch.sql", "035_wallet_recovery_base.sql", "045_wallet_device_addition.sql", "064_wallet_recovery_chains.sql", "065_wallet_owner_chains.sql"])].sort())
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
    // The recovery page derives signers from the passkey contracts built into it, so they sit at production's addresses here.
    fixture = await startWalletDeploymentAnvil(undefined, { passkeyAtProductionAddresses: true });
  }, 30_000);
  afterAll(async () => {
    await fixture?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("takes four users through signup and fresh login, including saved recovery kits, cancellation, lost replies and cookie recovery", async () => {
    const startedAt = performance.now();
    let stage = "initializing", stageStartedAt = startedAt;
    const enterStage = (next: string) => { stage = next; stageStartedAt = performance.now(); };
    onTestFailed(() => {
      console.error(`[joined wallet signup] stage=${stage}; stageElapsedMs=${Math.round(performance.now() - stageStartedAt)}; totalElapsedMs=${Math.round(performance.now() - startedAt)}`);
    });
    const enrollments = new PostgresWalletEnrollmentStore(pool), deployments = new PostgresWalletDeploymentStore(pool);
    const settlement = createLocalAnvilWalletDeploymentSettlement(fixture);
    await fixture.rpc("anvil_setBalance", [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    await deployments.configurePool(fixture.configuration);
    const initialFunding = await deployments.loadFundingContext(fixture.configuration.id);
    const initialObservation = await settlement.observeFunding(initialFunding);
    // The local producer and PostgreSQL use separate real clocks; admit only once the DB
    // reaches this unchanged observation time, while its original expiry is still live.
    const databaseNow = async () => Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
    await expect.poll(databaseNow).toBeGreaterThanOrEqual(initialObservation.observedAt);
    expect(await databaseNow(), JSON.stringify({ observedAt: initialObservation.observedAt, expiresAt: initialObservation.expiresAt })).toBeLessThan(initialObservation.expiresAt);
    await deployments.initializeAccounting(initialFunding, initialObservation, "2");
    const execution = createWalletDeploymentExecution({ store: deployments, chain: fixture.chain(),
      signer: mnemonicToAccount("test test test test test test test test test test test junk"),
      experimentalTransport: createLocalAnvilWalletDeploymentTransport(fixture) });
    const smart = createSmartAccountService({ rpc: fixture.readOnlyRpc, manifests: [fixture.manifest], audience: "https://juicebox.center",
      registry: new PostgresSmartAccountRegistry(pool), onboarding: new PostgresOnboardingStore(pool),
      moduleInspectors: [createSafe7579Inspector({ rpc: fixture.readOnlyRpc, utility: fixture.utility,
        inspectSessions: createInstalledSessionVerifier({ rpc: fixture.readOnlyRpc }).inspectAllAt })] });
    const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(pool),
      chain: createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility,
        carried: (manifestId, address) => smart.remembered(manifestId, address) }) });
    const login = new PostgresWalletLoginStore(pool, { rpId, origin: issuer });
    const flows = new PostgresWalletSignupStore(pool, { rpId, origin: issuer, manifest: fixture.manifest });
    const events: string[] = [];
    const signup = createLocalWalletSignup({ flows, enrollments, deployments, settlement, execution, smart, authority,
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id, releasedObservationIntervalMs: 0,
      onEvent: event => events.push(`${event.stage}:${event.outcome}`) });
    const until = async (name: string) => { for (let i = 0; i < 600 && !events.includes(name); i++) await new Promise(r => setTimeout(r, 25)); expect(events, events.join(' ')).toContain(name); };
    const accounts: string[] = [], receipts: string[] = [];
    let recoveryTarget: Pick<Parameters<typeof exerciseWalletRecoveryEvm>[0], 'enrollment' | 'originalKey' | 'originalSessionToken'> | null = null;
    for (let index = 0; index < 2; index++) {
      enterStage(index === 0 ? "programmatic signup 1" : "programmatic signup 2");
      const begunFlow = await signup.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: "Juicebox test" });
      const flowToken = begunFlow.flowToken;
      const initial = (await enrollments.get(begunFlow.view.enrollmentId))!;
      const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, "base64url").toString("hex")}`,
        rpId, origin: issuer, userHandle: initial.intent.userHandle });
      expect((await signup.register(flowToken, credential.response)).phase).toBe("awaiting_possession");
      const pending = (await enrollments.get(initial.intent.id))!;
      expect(await new PostgresWalletEnrollmentStore(pool).acceptRegistration(initial.intent.id, credential.response)).toEqual(pending);
      const document = walletEnrollmentDocument(pending);
      const enrollmentProof = { assertion: signGet({ ...credential, challenge: hashTypedData(document), rpId, origin: issuer }),
        backupSignature: await signBackupProof(document) };
      expect((await signup.proveEnrollment(flowToken, enrollmentProof)).phase).toBe("awaiting_deployment_approval");
      const record = (await enrollments.get(initial.intent.id))!;
      expect((await new PostgresWalletEnrollmentStore(pool).finalize(initial.intent.id, enrollmentProof)).replayed).toBe(true);
      const accountId = record.receipt!.accountId; accounts.push(accountId);
      expect(await count("rest_accounts")).toBe(index);
      expect(await count("rest_bot_grants")).toBe(0);
      expect(await count("rest_wallet_logins")).toBe(index * 2);
      const premature = await login.begin();
      await expect(login.complete({ loginId: premature.login.id, flowToken: premature.flowToken,
        assertion: signGet({ ...credential, challenge: premature.login.challenge, rpId, origin: issuer }) })).rejects.toBeInstanceOf(Error);
      const deploymentReview = await signup.prepareDeployment(flowToken);
      // The review starts the approval's chain reads while the passkey prompt is up.
      await until("approval:speculated");
      const beforeCreation = index === 0 ? await fixture.rpc<Hex>("evm_snapshot") : null;
      const operation = (await deployments.get(deploymentReview.id))!, approval = operation.approval;
      expect((await signup.prepareDeployment(flowToken)).id).toBe(operation.id);
      const preflight = await fixture.chain().preflight(record, approval);
      expect(preflight.dispatchEligible).toBe(false); // Production Base still has no complete fee qualification.
      const approvalProof = { approvalId: operation.id,
        assertion: signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument(record, approval)), rpId, origin: issuer }) };
      events.length = 0;
      expect((await signup.approveDeployment(flowToken, approvalProof)).phase).toBe("deploying");
      // The approval carried the speculated funding and preflight into the claim: no chain read of its own.
      expect(events).toEqual(["approval:carried"]);
      expect((await signup.approveDeployment(flowToken, approvalProof)).phase).toBe("deploying");
      // Under gate load a shared local anvil can time a read out and the pass says "not now"; the
      // worker's next pass sends, as in production (the kicked pass may already be the one that did).
      for (let attempt = 0; attempt < 5 && !(await deployments.getDispatch(operation.id)); attempt++) await signup.tick();
      const dispatch = (await deployments.getDispatch(operation.id))!, sent = (await deployments.get(operation.id))!;
      expect(dispatch.status, `Dispatch lease remaining: ${dispatch.leaseUntil - await flows.now()}ms`).toBe("accepted");
      await expect.poll(() => flows.now()).toBeGreaterThanOrEqual(dispatch.leaseUntil);
      if (beforeCreation) {
        // The send is out but not yet observed as included: roll the chain back under it, with
        // PostgreSQL still retaining its original signed winner and the lane still held.
        expect(await fixture.rpc("evm_revert", [beforeCreation])).toBe(true);
        await expect(signup.activate(flowToken)).rejects.toBeInstanceOf(Error);
        expect(await count("rest_accounts")).toBe(index);
        expect((await deployments.loadFundingContext(fixture.configuration.id)).pool.activeOperationId).toBe(operation.id);
        // Reach the retained head watermark and the retry cooldown, then let the normal worker
        // resend only the already journaled bytes. No replacement nonce or approval.
        await fixture.rpc("anvil_mine", ["0x1", "0x0"]);
        await expect.poll(() => flows.now()).toBeGreaterThanOrEqual(dispatch.nextAttemptAt);
        await signup.tick();
        expect((await signup.status(flowToken)).phase).toBe("deploying");
        await expect(signup.activate(flowToken)).rejects.toMatchObject({ code: "WALLET_SIGNUP_STATE" });
        const resent = (await deployments.getDispatch(operation.id))!;
        expect(resent.attempts).toBe(dispatch.attempts + 1);
        await expect.poll(() => flows.now()).toBeGreaterThanOrEqual(resent.leaseUntil);
      }
      await signup.tick();
      // The resent bytes land with the interval chain's next block; keep observing until they do.
      for (let attempt = 0; attempt < 12 && (await signup.status(flowToken)).phase !== "awaiting_activation"; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500)); await signup.tick();
      }
      const included = (await deployments.get(operation.id))!;
      expect(included.signed).toEqual(sent.signed);
      expect(included.observation).toMatchObject({ transaction: { state: "canonical-success", nonce: { confirmed: String(index + 3) } },
        wallet: { state: "unknown", reason: "inspection-deferred" }, finality: { state: "unfinalized" } });
      expect(await deployments.getSettlement(operation.id)).toBeNull();
      // The lane was released at inclusion: the next user may claim while this one waits for finality.
      expect(included.releasedAt).not.toBeNull();
      expect((await deployments.loadFundingContext(fixture.configuration.id)).pool).toMatchObject({ activeOperationId: null,
        reservedWei: included.reservedWei, accounting: { nextNonce: String(index + 3), sequence: index } });
      expect(await count("rest_accounts")).toBe(index);

      expect((await signup.status(flowToken)).phase).toBe("awaiting_activation");
      if (index === 0) {
        const read = fixture.readOnlyRpc.request;
        fixture.readOnlyRpc.request = (chain, method, params, signal) => method === "eth_getTransactionReceipt"
          ? Promise.reject(new Error("Injected receipt observation outage")) : read(chain, method, params, signal);
        try { await signup.tick(); } finally { fixture.readOnlyRpc.request = read; }
        expect((await deployments.get(operation.id))!.historicalCanonicalObservation).toMatchObject({
          transaction: { state: "canonical-success" }, wallet: { state: "unknown" } });
        expect((await signup.status(flowToken)).phase).toBe("deploying");
        await expect(signup.activate(flowToken)).rejects.toMatchObject({ code: "WALLET_SIGNUP_STATE" });
        await signup.tick();
        expect((await signup.status(flowToken)).phase).toBe("awaiting_activation");
      }
      // Activation binds the account from the enrollment consent, with no prompt and no browser
      // grant; login then waits for the worker's verified authority observation.
      expect((await signup.activate(flowToken)).phase).toBe("ready_to_sign_in");
      expect((await signup.activate(flowToken)).phase).toBe("ready_to_sign_in");
      expect((await authority.refreshAuthority(accountId)).snapshot.readiness).toBe("verified");
      expect((await signup.status(flowToken)).phase).toBe("ready_to_sign_in");
      const configured = (await new PostgresSmartAccountRegistry(pool).list(accountId)).find(binding => binding.wallet.address.toLowerCase() === record.creation!.address.toLowerCase())!;
      expect(configured.authorization).toMatchObject({ method: "center-wallet-passkey-creation-v1", digest: `0x${record.receipt!.verificationDigest}` });
      expect(configured.authorization.setup).toBeUndefined();
      expect(await count("rest_accounts")).toBe(index + 1); expect(await count("rest_bot_grants")).toBe(0);
      expect((await authority.refreshAuthority(accountId)).snapshot.readiness).toBe("verified");
      const begun = await login.begin();
      await expect(login.complete({ loginId: begun.login.id, flowToken: begun.flowToken, assertion: enrollmentProof.assertion })).rejects.toBeInstanceOf(Error);
      const proof = { loginId: begun.login.id, flowToken: begun.flowToken,
        assertion: signGet({ ...credential, challenge: begun.login.challenge, rpId, origin: issuer }) };
      const loggedIn = await login.complete(proof);
      expect(loggedIn.session.accountId).toBe(accountId);
      expect((await new PostgresWalletLoginStore(pool, { rpId, origin: issuer }).complete(proof)).sessionToken).toBe(loggedIn.sessionToken);
      expect(await login.readSession(loggedIn.sessionToken)).toEqual(loggedIn.session);
      expect(await login.readSession(begun.flowToken)).toBeNull();
      // Login finishes long before the treasury's finalized fee settlement, which debits the
      // reservation behind the already released lane.
      expect(await deployments.getSettlement(operation.id)).toBeNull();
      expect((await deployments.loadFundingContext(fixture.configuration.id)).pool.activeOperationId).toBeNull();
      const latestDispatch = (await deployments.getDispatch(operation.id))!;
      await expect.poll(() => flows.now()).toBeGreaterThanOrEqual(latestDispatch.leaseUntil);
      await fixture.rpc("anvil_mine", ["0x41", "0x0"]);
      await signup.tick();
      const settled = (await deployments.getSettlement(operation.id))!;
      expect(settled).toMatchObject({ nonce: String(index + 2), nextNonce: String(index + 3), sequence: index + 1 });
      receipts.push(settled.evidence.transactionHash);
      await signup.tick();
      expect(await deployments.getSettlement(operation.id)).toEqual(settled);
      expect(await count("rest_wallet_deployment_settlements")).toBe(index + 1);
      recoveryTarget = { enrollment: record, originalKey: credential, originalSessionToken: loggedIn.sessionToken };
    }
    expect(new Set(accounts).size).toBe(2); expect(new Set(receipts).size).toBe(2);
    expect((await deployments.listUnresolved()).items).toEqual([]);
    expect(await fixture.rpc<Hex>("eth_getTransactionCount", [fixture.sender, "latest"])).toBe("0x4");
    // The same account gains a device first; recovery then replaces the primary with the device kept.
    enterStage("programmatic device addition");
    const added = await exerciseWalletDeviceEvm({ pool, fixture, smart, authority, ...recoveryTarget!, audience: 'https://juicebox.center' });
    enterStage("programmatic recovery");
    await exerciseWalletRecoveryEvm({ pool, fixture, smart, authority, ...recoveryTarget!, originalSessionToken: added.primarySessionToken, audience: 'https://juicebox.center' });
    enterStage("external wallet browser signup");
    await exerciseSignupBrowser({ pool, fixture, enrollments, deployments, settlement, execution, smart, authority, resume: false,
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id });
    enterStage("recovery kit browser signup and recovery");
    await exerciseSignupBrowser({ pool, fixture, enrollments, deployments, settlement, execution, smart, authority,
      recoveryMode: 'kit', expectedNextNonce: '6',
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id });
  // Four sequential signup/login journeys, device addition and two recoveries share this runner
  // budget. The four-worker release gate can spend over 100s reaching the final browser journey;
  // browser, RPC, recovery-worker and production deadlines remain independently enforced.
  }, 180_000);
});
