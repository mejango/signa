import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, hashTypedData, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PostgresWalletRecoveryStore } from '../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletRecoveryFlowStore, assertRecoveryContinuationInTransaction } from '../src/rest/wallet/recoveryFlowPostgres.js';
import { walletRecoveryDocument, createWalletRecoveryMapping } from '../src/rest/wallet/recovery.js';
import { passkeyOnboardingDocument } from '../src/rest/smartAccounts/passkeyOnboarding.js';
import { bindSmartAccountInTransaction } from '../src/rest/smartAccounts/postgres.js';
import type { WalletSignupSetup } from '../src/rest/wallet/signupPostgres.js';
import { insertWalletAccount } from './fixtures/wallet-recovery-account.js';
import { createWalletRecoveryChains } from '../src/rest/wallet/recoveryChains.js';
import { walletRecoveryRotationDocument } from '../src/rest/wallet/recoveryRotation.js';
import { safeAbi } from '../src/rest/smartAccounts/service.js';
import type { RestRpc } from '../src/rest/core.js';
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from './fixtures/wallet-enrollment-crypto.js';

const connectionString = process.env.TEST_DATABASE_URL, suite = connectionString ? describe : describe.skip;
const policy = { rpId: 'juicebox.center', origin: 'https://juicebox.center' };
suite('durable recovery browser continuation (genuine crypto, modeled canonical metadata)', () => {
  const schema = `wallet_recovery_flow_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, recovery: PostgresWalletRecoveryStore, flows: PostgresWalletRecoveryFlowStore;
  const now = async () => Number((await pool.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0].now);
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
    for (const name of ['004_rest_accounts.sql', '007_rest_smart_accounts.sql', '012_rest_smart_account_onboarding.sql',
      '013_rest_wallet_ceremonies.sql', '014_rest_passkey_onboarding.sql', '042_wallet_binding_consent.sql', '015_rest_wallet_enrollment.sql', '046_wallet_signup_window.sql', '041_wallet_passkey_name.sql', '043_wallet_networks.sql', '044_wallet_devices.sql',
      '017_rest_wallet_policy.sql', '051_wallet_policy_app_grant_lifetime.sql', '019_rest_wallet_app_grants.sql', '052_wallet_app_grant_lifetime_90d.sql', '020_rest_wallet_authority.sql', '039_wallet_authority_window.sql', '049_wallet_authority_window_15m.sql', '028_wallet_recovery.sql',
      '029_wallet_recovery_mapping.sql', '033_wallet_unproved_recovery_expiry.sql', '030_wallet_recovery_flow.sql', '064_wallet_recovery_chains.sql'])
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    recovery = new PostgresWalletRecoveryStore(pool, policy); flows = new PostgresWalletRecoveryFlowStore(pool);
  });
  beforeEach(async () => { await pool.query('TRUNCATE rest_accounts,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_networks,rest_wallet_network_bundles CASCADE'); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  const existing = async () => insertWalletAccount(pool, await now());
  async function registered(options: { accepted?: boolean; lifetimeMs?: number; flowStore?: PostgresWalletRecoveryFlowStore } = {}) {
    const context = await existing(), selected = new PostgresWalletRecoveryStore(pool, { ...policy, ...(options.lifetimeMs ? { lifetimeMs: options.lifetimeMs } : {}) });
    const begun = await selected.begin(context.accountId), intent = begun.record.intent, selectedFlows = options.flowStore ?? flows;
    const flow = await selectedFlows.initialize({ recoveryId: intent.id, flowToken: begun.flowToken, passkeyName: 'Juicebox test' });
    const key = createRegistration({ ...policy, userHandle: intent.userHandle, challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
    let record = await selected.register(intent.id, begun.flowToken, key.response);
    const document = walletRecoveryDocument(record.candidate!), proof = { assertion: signGet({ ...key, ...policy, challenge: hashTypedData(document) }), backupSignature: await signBackupProof(document) };
    if (options.accepted !== false) record = (await selected.prove(intent.id, begun.flowToken, proof)).record;
    return { context, begun, flow, key, record, proof, selected };
  }
  async function resume(value: Awaited<ReturnType<typeof registered>>, selected = flows) {
    const begun = await selected.beginResume(value.record.intent.id);
    return { begun, input: { resumeId: begun.challenge.id, resumeToken: begun.resumeToken,
      assertion: signGet({ ...value.key, ...policy, challenge: begun.challenge.challenge }), backupSignature: await signBackupProof(begun.challenge.document) } };
  }
  async function setup(value: Awaited<ReturnType<typeof registered>>, lifetime = 120): Promise<WalletSignupSetup> {
    const current = Math.floor(await now() / 1000), intent = value.record.intent;
    return { id: randomUUID(), stateHash: `0x${'ab'.repeat(32)}`, manifestRevision: intent.manifest.revision, initializerHash: intent.initializerHash,
      input: { profile: 'center-passkey-v1', address: intent.accountId.slice(12) as Hex, manifestId: intent.manifest.id,
        nonce: `0x${randomBytes(32).toString('hex')}`, issuedAt: current, expiresAt: current + lifetime,
        grant: { id: randomUUID(), botAddress: privateKeyToAccount(`0x${'33'.repeat(32)}`).address, scopes: ['read', 'plan', 'relay'], expiresAt: current + 3600, label: 'Recovery browser' } } };
  }
  function clockedFlows(at: number | (() => number), afterQuery?: (query: unknown) => void) {
    const query = async (connection: Pool | import('pg').PoolClient, args: unknown[]) => {
      const instant = typeof at === 'function' ? at() : at;
      if (!Number.isSafeInteger(instant) || instant <= 0) throw new Error('Invalid test SQL clock');
      // Advance every SQL authority clock consistently, including timestamps in
      // INSERT/UPDATE statements. Constraints, row locks and transactions remain real.
      const original = args[0];
      const adjusted = typeof original === 'string' ? original.replace(
        /floor\(extract\(epoch FROM clock_timestamp\(\)\)\s*\*\s*1000\)::(?:bigint|text)/g, `${instant}::bigint`) : original;
      const result = await Reflect.apply(connection.query, connection, [adjusted, ...args.slice(1)]);
      afterQuery?.(original); return result;
    };
    return new PostgresWalletRecoveryFlowStore(new Proxy(pool, { get(target, property) {
      if (property === 'query') return (...args: unknown[]) => query(target, args);
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, key) {
          if (key === 'query') return (...args: unknown[]) => query(connection, args);
          const value = Reflect.get(connection, key, connection); return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }));
  }
  it('allows abandoning only an expired unproved recovery and preserves its complete database history', async () => {
    const value = await registered({ accepted: false });
    await expect(flows.assertRestartable(value.begun.flowToken)).rejects.toMatchObject({ status: 409 });
    const before = (await pool.query('SELECT to_jsonb(r) AS row FROM rest_wallet_recoveries r')).rows;
    const expiredFlows = clockedFlows(value.record.intent.expiresAtMs);
    await expect(expiredFlows.assertRestartable(value.begun.flowToken)).resolves.toBeUndefined();
    await expect(expiredFlows.assertRestartable(value.begun.flowToken)).resolves.toBeUndefined();
    expect((await pool.query('SELECT to_jsonb(r) AS row FROM rest_wallet_recoveries r')).rows).toEqual(before);
    expect(await flows.authenticate(value.begun.flowToken)).toEqual(value.flow);
    await expect(expiredFlows.assertRestartable(value.flow.id)).rejects.toMatchObject({ status: 403 });
  });
  it('never abandons an accepted proof after its intake deadline or through a stale continuation', async () => {
    const value = await registered(), resumed = await flows.completeResume((await resume(value)).input);
    const expiredFlows = clockedFlows(value.record.intent.expiresAtMs + 1);
    await expect(expiredFlows.assertRestartable(resumed.flowToken)).rejects.toMatchObject({ status: 409 });
    await expect(expiredFlows.assertRestartable(value.begun.flowToken)).rejects.toMatchObject({ status: 403 });
    expect((await recovery.get(value.flow.id, resumed.flowToken))!.proof).toEqual(value.record.proof);
  });
  it('fixes name and public recovery locator, hashes tokens and refuses initialization by locator alone', async () => {
    const value = await registered(); expect(await flows.authenticate(value.begun.flowToken)).toEqual(value.flow);
    expect(await flows.authenticate(value.flow.id)).toBeNull(); expect(await flows.authenticate(randomBytes(32).toString('base64url'))).toBeNull();
    const input = { recoveryId: value.flow.id, flowToken: value.begun.flowToken, passkeyName: 'Juicebox test' };
    expect(await new PostgresWalletRecoveryFlowStore(pool).initialize(input)).toEqual(value.flow);
    await expect(flows.initialize({ ...input, passkeyName: 'Changed' })).rejects.toMatchObject({ status: 409 });
    await expect(flows.initialize({ ...input, flowToken: randomBytes(32).toString('base64url') })).rejects.toMatchObject({ status: 403 });
    for (const passkeyName of ['', ' ', 'a\nb', 'a\u202eb', 'é'.repeat(61)]) await expect(flows.initialize({ ...input, passkeyName })).rejects.toMatchObject({ status: 400 });
    await expect(flows.initialize({ ...input, mnemonic: 'must never reach storage' } as typeof input)).rejects.toMatchObject({ status: 400 });
    const rows = (await pool.query('SELECT to_jsonb(f)::text AS value FROM rest_wallet_recovery_flows f')).rows[0].value;
    expect(rows).not.toContain(value.begun.flowToken);
    await expect(pool.query("UPDATE rest_wallet_recovery_flows SET passkey_name='Changed',revision=revision+1 WHERE id=$1", [value.flow.id])).rejects.toMatchObject({ code: '23514' });
  });
  it('rotates only browser continuation with two fresh proofs, preserves recovery evidence and replays a lost reply exactly', async () => {
    const value = await registered(), challenge = await resume(value), original = (await pool.query('SELECT to_jsonb(r) AS row FROM rest_wallet_recoveries r')).rows[0].row;
    const results = await Promise.all([flows.completeResume(challenge.input), new PostgresWalletRecoveryFlowStore(pool).completeResume(challenge.input)]);
    expect(results.map(item => item.replayed).sort()).toEqual([false, true]); expect(results[0].flowToken).toBe(results[1].flowToken);
    const result = results[0]; expect(await flows.authenticate(value.begun.flowToken)).toBeNull(); expect(await flows.authenticate(result.flowToken)).toEqual(result.flow);
    expect(await flows.completeResume(challenge.input)).toEqual({ ...result, replayed: true });
    expect((await pool.query('SELECT to_jsonb(r) AS row FROM rest_wallet_recoveries r')).rows[0].row).toEqual(original);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); const row = (await client.query('SELECT id,token_hash FROM rest_wallet_recoveries WHERE id=$1 FOR UPDATE', [value.flow.id])).rows[0];
      await expect(assertRecoveryContinuationInTransaction(client, row, value.begun.flowToken)).rejects.toMatchObject({ status: 403 });
      await assertRecoveryContinuationInTransaction(client, row, result.flowToken); await client.query('ROLLBACK');
    } finally { client.release(); }
    const rows = (await pool.query('SELECT to_jsonb(r)::text AS value FROM rest_wallet_recovery_resumes r')).rows[0].value;
    expect(rows).not.toContain(challenge.begun.resumeToken); expect(rows).not.toContain(result.flowToken);
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_bot_grants')).rows[0].count).toBe(0);
  });
  it('rejects wrong backup, purpose, credential, RP, origin, absent user handle and locator-only attempts', async () => {
    const value = await registered(), other = await registered(), challenge = await resume(value), good = challenge.input;
    for (const assertion of [{ ...good.assertion, userHandle: null }, { ...good.assertion, credentialId: other.key.credentialId },
      signGet({ ...other.key, userHandle: value.key.userHandle, ...policy, challenge: challenge.begun.challenge.challenge }),
      signGet({ ...value.key, ...policy, rpId: 'wrong.example', challenge: challenge.begun.challenge.challenge }),
      signGet({ ...value.key, ...policy, origin: 'https://wrong.example', challenge: challenge.begun.challenge.challenge }), value.proof.assertion])
      await expect(flows.completeResume({ ...good, assertion })).rejects.toMatchObject({ status: 403 });
    await expect(flows.completeResume({ ...good, backupSignature: await signBackupProof(challenge.begun.challenge.document, privateKeyToAccount(`0x${'22'.repeat(32)}`)) })).rejects.toMatchObject({ status: 403 });
    await expect(flows.completeResume({ ...good, backupSignature: value.proof.backupSignature })).rejects.toMatchObject({ status: 403 });
    await expect(flows.completeResume({ ...good, resumeToken: value.begun.flowToken })).rejects.toMatchObject({ status: 403 });
    expect(await flows.authenticate(value.begun.flowToken)).toEqual(value.flow);
    expect((await flows.completeResume(good)).replayed).toBe(false);
  });
  it('fences parallel stale challenges and completed older rotations without restoring old tokens', async () => {
    const value = await registered(), first = await resume(value), parallel = await resume(value);
    const result = await flows.completeResume(first.input);
    await expect(flows.completeResume(parallel.input)).rejects.toMatchObject({ status: 409 });
    const next = await resume(value), latest = await flows.completeResume(next.input);
    await expect(flows.completeResume(first.input)).rejects.toMatchObject({ status: 409 });
    expect(await flows.authenticate(result.flowToken)).toBeNull(); expect(await flows.authenticate(latest.flowToken)).toEqual(latest.flow);
  });
  it('persists exact setup reviews, rejects stale revisions and cross-wallet substitutions, and replaces only expired reviews', async () => {
    const value = await registered(), prepared = await setup(value, 60), challenge = await resume(value);
    const associated = await flows.associateSetup(value.begun.flowToken, value.flow.revision, prepared);
    expect(await flows.associateSetup(value.begun.flowToken, value.flow.revision, prepared)).toEqual(associated);
    await expect(flows.completeResume(challenge.input)).rejects.toMatchObject({ status: 409 });
    const different = await setup(value);
    await expect(flows.associateSetup(value.begun.flowToken, associated.revision, different)).rejects.toMatchObject({ status: 409 });
    const expiredFlows = clockedFlows(prepared.input.expiresAt * 1000);
    await expect(expiredFlows.associateSetup(value.begun.flowToken, value.flow.revision, different)).rejects.toMatchObject({ status: 409 });
    await expect(expiredFlows.associateSetup(value.begun.flowToken, associated.revision, { ...different, initializerHash: `0x${'ff'.repeat(32)}` })).rejects.toMatchObject({ status: 409 });
    expect((await expiredFlows.associateSetup(value.begun.flowToken, associated.revision, different)).setup).toEqual(different);
  });
  it('resumes an expired cookie after accepted proof but never renews unaccepted proof deadlines', async () => {
    const value = await registered(), intent = value.record.intent;
    await pool.query('UPDATE rest_wallet_recovery_flows SET expires_at_ms=created_at_ms+1,revision=revision+1 WHERE id=$1', [value.flow.id]);
    const expiredFlows = clockedFlows(intent.expiresAtMs + 1);
    expect(await flows.authenticate(value.begun.flowToken)).toBeNull(); const challenge = await resume(value, expiredFlows);
    const resumed = await expiredFlows.completeResume(challenge.input); expect(await flows.authenticate(resumed.flowToken)).toEqual(resumed.flow);
    expect((await pool.query('SELECT intent FROM rest_wallet_recoveries WHERE id=$1', [intent.id])).rows[0].intent).toEqual(intent);
    const pending = await registered({ accepted: false });
    await expect(clockedFlows(pending.record.intent.expiresAtMs).beginResume(pending.flow.id)).rejects.toMatchObject({ status: 410 });
  });
  it('rolls back token rotation and ceremony consumption when the resume expires during the final database write', async () => {
    const value = await registered(), challenge = await resume(value);
    let databaseTime = await now(), crossedExpiry = false;
    const delayed = clockedFlows(() => databaseTime, query => {
      if (typeof query === 'string' && query.startsWith('UPDATE rest_wallet_recovery_flows SET token_hash=')) {
        crossedExpiry = true; databaseTime = challenge.begun.challenge.expiresAtMs;
      }
    });
    await expect(delayed.completeResume(challenge.input)).rejects.toMatchObject({ status: 410 });
    expect(crossedExpiry).toBe(true);
    expect(await flows.authenticate(value.begun.flowToken)).toEqual(value.flow);
    expect((await pool.query('SELECT completed_at_ms FROM rest_wallet_recovery_resumes WHERE id=$1', [challenge.begun.challenge.id])).rows[0].completed_at_ms).toBeNull();
    expect((await pool.query('SELECT consumed_at FROM rest_wallet_ceremonies WHERE id=$1', [challenge.begun.challenge.id])).rows[0].consumed_at).toBeNull();
  });
  it('enforces global and per-recovery admission across replicas', async () => {
    const value = await registered(), options = { maxResumes: 3, maxRecoveryResumes: 2 };
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => new PostgresWalletRecoveryFlowStore(pool, options).beginResume(value.flow.id)));
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(2);
    expect(attempts.filter(item => item.status === 'rejected').every(item => item.reason.status === 429)).toBe(true);
    const other = await registered(); await new PostgresWalletRecoveryFlowStore(pool, options).beginResume(other.flow.id);
    await expect(new PostgresWalletRecoveryFlowStore(pool, options).beginResume(other.flow.id)).rejects.toMatchObject({ status: 429 });
    const third = await existing(), begun = await recovery.begin(third.accountId);
    await expect(new PostgresWalletRecoveryFlowStore(pool, { maxFlows: 2 }).initialize({ recoveryId: begun.record.intent.id, flowToken: begun.flowToken, passkeyName: 'Third' })).rejects.toMatchObject({ status: 429 });
    expect((await pool.query('SELECT count(*)::int AS count FROM rest_wallet_recovery_resumes')).rows[0].count).toBe(3);
  });
  it('survives a new owner binding before activation and resumes the same activated replacement, then rejects supersession', async () => {
    const value = await registered(), raw = structuredClone(value.context), binding = raw.binding, candidate = value.record.candidate!, reviewed = await setup(value);
    binding.state.owners = [candidate.signerAddress, candidate.intent.recoveryOwner];
    Object.assign(binding.state.ownerProfile!.signer, { address: candidate.signerAddress, ...candidate.credential.publicKey });
    binding.state.stateHash = reviewed.stateHash;
    binding.state.evidence = { chainId: 8453, blockNumber: '101', blockHash: `0x${'88'.repeat(32)}`, timestamp: String(Math.floor(await now() / 1000)), source: 'onchain' };
    Object.assign(binding.authorization, { nonce: reviewed.input.nonce, expiresAt: reviewed.input.expiresAt });
    Object.assign(binding.authorization.setup!, { issuedAt: reviewed.input.issuedAt, grantId: reviewed.input.grant.id,
      botAddress: reviewed.input.grant.botAddress, scopes: reviewed.input.grant.scopes, grantExpiresAt: reviewed.input.grant.expiresAt, label: reviewed.input.grant.label });
    binding.authorization.digest = hashTypedData(passkeyOnboardingDocument(policy.origin, reviewed.input, binding.state));
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query('SELECT id FROM rest_accounts WHERE id=$1 FOR UPDATE', [value.context.accountId]);
      await bindSmartAccountInTransaction(client, binding, reviewed.input.issuedAt); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const before = await resume(value); await flows.completeResume(before.input);
    const mapped = createWalletRecoveryMapping(value.record, raw, await now(), policy.origin), c = mapped.context.credential;
    // Trusted activation metadata seam; actual contract rotation/atomic activation is covered by the EVM suite.
    await pool.query('UPDATE rest_wallet_credentials SET superseded_at=$2 WHERE account_id=$1', [c.accountId, await now()]);
    await pool.query(`INSERT INTO rest_wallet_credentials(rp_id,credential_id,enrollment_id,account_id,user_handle,public_key_x,public_key_y,backup_eligible,verified_at,recovery_receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [c.rpId, c.credentialId, c.enrollmentId, c.accountId, c.userHandle, c.publicKey.x, c.publicKey.y, c.backupEligible, c.verifiedAtMs, mapped.receipt]);
    await pool.query('UPDATE rest_wallet_recoveries SET activation=$2 WHERE id=$1', [value.flow.id, mapped.receipt]);
    const after = await resume(value); const resumed = await flows.completeResume(after.input); expect(resumed.flow.id).toBe(value.flow.id);
    await pool.query('UPDATE rest_wallet_credentials SET superseded_at=$2 WHERE account_id=$1 AND superseded_at IS NULL', [c.accountId, await now()]);
    await expect(flows.beginResume(value.flow.id)).rejects.toMatchObject({ status: 403 });
    await expect(flows.completeResume(after.input)).rejects.toMatchObject({ status: 403 });
  });
  it('keeps each other chain\'s exact approval once and refuses a missing, extra, wrong or stale one', async () => {
    const value = await registered(), candidate = value.record.candidate!, { priorSigner, recoveryOwner, accountId } = candidate.intent;
    // Synthetic chains: a current head and the Safe's owners, threshold and nonce on each.
    const safes: Record<number, { owners: Address[]; nonce: bigint; down?: boolean }> = { 8453: { owners: [priorSigner, recoveryOwner], nonce: 7n }, 10: { owners: [priorSigner, recoveryOwner], nonce: 3n } };
    const rpc: RestRpc = { async request(chainId, method, params) {
      const chain = safes[chainId]; if (!chain || chain.down) throw Error('unavailable');
      if (method === 'eth_chainId') return toHex(chainId);
      if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: `0x${chainId.toString(16).padStart(64, '0')}`, timestamp: toHex(Math.floor(Date.now() / 1000)) };
      const { functionName } = decodeFunctionData({ abi: safeAbi, data: (params[0] as { data: Hex }).data });
      if (functionName === 'getOwners') return encodeFunctionResult({ abi: safeAbi, functionName, result: chain.owners });
      if (functionName === 'getThreshold') return encodeFunctionResult({ abi: safeAbi, functionName, result: 1n });
      if (functionName === 'nonce') return encodeFunctionResult({ abi: safeAbi, functionName, result: chain.nonce });
      throw Error(`unexpected ${method}`);
    } };
    const deploy = (chainId: number, state = 'deployed') => pool.query(`INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,$2,$3,NULL,NULL,1)
      ON CONFLICT(account_id,chain_id) DO UPDATE SET state=EXCLUDED.state`, [accountId, chainId, state]);
    const chains = createWalletRecoveryChains({ pool, rpc }), sign = (review: Parameters<typeof walletRecoveryRotationDocument>[0], account = enrollmentBackupAccount) => account.signTypedData(walletRecoveryRotationDocument(review));
    // An account on Base only needs no other approval.
    expect(await chains.prepare(candidate)).toEqual([]); await chains.approve(candidate, []);
    // A deployment still settling may already be on chain: the review waits for it.
    await deploy(10, 'pending');
    await expect(chains.prepare(candidate)).rejects.toMatchObject({ status: 503, code: 'WALLET_RECOVERY_CHAIN_UNAVAILABLE' });
    await deploy(10);
    // A chain deployed after the review sends the user back to it.
    await expect(chains.approve(candidate, [])).rejects.toMatchObject({ status: 409, code: 'WALLET_RECOVERY_CHAINS_CHANGED' });
    safes[10]!.down = true;
    await expect(chains.prepare(candidate)).rejects.toMatchObject({ status: 503, code: 'WALLET_RECOVERY_CHAIN_UNAVAILABLE' });
    safes[10]!.down = false;
    const [review] = await chains.prepare(candidate);
    expect(review).toMatchObject({ chainId: 10, safeNonce: '3', priorSigner, replacementSigner: candidate.signerAddress });
    expect(walletRecoveryRotationDocument(review!).domain.chainId).toBe(10);
    // Wrong key, a Base-domain signature, a missing chain and an extra chain are all refused; nothing is kept.
    await expect(chains.approve(candidate, [{ chainId: 10, signature: await sign(review!, privateKeyToAccount(`0x${'22'.repeat(32)}`)) }])).rejects.toMatchObject({ status: 400 });
    const { chainId: _chain, ...onBase } = review!;
    await expect(chains.approve(candidate, [{ chainId: 10, signature: await sign(onBase) }])).rejects.toMatchObject({ status: 400 });
    await expect(chains.approve(candidate, [])).rejects.toMatchObject({ status: 409 });
    await expect(chains.approve(candidate, [{ chainId: 10, signature: await sign(review!) }, { chainId: 42161, signature: await sign(review!) }])).rejects.toMatchObject({ status: 409 });
    expect(await chains.status(value.flow.id)).toEqual([{ chainId: 10, name: 'Optimism', state: 'review' }]);
    // The nonce moved before approval: the review is read again and the old signature no longer fits.
    safes[10]!.nonce = 4n;
    const [fresh] = await chains.prepare(candidate);
    expect(fresh!.safeNonce).toBe('4');
    await expect(chains.approve(candidate, [{ chainId: 10, signature: await sign(review!) }])).rejects.toMatchObject({ status: 400 });
    await chains.approve(candidate, [{ chainId: 10, signature: await sign(fresh!) }]);
    expect(await chains.status(value.flow.id)).toEqual([{ chainId: 10, name: 'Optimism', state: 'approved' }]);
    const kept = (await pool.query('SELECT review,approval FROM rest_wallet_recovery_chains WHERE recovery_id=$1', [value.flow.id])).rows[0];
    expect(kept.review).toEqual(fresh); expect(kept.approval.ownerChange.to.toLowerCase()).toBe(accountId.slice(12));
    // Approved is kept as signed: a later read does not replace it, and a repeated approval is a no-op.
    safes[10]!.nonce = 5n;
    expect(await chains.prepare(candidate)).toEqual([fresh]);
    await chains.approve(candidate, [{ chainId: 10, signature: await sign(fresh!) }]);
    expect((await pool.query('SELECT review,approval FROM rest_wallet_recovery_chains WHERE recovery_id=$1', [value.flow.id])).rows[0]).toEqual(kept);
    // A chain whose owners are not the original pair cannot take this swap: it is reported, not reviewed.
    safes[42161] = { owners: [`0x${'ab'.repeat(20)}`, recoveryOwner], nonce: 0n }; await deploy(42161);
    expect(await chains.prepare(candidate)).toEqual([fresh]);
    expect(await chains.status(value.flow.id)).toEqual([{ chainId: 10, name: 'Optimism', state: 'approved' }, { chainId: 42161, name: 'Arbitrum', state: 'failed' }]);
  });
});
