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

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString && anvilAvailable() ? describe : describe.skip;
const policy = { rpId: "juicebox.center", origin: "https://juicebox.center" };
const proxy = JSON.parse(readFileSync(new URL("../src/rest/smartAccounts/stack/artifacts/SafeProxy.json", import.meta.url), "utf8")) as { deployedBytecode: Hex };
const singleton = JSON.parse(readFileSync(new URL("../src/rest/smartAccounts/stack/artifacts/SafeL2.json", import.meta.url), "utf8")) as { deployedBytecode: Hex; address: Address };
const safeAbi = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns(bool)",
]);
/** A stand-in passkey signer: approves any EIP-1271 check (it returns the called selector, which is the magic value). */
const approvesEverything = `0x6000357f${"ffffffff" + "00".repeat(28)}1660005260206000f3` as Hex;
const developer = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

suite("recovery on every chain the account uses (PostgreSQL, Base plus two Anvil chains)", () => {
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
  function relayr(failing = new Set<number>()) {
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
  beforeEach(async () => { await pool.query("TRUNCATE rest_accounts,rest_wallet_enrollments,rest_wallet_ceremonies,rest_wallet_network_bundles,rest_wallet_networks CASCADE"); });

  /** A proved recovery for an account whose Safe sits at the same address on all three chains, with the same owners. */
  async function account() {
    const now = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
    const context = await insertWalletAccount(pool, now), recoveries = new PostgresWalletRecoveryStore(pool, policy);
    const begun = await recoveries.begin(context.accountId), intent = begun.record.intent;
    const key = createRegistration({ ...policy, userHandle: intent.userHandle, challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}` });
    const registered = await recoveries.register(intent.id, begun.flowToken, key.response), document = walletRecoveryDocument(registered.candidate!);
    await recoveries.prove(intent.id, begun.flowToken, { assertion: signGet({ ...key, ...policy, challenge: hashTypedData(document) }), backupSignature: await signBackupProof(document) });
    const candidate = registered.candidate! as WalletRecoveryCandidate, safe = getAddress(intent.accountId.slice(12));
    expect(candidate.intent.recoveryOwner.toLowerCase()).toBe(enrollmentBackupAccount.address.toLowerCase());
    for (const chainId of [8453, 10, 42161]) {
      await call(chainId, "anvil_setCode", [safe, proxy.deployedBytecode]);
      await call(chainId, "anvil_setStorageAt", [safe, padHex("0x0", { size: 32 }), padHex(singleton.address, { size: 32 })]);
      expect(await send(chainId, safe, encodeFunctionData({ abi: safeAbi, functionName: "setup",
        args: [[candidate.intent.priorSigner, candidate.intent.recoveryOwner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] }))).toBe("0x1");
      // Both passkey signers are stand-ins that approve any check, so only ownership decides who can sign.
      for (const signer of [candidate.intent.priorSigner, candidate.signerAddress]) await call(chainId, "anvil_setCode", [signer, approvesEverything]);
    }
    await pool.query(`INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,10,'deployed',NULL,NULL,$2),($1,42161,'deployed',NULL,NULL,$2)`,
      [intent.accountId, now]);
    return { candidate, safe, accountId: intent.accountId, id: intent.id };
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
});
