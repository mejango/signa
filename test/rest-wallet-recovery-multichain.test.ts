import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { concatHex, encodeFunctionData, getAddress, hashTypedData, padHex, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RestRpc } from "../src/rest/core.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresWalletRecoveryStore } from "../src/rest/wallet/recoveryPostgres.js";
import { walletRecoveryDocument, type WalletRecoveryCandidate } from "../src/rest/wallet/recovery.js";
import { prepareWalletRecoveryRotation, walletRecoveryRotationDocument } from "../src/rest/wallet/recoveryRotation.js";
import { createWalletRecoveryChains } from "../src/rest/wallet/recoveryChains.js";
import { createWalletNetworks } from "../src/rest/wallet/networks.js";
import { PostgresWalletNetworksStore } from "../src/rest/wallet/networksPostgres.js";
import { assertOwnersConsistent, observeWalletOwners } from "../src/rest/wallet/ownerState.js";
import { assertWalletRecoveryRotationReview } from "../src/rest/web/walletRecoveryReview.js";
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR } from "../src/rest/sponsorship/constants.js";
import { RELAYR_PAYMENT_RUNTIME } from "./fixtures/relayr-payment.js";
import { insertWalletAccount } from "./fixtures/wallet-recovery-account.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createWalletDeviceIntent, prepareWalletDeviceAddition, prepareWalletDeviceCandidate, verifyWalletDeviceAddition, walletDeviceAdditionDocument } from "../src/rest/wallet/deviceAddition.js";
import { createWalletDeviceChains } from "../src/rest/wallet/deviceChains.js";
import { approveWalletOwnerChains, createWalletOwnerChains, recordWalletOwnerChain } from "../src/rest/wallet/ownerChains.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import type { WalletCentralSession } from "../src/rest/wallet/login.js";
import { walletOwnerChangeSafeTx } from "../src/rest/web/walletRecoveryReview.js";
import { lastFixturePrimary } from "./fixtures/wallet-authority-context.js";

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString && anvilAvailable() ? describe : describe.skip;
const policy = { rpId: "juicebox.center", origin: "https://juicebox.center" };
const proxy = JSON.parse(readFileSync(new URL("../src/rest/smartAccounts/stack/artifacts/SafeProxy.json", import.meta.url), "utf8")) as { deployedBytecode: Hex };
const singleton = JSON.parse(readFileSync(new URL("../src/rest/smartAccounts/stack/artifacts/SafeL2.json", import.meta.url), "utf8")) as { deployedBytecode: Hex; address: Address };
const safeAbi = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function addOwnerWithThreshold(address owner,uint256 threshold)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns(bool)",
]);
/** A stand-in passkey signer: approves any EIP-1271 check (it returns the called selector, which is the magic value). */
const approvesEverything = `0x6000357f${"ffffffff" + "00".repeat(28)}1660005260206000f3` as Hex;
const developer = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

suite("owner changes on every chain the account uses (PostgreSQL, Base plus two Anvil chains)", () => {
  const schema = `wallet_recovery_chains_${randomUUID().replaceAll("-", "")}`, nodes = new Map<number, { url: string; child: ChildProcess }>();
  let admin: Pool, pool: Pool;
  const call = async (chainId: number, method: string, params: readonly unknown[] = []) => {
    const body = await (await fetch(nodes.get(chainId)!.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result?: unknown; error?: { message: string } };
    if (body.error) throw Error(body.error.message);
    return body.result;
  };
  const rpc: RestRpc = { request: (chainId, method, params) => call(chainId, method, params) };
  async function mined(chainId: number, hash: unknown) {
    // Automine can answer before the block exists; the receipt decides.
    for (let i = 0; i < 200; i++) {
      const receipt = await call(chainId, "eth_getTransactionReceipt", [hash]) as { status?: string } | null;
      if (receipt) return receipt.status;
      await new Promise(done => setTimeout(done, 20));
    }
    throw Error("no receipt");
  }
  const send = async (chainId: number, to: Address, data: Hex) => mined(chainId, await call(chainId, "eth_sendTransaction", [{ from: developer, to, data }]));

  /** Relayr, faked: it runs each paid entry on its chain, except on chains told to fail. */
  function relayr(failing = new Set<number>(), creates?: { factory: Address; run: (chainId: number) => Promise<void> }) {
    const bundles = new Map<string, { entries: { chain: number; target: string; data: string; value: string }[]; ids: string[]; ran?: { state: string; hash?: string }[] }>();
    return { bundles, failing, quotes: 0,
      async createIndependent(entries: { chain: number; target: string; data: string; value: string }[]) {
        this.quotes++;
        const uuid = randomUUID(), deadline = Math.floor(Date.now() / 1000) + 900, ids = entries.map(() => randomUUID());
        bundles.set(uuid, { entries, ids });
        return { bundle_uuid: uuid, tx_uuids: ids,
          payment_info: [{ chain: 8453, target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, amount: "12000000000000", payment_deadline: String(deadline),
            calldata: `${RELAYR_PAYMENT_SELECTOR}${uuid.replaceAll("-", "")}${"0".repeat(32)}${deadline.toString(16).padStart(64, "0")}` }] };
      },
      async status(uuid: string) {
        const bundle = bundles.get(uuid)!;
        if (!bundle.ran) {
          // One sender per chain: the calls run one after another.
          const ran: { state: string; hash?: string }[] = [];
          for (const entry of bundle.entries) {
            if (failing.has(entry.chain)) { ran.push({ state: "Failed" }); continue; }
            const hash = await call(entry.chain, "eth_sendTransaction", [{ from: developer, to: entry.target, data: entry.data }]) as string;
            if (creates && entry.target.toLowerCase() === creates.factory.toLowerCase()) await creates.run(entry.chain);
            ran.push({ state: await mined(entry.chain, hash) === "0x1" ? "Included" : "Reverted", hash });
          }
          bundle.ran = ran;
        }
        // Relayr lists its rows in its own order; the client binds them by request.
        return { bundle_uuid: uuid, transactions: bundle.entries.map((entry, i) => ({ tx_uuid: bundle.ids[i], request: entry,
          status: { state: bundle.ran![i]!.state, data: bundle.ran![i]!.hash ? { hash: bundle.ran![i]!.hash } : {} } })) };
      } };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
    await migrate(pool);
    for (const chainId of [8453, 10, 42161]) {
      const server = createServer();
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const port = (server.address() as { port: number }).port;
      await new Promise<void>(done => server.close(() => done()));
      nodes.set(chainId, { url: `http://127.0.0.1:${port}`, child: spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent"]) });
      for (let i = 0; i < 200; i++) { try { await call(chainId, "eth_chainId"); break; } catch { await new Promise(done => setTimeout(done, 30)); } }
      await call(chainId, "anvil_setCode", [singleton.address, singleton.deployedBytecode]);
    }
    await call(8453, "anvil_setCode", [RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_RUNTIME]);
  }, 60_000);
  afterAll(async () => {
    for (const node of nodes.values()) node.child.kill("SIGKILL");
    await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_accounts,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_network_bundles,rest_wallet_networks,rest_wallet_owner_chains CASCADE"); });

  /** A proved recovery for an account whose Safe sits at the same address on all three chains, with the same owners. */
  async function account(chains = [8453, 10, 42161]) {
    const now = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
    const context = await insertWalletAccount(pool, now), recoveries = new PostgresWalletRecoveryStore(pool, policy);
    const begun = await recoveries.begin(context.accountId), intent = begun.record.intent;
    const key = createRegistration({ ...policy, userHandle: intent.userHandle, challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}` });
    const registered = await recoveries.register(intent.id, begun.flowToken, key.response), document = walletRecoveryDocument(registered.candidate!);
    await recoveries.prove(intent.id, begun.flowToken, { assertion: signGet({ ...key, ...policy, challenge: hashTypedData(document) }), backupSignature: await signBackupProof(document) });
    const candidate = registered.candidate! as WalletRecoveryCandidate, safe = getAddress(intent.accountId.slice(12));
    expect(candidate.intent.recoveryOwner.toLowerCase()).toBe(enrollmentBackupAccount.address.toLowerCase());
    for (const chainId of [8453, 10, 42161]) {
      if (chains.includes(chainId)) await deploySafe(chainId, safe, [candidate.intent.priorSigner, candidate.intent.recoveryOwner]);
      // Both passkey signers are stand-ins that approve any check, so only ownership decides who can sign.
      for (const signer of [candidate.intent.priorSigner, candidate.signerAddress]) await call(chainId, "anvil_setCode", [signer, approvesEverything]);
    }
    await deployedRows(intent.accountId, chains, now);
    return { candidate, safe, accountId: intent.accountId, id: intent.id, context, key };
  }
  /** The Safe at the account's address on one chain, set up with these owners, as the creation call leaves it. */
  async function deploySafe(chainId: number, safe: Address, owners: Address[]) {
    await call(chainId, "anvil_setCode", [safe, proxy.deployedBytecode]);
    await call(chainId, "anvil_setStorageAt", [safe, padHex("0x0", { size: 32 }), padHex(singleton.address, { size: 32 })]);
    expect(await send(chainId, safe, encodeFunctionData({ abi: safeAbi, functionName: "setup",
      args: [owners, 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] }))).toBe("0x1");
  }
  async function deployedRows(accountId: string, chains: number[], now: number) {
    for (const chainId of chains.filter(chainId => chainId !== 8453))
      await pool.query("INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,$2,'deployed',NULL,NULL,$3)", [accountId, chainId, now]);
  }
  function services(provider: ReturnType<typeof relayr>) {
    const payer = privateKeyToAccount(`0x${"88".repeat(32)}`);
    const networks = createWalletNetworks({ enrollments: { get: async () => null }, authority: { loadContext: async () => { throw Error("unused"); } },
      store: new PostgresWalletNetworksStore(pool), provider, rpc, payer: { address: payer.address, signTransaction: transaction => payer.signTransaction(transaction) } });
    return { payer, chains: createWalletRecoveryChains({ pool, rpc, networks, checkIntervalMs: 0 }) };
  }
  /** What the browser does: check every review against what it selected, then sign each with the one backup key it opened. */
  async function approveAll(candidate: WalletRecoveryCandidate, reviews: ReturnType<typeof prepareWalletRecoveryRotation>[]) {
    const selected = { id: candidate.intent.id, candidateDigest: reviews[0]!.candidateDigest, walletAddress: reviews[0]!.walletAddress,
      initializerHash: candidate.intent.initializerHash, recoveryOwner: candidate.intent.recoveryOwner, priorSigner: candidate.intent.priorSigner,
      replacementSigner: candidate.signerAddress, rotationContext: { publicKey: candidate.credential.publicKey,
        signerFactory: candidate.intent.manifest.ownerProfile!.signerFactory.address, verifiers: candidate.intent.manifest.ownerProfile!.p256Verifier.address } };
    return Promise.all(reviews.map(async review => {
      const response = JSON.parse(JSON.stringify({ review, document: walletRecoveryRotationDocument(review) }, (_key, value) => typeof value === "bigint" ? String(value) : value));
      return { chainId: review.chainId ?? 8453, signature: await enrollmentBackupAccount.signTypedData(assertWalletRecoveryRotationReview(response, selected)) };
    }));
  }
  /** Base's own lane is covered by the recovery relay suites; here Base's swap is executed directly with the same signature. */
  async function rotateBase(candidate: WalletRecoveryCandidate, safe: Address, signature: Hex, review: ReturnType<typeof prepareWalletRecoveryRotation>) {
    expect(await send(8453, safe, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
      args: [safe, 0n, review.swapOwner.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] }))).toBe("0x1");
    void candidate;
  }
  async function baseReview(candidate: WalletRecoveryCandidate, safe: Address) {
    return prepareWalletRecoveryRotation(candidate, { owners: [candidate.intent.priorSigner, candidate.intent.recoveryOwner], threshold: 1,
      safeNonce: String(BigInt(await call(8453, "eth_call", [{ to: safe, data: "0xaffed0e0" }, "latest"]) as string)) });
  }
  /** A no-op Safe transaction signed by one passkey signer, as the EIP-1271 contract signature Safe accepts. */
  async function canSign(chainId: number, safe: Address, signer: Address) {
    const signature = concatHex([padHex(signer, { size: 32 }), padHex(toHex(65), { size: 32 }), "0x00", padHex("0x0", { size: 32 })]);
    try {
      await call(chainId, "eth_call", [{ from: developer, to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
        args: [safe, 0n, "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] }) }, "latest"]);
      return true;
    } catch { return false; }
  }

  it("recovery rotates the passkey owner on every deployed chain in one ceremony", async () => {
    const { candidate, safe, accountId, id } = await account(), provider = relayr(), { chains, payer } = services(provider);
    await call(8453, "anvil_setBalance", [payer.address, toHex(10n ** 18n)]);
    for (const chainId of [8453, 10, 42161]) expect(await canSign(chainId, safe, candidate.intent.priorSigner)).toBe(true);
    // One review: Base's swap and one swap per other chain, each bound to its chain id and its own Safe nonce.
    const reviews = await chains.prepare(candidate);
    expect(reviews.map(review => review.chainId)).toEqual([10, 42161]);
    const base = await baseReview(candidate, safe), signatures = await approveAll(candidate, [base, ...reviews]);
    expect(new Set(signatures.map(item => item.signature)).size).toBe(3);
    await chains.approve(candidate, signatures.slice(1));
    expect(await chains.status(id)).toEqual([{ chainId: 10, name: "Optimism", state: "approved" }, { chainId: 42161, name: "Arbitrum", state: "approved" }]);
    // Nothing leaves before Base's own swap is on chain.
    await chains.tick();
    expect(provider.quotes).toBe(0);
    await rotateBase(candidate, safe, signatures[0]!.signature, base);
    await chains.tick();
    expect(provider.quotes).toBe(1);
    expect(await chains.status(id)).toEqual([{ chainId: 10, name: "Optimism", state: "submitted" }, { chainId: 42161, name: "Arbitrum", state: "submitted" }]);
    // One bundle for the family: both calls on both chains, paid once by Center's payer on Base.
    const [entries] = [...provider.bundles.values()].map(bundle => bundle.entries);
    expect(entries!.map(entry => entry.chain)).toEqual([10, 10, 42161, 42161]);
    for (let pass = 0; pass < 5 && (await chains.status(id)).some(chain => chain.state !== "updated"); pass++) await chains.tick();
    expect(await chains.status(id)).toEqual([{ chainId: 10, name: "Optimism", state: "updated" }, { chainId: 42161, name: "Arbitrum", state: "updated" }]);
    const states = await observeWalletOwners({ account: safe, chains: [8453, 10, 42161], rpc });
    expect(states.map(state => state.status)).toEqual(["consistent", "consistent", "consistent"]);
    for (const chainId of [8453, 10, 42161]) expect(() => assertOwnersConsistent(states, chainId)).not.toThrow();
    expect((await pool.query("SELECT count(*)::int AS count FROM rest_wallet_network_bundles WHERE account_id=$1", [accountId])).rows[0].count).toBe(1);
    // Converged rows are done: a later pass asks nobody anything.
    await chains.tick(); expect(provider.quotes).toBe(1);
  }, 60_000);

  it("a chain that fails to rotate stays diverged and blocks operations there while Base works", async () => {
    const { candidate, safe, id } = await account(), provider = relayr(new Set([42161])), { chains, payer } = services(provider);
    await call(8453, "anvil_setBalance", [payer.address, toHex(10n ** 18n)]);
    const reviews = await chains.prepare(candidate), base = await baseReview(candidate, safe), signatures = await approveAll(candidate, [base, ...reviews]);
    await chains.approve(candidate, signatures.slice(1));
    await rotateBase(candidate, safe, signatures[0]!.signature, base);
    for (let pass = 0; pass < 12 && (await chains.status(id)).some(chain => chain.state === "approved" || chain.state === "submitted"); pass++) await chains.tick();
    // Arbitrum is retried with the same signed calls, then reported; it never reads as done.
    expect(await chains.status(id)).toEqual([{ chainId: 10, name: "Optimism", state: "updated" }, { chainId: 42161, name: "Arbitrum", state: "failed" }]);
    expect(provider.quotes).toBe(3);
    const states = await observeWalletOwners({ account: safe, chains: [8453, 10, 42161], rpc });
    expect(states.map(state => state.status)).toEqual(["consistent", "consistent", "diverged"]);
    expect(() => assertOwnersConsistent(states, 8453)).not.toThrow();
    expect(() => assertOwnersConsistent(states, 10)).not.toThrow();
    expect(() => assertOwnersConsistent(states, 42161)).toThrow(expect.objectContaining({ status: 409, code: "WALLET_OWNERS_DIVERGED" }));
    // The old passkey still holds Arbitrum, which is why it stays blocked and shown.
    expect(await canSign(42161, safe, candidate.intent.priorSigner)).toBe(true);
    expect(await canSign(8453, safe, candidate.intent.priorSigner)).toBe(false);
  }, 60_000);

  it("a chain that failed is reviewed again with the backup, only where the old passkey remains, and converges", async () => {
    const { candidate, safe, id, accountId } = await account(), provider = relayr(new Set([42161])), { chains, payer } = services(provider);
    await call(8453, "anvil_setBalance", [payer.address, toHex(10n ** 18n)]);
    const reviews = await chains.prepare(candidate), base = await baseReview(candidate, safe), signatures = await approveAll(candidate, [base, ...reviews]);
    await chains.approve(candidate, signatures.slice(1));
    await rotateBase(candidate, safe, signatures[0]!.signature, base);
    for (let pass = 0; pass < 12 && (await chains.status(id)).some(chain => chain.state === "approved" || chain.state === "submitted"); pass++) await chains.tick();
    expect(await chains.status(id)).toEqual([{ chainId: 10, name: "Optimism", state: "updated" }, { chainId: 42161, name: "Arbitrum", state: "failed" }]);
    // A network the account reached during recovery, with no recovery row yet, waits for the user's approval too.
    await pool.query("INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,11155420,'deployed',NULL,NULL,1)", [accountId]);
    expect((await chains.status(id)).map(chain => `${chain.chainId}:${chain.state}`)).toEqual(["10:updated", "42161:failed", "11155420:review"]);
    await pool.query("DELETE FROM rest_wallet_networks WHERE chain_id=11155420");
    // The retry reviews only the chain still on the old passkey, at its current nonce, and is resumable: a second read returns the same review.
    provider.failing.clear();
    const retry = await chains.prepare(candidate);
    expect(retry.map(review => review.chainId)).toEqual([42161]);
    expect(await chains.prepare(candidate)).toEqual(retry);
    expect(await chains.status(id)).toEqual([{ chainId: 10, name: "Optimism", state: "updated" }, { chainId: 42161, name: "Arbitrum", state: "review" }]);
    await chains.approve(candidate, await approveAll(candidate, retry).then(items => items.map(({ chainId, signature }) => ({ chainId, signature }))));
    for (let pass = 0; pass < 6 && (await chains.status(id)).some(chain => chain.state !== "updated"); pass++) await chains.tick();
    expect(await chains.status(id)).toEqual([{ chainId: 10, name: "Optimism", state: "updated" }, { chainId: 42161, name: "Arbitrum", state: "updated" }]);
    for (const chainId of [8453, 10, 42161]) expect(await canSign(chainId, safe, candidate.intent.priorSigner)).toBe(false);
    // Nothing is left to review once every chain is updated.
    expect(await chains.prepare(candidate)).toEqual([]);
  }, 60_000);

  it("the old passkey cannot sign on any chain after convergence", async () => {
    const { candidate, safe, id } = await account(), provider = relayr(), { chains, payer } = services(provider);
    await call(8453, "anvil_setBalance", [payer.address, toHex(10n ** 18n)]);
    const reviews = await chains.prepare(candidate), base = await baseReview(candidate, safe), signatures = await approveAll(candidate, [base, ...reviews]);
    await chains.approve(candidate, signatures.slice(1));
    await rotateBase(candidate, safe, signatures[0]!.signature, base);
    for (let pass = 0; pass < 5 && (await chains.status(id)).some(chain => chain.state !== "updated"); pass++) await chains.tick();
    for (const chainId of [8453, 10, 42161]) {
      expect(await canSign(chainId, safe, candidate.intent.priorSigner)).toBe(false);
      expect(await canSign(chainId, safe, candidate.signerAddress)).toBe(true);
    }
    // A replayed signed swap cannot run again anywhere: each Safe's nonce moved past it.
    for (const [index, chainId] of [8453, 10, 42161].entries()) {
      const review = [base, ...reviews][index]!;
      await expect(call(chainId, "eth_call", [{ from: developer, to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
        args: [safe, 0n, review.swapOwner.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures[index]!.signature] }) }, "latest"])).rejects.toThrow();
    }
  }, 60_000);
  /** An account on all three chains with its original owners, and a new device that proved its passkey. */
  async function deviceAccount() {
    const now = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
    const context = await insertWalletAccount(pool, now), primary = lastFixturePrimary!, safe = getAddress(context.accountId.slice(12));
    const intent = createWalletDeviceIntent(context, { ...policy, nowMs: now, expiresAtMs: now + 120_000 });
    const device = createRegistration({ ...policy, userHandle: intent.userHandle, challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}` });
    const candidate = prepareWalletDeviceCandidate(intent, device.response), owners = [intent.primarySigner, intent.recoveryOwner];
    for (const chainId of [8453, 10, 42161]) {
      await deploySafe(chainId, safe, owners);
      for (const signer of [intent.primarySigner, candidate.signerAddress]) await call(chainId, "anvil_setCode", [signer, approvesEverything]);
    }
    await deployedRows(context.accountId, [10, 42161], now);
    const provider = relayr(), { payer } = services(provider), networks = createWalletNetworks({ enrollments: { get: async () => null },
      authority: { loadContext: async () => { throw Error("unused"); } }, store: new PostgresWalletNetworksStore(pool), provider, rpc,
      payer: { address: payer.address, signTransaction: transaction => payer.signTransaction(transaction) } });
    await call(8453, "anvil_setBalance", [payer.address, toHex(10n ** 18n)]);
    const passkey = { credentialId: context.credential.credentialId, userHandle: context.credential.userHandle, publicKey: context.credential.publicKey, backupEligible: context.credential.backupEligible };
    return { primary, safe, intent, candidate, owners, provider, networks, passkey };
  }

  it("device addition reaches every deployed chain", async () => {
    const { primary, safe, intent, candidate, owners, provider, networks, passkey } = await deviceAccount();
    const chains = createWalletDeviceChains({ pool, rpc, networks, checkIntervalMs: 0 });
    // One review per other chain, each its own SafeTx bound to that chain, all shown with Base's.
    const reviews = await chains.prepare(candidate);
    expect(reviews.map(review => review.chainId)).toEqual([10, 42161]);
    const challenges = reviews.map(review => hashTypedData(walletDeviceAdditionDocument(review)));
    const base = prepareWalletDeviceAddition(candidate, { owners, threshold: 1, safeNonce: "0" }), baseChallenge = hashTypedData(walletDeviceAdditionDocument(base));
    expect(new Set([baseChallenge, ...challenges]).size).toBe(3);
    // The primary passkey signs each chain's addition once; a chain left out refuses the whole approval.
    const signed = reviews.map((review, index) => ({ chainId: review.chainId!, assertion: signGet({ ...primary, ...policy, challenge: challenges[index]! }) }));
    await expect(chains.approve(candidate, signed.slice(0, 1), passkey)).rejects.toMatchObject({ code: "WALLET_DEVICE_CHAINS_CHANGED" });
    await expect(chains.approve(candidate, [{ chainId: 10, assertion: signed[1]!.assertion }, { chainId: 42161, assertion: signed[0]!.assertion }], passkey)).rejects.toMatchObject({ status: 403 });
    await chains.approve(candidate, signed, passkey);
    expect(await chains.status(intent.id)).toEqual([{ chainId: 10, name: "Optimism", state: "approved" }, { chainId: 42161, name: "Arbitrum", state: "approved" }]);
    // Nothing leaves before Base shows the device.
    await chains.tick();
    expect(provider.quotes).toBe(0);
    const calls = verifyWalletDeviceAddition(candidate, base, signGet({ ...primary, ...policy, challenge: baseChallenge }), passkey);
    expect(await send(8453, safe, calls.addOwner.data)).toBe("0x1");
    for (let pass = 0; pass < 5 && (await chains.status(intent.id)).some(chain => chain.state !== "updated"); pass++) await chains.tick();
    expect(await chains.status(intent.id)).toEqual([{ chainId: 10, name: "Optimism", state: "updated" }, { chainId: 42161, name: "Arbitrum", state: "updated" }]);
    expect(provider.quotes).toBe(1);
    const states = await observeWalletOwners({ account: safe, chains: [8453, 10, 42161], rpc });
    expect(states.map(state => state.status)).toEqual(["consistent", "consistent", "consistent"]);
    for (const chainId of [8453, 10, 42161]) expect(await canSign(chainId, safe, candidate.signerAddress)).toBe(true);
    // A second read finds nothing left to approve.
    expect(await chains.prepare(candidate)).toEqual([]);
  }, 60_000);

  it("an approval whose device never reached Base stops holding the other chains after a day", async () => {
    const { primary, intent, candidate, provider, networks, passkey } = await deviceAccount();
    const chains = createWalletDeviceChains({ pool, rpc, networks, checkIntervalMs: 0 });
    const reviews = await chains.prepare(candidate);
    await chains.approve(candidate, reviews.map(review => ({ chainId: review.chainId!, assertion: signGet({ ...primary, ...policy,
      challenge: hashTypedData(walletDeviceAdditionDocument(review)) }) })), passkey);
    await chains.tick();
    expect((await chains.status(intent.id)).map(chain => chain.state)).toEqual(["approved", "approved"]);
    // A day passes with Base never showing the device.
    await pool.query("UPDATE rest_wallet_owner_chains SET updated_at_ms=updated_at_ms-86400001 WHERE change_id=$1", [intent.id]);
    await chains.tick();
    expect((await chains.status(intent.id)).map(chain => chain.state)).toEqual(["failed", "failed"]);
    expect(provider.quotes).toBe(0);
  }, 60_000);

  it("a device whose signer creation failed on a chain is updated there only once its signer exists, by sending the creation again", async () => {
    const { primary, safe, intent, candidate, owners, provider, networks, passkey } = await deviceAccount();
    const chains = createWalletDeviceChains({ pool, rpc, networks, checkIntervalMs: 0 });
    const reviews = await chains.prepare(candidate);
    await chains.approve(candidate, reviews.map(review => ({ chainId: review.chainId!, assertion: signGet({ ...primary, ...policy,
      challenge: hashTypedData(walletDeviceAdditionDocument(review)) }) })), passkey);
    const base = prepareWalletDeviceAddition(candidate, { owners, threshold: 1, safeNonce: "0" });
    expect(await send(8453, safe, verifyWalletDeviceAddition(candidate, base, signGet({ ...primary, ...policy, challenge: hashTypedData(walletDeviceAdditionDocument(base)) }), passkey).addOwner.data)).toBe("0x1");
    // Optimism's signer creation does nothing: the owner lands there, but the device could not sign.
    await call(10, "anvil_setCode", [candidate.signerAddress, "0x"]);
    for (let pass = 0; pass < 3; pass++) await chains.tick();
    expect(await chains.status(intent.id)).toEqual([{ chainId: 10, name: "Optimism", state: "submitted" }, { chainId: 42161, name: "Arbitrum", state: "updated" }]);
    // The next bundle carries only Optimism's signer creation; its Safe nonce already moved.
    const last = [...provider.bundles.values()].at(-1)!.entries;
    expect(last.map(entry => entry.chain)).toEqual([10]);
    expect(last[0]!.target.toLowerCase()).not.toBe(safe.toLowerCase());
    // A paid creation gets time to show before another is paid; then it is sent again, as the same attempt count's step.
    const quotes = provider.quotes;
    await chains.tick(); await chains.tick();
    expect(provider.quotes).toBe(quotes);
    await pool.query("UPDATE rest_wallet_owner_chains SET updated_at_ms=updated_at_ms-300001 WHERE change_id=$1 AND chain_id=10", [intent.id]);
    await chains.tick();
    expect(provider.quotes).toBe(quotes + 1);
    expect((await pool.query("SELECT attempts,sent_step FROM rest_wallet_owner_chains WHERE change_id=$1 AND chain_id=10", [intent.id])).rows[0]).toEqual({ attempts: 2, sent_step: 1 });
    await call(10, "anvil_setCode", [candidate.signerAddress, approvesEverything]);
    await chains.tick();
    expect((await chains.status(intent.id)).map(chain => chain.state)).toEqual(["updated", "updated"]);
  }, 60_000);

  it("a second change for a chain cannot be approved while another is on its way there", async () => {
    const { primary, intent, candidate, passkey, networks, safe } = await deviceAccount();
    const chains = createWalletDeviceChains({ pool, rpc, networks, checkIntervalMs: 0 });
    const reviews = await chains.prepare(candidate);
    await chains.approve(candidate, reviews.map(review => ({ chainId: review.chainId!, assertion: signGet({ ...primary, ...policy,
      challenge: hashTypedData(walletDeviceAdditionDocument(review)) }) })), passkey);
    const other = randomUUID(), now = Date.now(), target = { safeNonce: "0", requires: [], add: [safe], remove: [] };
    await recordWalletOwnerChain(pool, { changeId: other, kind: "device", accountId: intent.accountId, chainId: 10, state: "review", review: { other }, target, reason: null, now });
    await expect(approveWalletOwnerChains(pool, other, [{ chainId: 10, review: { other }, approval: { calls: [] } }], now))
      .rejects.toMatchObject({ code: "WALLET_OWNER_CHAINS_CHANGED" });
  }, 60_000);

  /** An account recovered on Base only, with the creation stack on Base and Arbitrum, and the networks service as the recovered account sees it. */
  async function recoveredOnBase(creates = true) {
    const { candidate, safe, accountId, context, key } = await account([8453]);
    const enrollment = context.enrollment, manifest = enrollment.intent.manifest, creation = enrollment.creation!;
    // The creation stack carries the same bytes on Base and Arbitrum; the factory answers with the account's address.
    const pins = [manifest.singleton.address, manifest.safe7579.address, manifest.launchpad.address, manifest.creationProfile!.multiSend.address,
      manifest.ownerProfile!.signerFactory.address, manifest.ownerProfile!.signerSingleton.address, manifest.ownerProfile!.p256Verifier.address];
    for (const pin of pins) {
      const code = await call(8453, "eth_getCode", [pin, "latest"]) as Hex;
      for (const chainId of [8453, 42161]) await call(chainId, "anvil_setCode", [pin, code === "0x" ? "0x00" : code]);
    }
    for (const chainId of [8453, 42161]) await call(chainId, "anvil_setCode", [creation.transaction.to, `0x73${safe.slice(2).toLowerCase()}60005260206000f3`]);
    // Base is recovered: the replacement passkey holds it with the recovery owner.
    const base = await baseReview(candidate, safe), [signature] = await approveAll(candidate, [base]);
    await rotateBase(candidate, safe, signature!.signature, base);
    const recovered = { ...context, credential: { ...context.credential, credentialId: candidate.credential.credentialId, userHandle: candidate.credential.userHandle,
      publicKey: candidate.credential.publicKey, backupEligible: candidate.credential.backupEligible },
      binding: { ...context.binding, state: { ...context.binding.state, owners: [candidate.signerAddress, candidate.intent.recoveryOwner],
        ownerProfile: { ...context.binding.state.ownerProfile!, signer: { ...context.binding.state.ownerProfile!.signer, address: candidate.signerAddress, ...candidate.credential.publicKey } } } } };
    // Relayr's creation call leaves the original owners on the new chain, as the real factory does.
    const provider = relayr(new Set(), creates ? { factory: creation.transaction.to, run: chainId => deploySafe(chainId, safe, creation.owners) } : undefined);
    const payer = privateKeyToAccount(`0x${"88".repeat(32)}`);
    await call(8453, "anvil_setBalance", [payer.address, toHex(10n ** 18n)]);
    const networks = createWalletNetworks({ enrollments: new PostgresWalletEnrollmentStore(pool), authority: { loadContext: async () => recovered },
      store: new PostgresWalletNetworksStore(pool), provider, rpc, payer: { address: payer.address, signTransaction: transaction => payer.signTransaction(transaction) } });
    const owners = createWalletOwnerChains({ pool, rpc, networks, checkIntervalMs: 0 });
    const session = { id: randomUUID(), accountId, enrollmentId: enrollment.intent.id, rpId: policy.rpId, credentialId: candidate.credential.credentialId } as WalletCentralSession;
    return { candidate, safe, accountId, key, enrollment, creation, provider, networks, owners, session };
  }

  it("a network added after recovery gets the current owners through the recovery EOA, with no extra prompt, before it is usable", async () => {
    const { candidate, safe, key, creation, networks, owners, session } = await recoveredOnBase();
    expect((await networks.list(session)).backup).toBe("needed");
    // One quote: the deployment, and the owner calls that bring Arbitrum from the original owners to Base's.
    const quoted = await networks.quote(session, { chainIds: [42161] });
    expect(quoted.owners!.chains).toHaveLength(1);
    const update = quoted.owners!.chains[0]!;
    expect(update).toMatchObject({ chainId: 42161, safeNonce: "0", from: creation.owners.map(owner => getAddress(owner)), owners: [candidate.signerAddress, getAddress(candidate.intent.recoveryOwner)] });
    expect(update.steps).toHaveLength(1);
    // The backup key signs in software; the passkey is asked once, for the deployment it already approves.
    const signatures = await Promise.all(update.steps.map((step, index) => enrollmentBackupAccount.signTypedData(walletOwnerChangeSafeTx(safe, step, String(index), 42161))));
    const assertion = signGet({ ...key, ...policy, challenge: quoted.challenge! });
    await expect(networks.approve(session, { bundleId: quoted.bundle!.id, assertion })).rejects.toMatchObject({ code: "WALLET_NETWORKS_INVALID" });
    const wrong = await privateKeyToAccount(`0x${"77".repeat(32)}`).signTypedData(walletOwnerChangeSafeTx(safe, update.steps[0]!, "0", 42161));
    await expect(networks.approve(session, { bundleId: quoted.bundle!.id, assertion, owners: { changeId: quoted.owners!.changeId, signatures: [{ chainId: 42161, signatures: [wrong] }] } }))
      .rejects.toMatchObject({ code: "WALLET_NETWORKS_BACKUP_INVALID" });
    const approved = await networks.approve(session, { bundleId: quoted.bundle!.id, assertion, owners: { changeId: quoted.owners!.changeId, signatures: [{ chainId: 42161, signatures }] } });
    expect(approved.bundle.state).toBe("paid");
    // Deployed with the original owners: the chain is diverged and blocked until the update lands.
    const deployed = await networks.status(session);
    expect(deployed.networks.map(item => `${item.chainId}:${item.state}:${"owners" in item ? item.owners : ""}`)).toEqual(["8453:deployed:consistent", "42161:deployed:updating"]);
    const before = await observeWalletOwners({ account: safe, chains: [8453, 42161], rpc });
    expect(() => assertOwnersConsistent(before, 42161)).toThrow(expect.objectContaining({ code: "WALLET_OWNERS_DIVERGED" }));
    for (let pass = 0; pass < 5 && (await owners.status(quoted.owners!.changeId)).some(chain => chain.state !== "updated"); pass++) await owners.tick();
    expect(await owners.status(quoted.owners!.changeId)).toEqual([{ chainId: 42161, name: "Arbitrum", state: "updated" }]);
    const after = await observeWalletOwners({ account: safe, chains: [8453, 42161], rpc });
    expect(after.map(state => state.status)).toEqual(["consistent", "consistent"]);
    expect(await canSign(42161, safe, candidate.intent.priorSigner)).toBe(false);
    expect(await canSign(42161, safe, candidate.signerAddress)).toBe(true);
    expect((await networks.list(session)).networks.map(item => "owners" in item ? item.owners : null)).toEqual(["consistent", "consistent"]);
  }, 60_000);

  it("a network update stops when Base's owners move on before it is sent", async () => {
    const { candidate, safe, accountId, provider, networks, owners, session } = await recoveredOnBase(false);
    await deploySafe(10, safe, [candidate.intent.priorSigner, candidate.intent.recoveryOwner]);
    await deployedRows(accountId, [10], Date.now());
    const quoted = await networks.quote(session, { chainIds: [10] }), update = quoted.owners!.chains[0]!;
    const signatures = await Promise.all(update.steps.map((step, index) => enrollmentBackupAccount.signTypedData(walletOwnerChangeSafeTx(safe, step, String(BigInt(update.safeNonce) + BigInt(index)), 10))));
    await networks.approveOwners(session, { changeId: quoted.owners!.changeId, signatures: [{ chainId: 10, signatures }] });
    // Base gains an owner the update never brings: its additions still show on Base, but its owner set is no longer Base's.
    const stray = getAddress(`0x${"5a".repeat(20)}`);
    const signature = concatHex([padHex(candidate.signerAddress, { size: 32 }), padHex(toHex(65), { size: 32 }), "0x00", padHex("0x0", { size: 32 })]);
    expect(await send(8453, safe, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [safe, 0n,
      encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [stray, 1n] }), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] }))).toBe("0x1");
    await owners.tick();
    expect(await owners.status(quoted.owners!.changeId)).toEqual([{ chainId: 10, name: "Optimism", state: "failed" }]);
    expect(provider.quotes).toBe(0);
  }, 60_000);

  it("a network repaired to Base's owners runs its Safe transactions in nonce order, one bundle each", async () => {
    const { candidate, safe, accountId, provider, networks, owners, session } = await recoveredOnBase(false);
    // Optimism holds the old passkey and an owner the account never recorded: two Safe transactions bring it to Base's owners.
    const stray = getAddress(`0x${"5a".repeat(20)}`);
    await deploySafe(10, safe, [candidate.intent.priorSigner, stray, candidate.intent.recoveryOwner]);
    await deployedRows(accountId, [10], Date.now());
    expect((await networks.list(session)).networks.map(item => "owners" in item ? item.owners : null)).toEqual(["consistent", "diverged"]);
    // An update that failed is never taken as approved; a new quote replaces it.
    const failed = await networks.quote(session, { chainIds: [10] });
    await pool.query("UPDATE rest_wallet_owner_chains SET state='failed' WHERE change_id=$1", [failed.owners!.changeId]);
    await expect(networks.approveOwners(session, { changeId: failed.owners!.changeId, signatures: [] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_STATE" });
    const quoted = await networks.quote(session, { chainIds: [10] });
    expect(quoted.bundle).toBeNull();
    const update = quoted.owners!.chains[0]!;
    expect(update.steps).toHaveLength(2);
    const signatures = await Promise.all(update.steps.map((step, index) => enrollmentBackupAccount.signTypedData(walletOwnerChangeSafeTx(safe, step, String(BigInt(update.safeNonce) + BigInt(index)), 10))));
    const view = await networks.approveOwners(session, { changeId: quoted.owners!.changeId, signatures: [{ chainId: 10, signatures }] });
    expect(view.networks.map(item => "owners" in item ? item.owners : null)).toEqual(["consistent", "updating"]);
    await expect(networks.quote(session, { chainIds: [10] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_UPDATING" });
    for (let pass = 0; pass < 8 && (await owners.status(quoted.owners!.changeId)).some(chain => chain.state !== "updated"); pass++) await owners.tick();
    expect(await owners.status(quoted.owners!.changeId)).toEqual([{ chainId: 10, name: "Optimism", state: "updated" }]);
    // Each bundle carried the next Safe transaction only, so their nonces never raced.
    const bundles = [...provider.bundles.values()].map(bundle => bundle.entries.filter(entry => entry.target.toLowerCase() === safe.toLowerCase()).length);
    expect(bundles).toEqual([1, 1]);
    expect((await observeWalletOwners({ account: safe, chains: [8453, 10], rpc })).map(state => state.status)).toEqual(["consistent", "consistent"]);
    expect(await canSign(10, safe, stray)).toBe(false);
  }, 60_000);
});
