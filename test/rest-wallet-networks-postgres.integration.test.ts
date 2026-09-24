import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR } from "../src/rest/sponsorship/constants.js";
import { RELAYR_PAYMENT_RUNTIME } from "./fixtures/relayr-payment.js";
import { PostgresWalletEnrollmentStore } from "../src/rest/wallet/enrollmentPostgres.js";
import { PostgresWalletAuthorityStore } from "../src/rest/wallet/authorityPostgres.js";
import { createWalletNetworks, type WalletNetworksDependencies } from "../src/rest/wallet/networks.js";
import { PostgresWalletNetworksStore } from "../src/rest/wallet/networksPostgres.js";
import { completeWalletLoginFixture, walletLoginTestMigrations } from "./fixtures/wallet-login-setup.js";
import { signGet } from "./fixtures/wallet-enrollment-crypto.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const connectionString = process.env.TEST_DATABASE_URL;
const describeIf = connectionString ? describe : describe.skip;
describeIf("wallet networks against real PostgreSQL", () => {
  const schema = `rest_wallet_networks_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
    for (const name of walletLoginTestMigrations)
      await pool.query(await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => { await pool.query("TRUNCATE rest_wallet_networks,rest_wallet_network_bundles"); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  async function setup() {
    const fixture = await completeWalletLoginFixture(pool), session = fixture.session, creation = fixture.record.creation!;
    const bundleUuid = "a0a555ff-4444-4111-aaaa-333333333333", deadline = Math.floor(Date.now() / 1000) + 900, amount = "2000000000000003"; // under the mainnet cap
    const calldata = (`${RELAYR_PAYMENT_SELECTOR}${bundleUuid.replaceAll("-", "")}${"0".repeat(32)}${deadline.toString(16).padStart(64, "0")}`) as Hex;
    const calls: { chainId: number; method: string; params: readonly unknown[] }[] = [], sent: Hex[] = [], deployed = new Set<number>();
    const walletAddress = creation.address.toLowerCase(), uuids = (n: number) => Array.from({ length: n }, (_, i) => `b1b1b1b1-0000-4000-8000-00000000000${i}`);
    const requestsByBundle = new Map<string, unknown>();
    const provider = { requests: [] as unknown[], async createIndependent(entries: unknown) { provider.requests.push(entries);
        const id = provider.requests.length === 1 ? bundleUuid : randomUUID(); requestsByBundle.set(id, entries);
        return { bundle_uuid: id, tx_uuids: uuids((entries as unknown[]).length),
          payment_info: [{ chain: 8453, target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, amount,
            calldata: calldata.replace(bundleUuid.replaceAll("-", ""), id.replaceAll("-", "")), payment_deadline: String(deadline) }] }; },
      // Relayr lists the transactions in its own order, not the request order; the first status read binds them.
      async status(uuid: string) { const entries = requestsByBundle.get(uuid) as { chain: number; target: string; data: string; value: string }[], ids = uuids(entries.length);
        return { bundle_uuid: uuid, payment_received: true, transactions: [...entries].reverse().map((entry, i) => ({
          tx_uuid: ids[entries.length - 1 - i], request: { chain: entry.chain, target: entry.target, data: entry.data, value: entry.value },
          status: { state: deployed.has(entry.chain) ? "Included" : "Pending", data: deployed.has(entry.chain) ? { hash: keccak256(toHex(entry.chain)) } : {} } })) }; } };
    const rpc = { async request(chainId: number, method: string, params: readonly unknown[]) {
      calls.push({ chainId, method, params });
      const target = String(params[0]).toLowerCase();
      if (method === "eth_getCode") {
        if (target === RELAYR_PAYMENT_ADDRESS.toLowerCase()) return RELAYR_PAYMENT_RUNTIME;
        if (target === walletAddress) return deployed.has(chainId) ? "0x6001" : "0x";
        return `0x60${target.slice(2, 10)}`; // the creation stack: the same bytes on every chain
      }
      if (method === "eth_call") return `0x${"00".repeat(12)}${walletAddress.slice(2)}`; // the factory would create this account
      if (method === "eth_estimateGas") return "0x186a0";
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x3b9aca00", number: "0x10", hash: `0x${"11".repeat(32)}`, timestamp: toHex(Math.floor(Date.now() / 1000)) };
      if (method === "eth_getTransactionCount") return toHex(5 + sent.length);
      if (method === "eth_getBalance") return toHex(10n ** 18n);
      if (method === "eth_getTransactionByHash") return sent.some(raw => keccak256(raw) === params[0]) ? { hash: params[0] } : null;
      if (method === "eth_getTransactionReceipt") return sent.some(raw => keccak256(raw) === params[0]) ? { status: "0x1", transactionHash: params[0] } : null;
      if (method === "eth_sendRawTransaction") { sent.push(params[0] as Hex); return keccak256(params[0] as Hex); }
      throw new Error(`unexpected ${method}`); } };
    const payer = privateKeyToAccount(`0x${"55".repeat(32)}`);
    const dependencies: WalletNetworksDependencies = { enrollments: new PostgresWalletEnrollmentStore(pool), authority: new PostgresWalletAuthorityStore(pool),
      store: new PostgresWalletNetworksStore(pool), provider, rpc, payer: { address: payer.address, signTransaction: tx => payer.signTransaction(tx) } };
    return { fixture, session, creation, amount, calldata, calls, sent, deployed, provider, rpc, payer, dependencies,
      networks: createWalletNetworks(dependencies) };
  }

  it("quotes, approves with one passkey prompt, pays from Center's payer and records each chain as it shows the account", async () => {
    const { fixture, session, creation, amount, calldata, calls, sent, deployed, provider, rpc, payer, networks } = await setup();

    const before = await networks.list(session);
    expect(before.networks).toEqual([{ chainId: 8453, name: "Base", state: "deployed", txHash: null }]);
    expect(before.offered.map(item => item.chainId)).toEqual([10, 42161, 11155111, 11155420, 421614, 84532]);
    await expect(networks.quote(session, { chainIds: [10, 84532] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_INVALID" });
    await expect(networks.quote(session, { chainIds: [1] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_INVALID" });

    const quoted = await networks.quote(session, { chainIds: [42161, 10] });
    expect(provider.requests[0]).toEqual([10, 42161].map(chain => ({ chain, target: creation.transaction.to, data: creation.transaction.data, value: "0" })));
    expect(quoted.bundle).toMatchObject({ state: "quoted", chainIds: [10, 42161], centerPays: true, payment: { chainId: 8453, value: amount } });
    expect(quoted.challenge).toMatch(/^0x[0-9a-f]{64}$/);
    // The Base creation stack is read once per quote, not once per destination.
    const homeReads = calls.filter(call => call.chainId === 8453 && call.method === "eth_getCode").map(call => String(call.params[0]).toLowerCase());
    expect(new Set(homeReads).size).toBe(homeReads.length);
    expect(calls.some(call => call.chainId === 42161 && call.method === "eth_call")).toBe(true);
    expect(quoted.view.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:quoted", "42161:quoted"]);

    const rpId = session.rpId, origin = fixture.record.intent.origin;
    await expect(networks.approve(session, { bundleId: quoted.bundle!.id, assertion: signGet({ ...fixture.credential, challenge: keccak256("0x99"), rpId, origin }) }))
      .rejects.toMatchObject({ status: 403, code: "WALLET_NETWORKS_PROOF_INVALID" });
    const approved = await networks.approve(session, { bundleId: quoted.bundle!.id, assertion: signGet({ ...fixture.credential, challenge: quoted.challenge!, rpId, origin }) });
    expect(approved.bundle.state).toBe("paid"); expect(approved.replayed).toBe(false);
    expect(sent).toHaveLength(1);
    const tx = parseTransaction(sent[0]!);
    expect(tx).toMatchObject({ chainId: 8453, to: RELAYR_PAYMENT_ADDRESS.toLowerCase(), data: calldata, value: BigInt(amount), nonce: 5, gas: 150000n });
    expect(calls.some(call => call.chainId === 10 && call.method === "eth_call")).toBe(true); // the destination was simulated before quoting
    expect(calls.some(call => call.chainId === 8453 && call.method === "eth_estimateGas")).toBe(true); // and the payment before signing
    expect(approved.view.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:pending", "42161:pending"]);
    const replay = await networks.approve(session, { bundleId: quoted.bundle!.id, assertion: signGet({ ...fixture.credential, challenge: quoted.challenge!, rpId, origin }) });
    expect(replay.replayed).toBe(true); expect(sent).toHaveLength(1);
    // A quote for a chain already funded is refused; the account pays nothing twice.
    await expect(networks.quote(session, { chainIds: [10] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_STATE" });

    deployed.add(10);
    const partial = await networks.status(session);
    expect(partial.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:deployed", "42161:pending"]);
    expect(partial.networks[1]!.txHash).toBe(keccak256(toHex(10)));
    expect(partial.pending).toHaveLength(1);
    deployed.add(42161);
    const done = await networks.status(session);
    expect(done.networks.map(item => `${item.chainId}:${item.state}`)).toEqual(["8453:deployed", "10:deployed", "42161:deployed"]);
    expect(done.pending).toEqual([]);
    expect(done.offered.map(item => item.chainId)).toEqual([11155111, 11155420, 421614, 84532]);
    // A quote above what Center covers is refused before anything is stored.
    provider.requests.length = 0; sent.length = 0;
    const costly = { ...provider, async createIndependent(entries: unknown) { const q = await provider.createIndependent(entries); return { ...q, payment_info: [{ ...(q.payment_info[0] as object), chain: 84532, amount: (10n ** 17n).toString() }] }; } };
    const pricey = createWalletNetworks({ enrollments: new PostgresWalletEnrollmentStore(pool), authority: new PostgresWalletAuthorityStore(pool),
      store: new PostgresWalletNetworksStore(pool), provider: costly, rpc, payer: { address: payer.address, signTransaction: tx => payer.signTransaction(tx) } });
    await expect(pricey.quote(session, { chainIds: [84532] })).rejects.toMatchObject({ code: "WALLET_NETWORKS_QUOTE_UNSUPPORTED" });
    expect((await pricey.list(session)).offered.map(item => item.chainId)).toContain(84532);
  });
  it("serializes different bundles across replicas before signing and keeps their nonce reservations", async () => {
    const { fixture, session, dependencies, networks, sent } = await setup();
    const firstQuote = await networks.quote(session, { chainIds: [10] }), secondQuote = await networks.quote(session, { chainIds: [42161] });
    const approval = (quote: typeof firstQuote) => ({ bundleId: quote.bundle!.id, assertion: signGet({ ...fixture.credential,
      challenge: quote.challenge!, rpId: session.rpId, origin: fixture.record.intent.origin }) });
    const replica = createWalletNetworks({ ...dependencies, store: new PostgresWalletNetworksStore(pool) });
    const entered = deferred(), release = deferred();
    const sign = dependencies.payer!.signTransaction;
    const signer = vi.spyOn(dependencies.payer!, "signTransaction").mockImplementationOnce(async transaction => {
      entered.resolve(); await release.promise; return sign(transaction);
    });
    const first = networks.approve(session, approval(firstQuote));
    try {
      await entered.promise;
      await expect(replica.approve(session, approval(secondQuote))).rejects.toMatchObject({ code: "WALLET_NETWORKS_PAYER_BUSY" });
      expect(signer).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(0);
    } finally { release.resolve(); }
    expect((await first).bundle.state).toBe("paid");
    expect((await replica.approve(session, approval(secondQuote))).bundle.state).toBe("paid");
    expect(sent.map(raw => parseTransaction(raw).nonce)).toEqual([5, 6]);
    // Even a lagging nonce read cannot reuse a signed payment retained by another replica.
    await expect(new PostgresWalletNetworksStore(pool).assertPayerNonceAvailable(8453, dependencies.payer!.address, 5))
      .rejects.toMatchObject({ code: "WALLET_NETWORKS_PAYER_PENDING" });
  });

  it("funds only the verified bundle if the caller changes its input during verification", async () => {
    const { fixture, session, dependencies, networks, sent } = await setup();
    const firstQuote = await networks.quote(session, { chainIds: [10] }), secondQuote = await networks.quote(session, { chainIds: [42161] });
    const input = { bundleId: firstQuote.bundle!.id, assertion: signGet({ ...fixture.credential,
      challenge: firstQuote.challenge!, rpId: session.rpId, origin: fixture.record.intent.origin }) };
    const entered = deferred(), release = deferred(), load = dependencies.authority.loadContext.bind(dependencies.authority);
    vi.spyOn(dependencies.authority, "loadContext").mockImplementationOnce(async accountId => {
      const context = await load(accountId); entered.resolve(); await release.promise; return context;
    });
    const approval = networks.approve(session, input);
    await entered.promise; input.bundleId = secondQuote.bundle!.id; release.resolve();
    expect((await approval).bundle.id).toBe(firstQuote.bundle!.id);
    const first = await dependencies.store.getBundle(session.accountId, firstQuote.bundle!.id);
    const second = await dependencies.store.getBundle(session.accountId, secondQuote.bundle!.id);
    expect(first!.state).toBe("paid"); expect(second!.state).toBe("quoted");
    expect(sent).toHaveLength(1); expect(parseTransaction(sent[0]!).data).toBe(first!.payment.data);
  });

  it("does not publish signed bytes after losing the database session that owns the sender lock", async () => {
    const { fixture, session, dependencies, networks, sent } = await setup();
    const quote = await networks.quote(session, { chainIds: [10] });
    const input = { bundleId: quote.bundle!.id, assertion: signGet({ ...fixture.credential,
      challenge: quote.challenge!, rpId: session.rpId, origin: fixture.record.intent.origin }) };
    const fundingPool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 });
    const client = await fundingPool.connect(), pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const disconnected = new Promise<void>(resolve => { client.once("end", resolve); });
    client.release();
    const entered = deferred(), release = deferred(), sign = dependencies.payer!.signTransaction;
    vi.spyOn(dependencies.payer!, "signTransaction").mockImplementationOnce(async transaction => {
      entered.resolve(); await release.promise; return sign(transaction);
    });
    const replica = createWalletNetworks({ ...dependencies, store: new PostgresWalletNetworksStore(fundingPool) });
    const approval = replica.approve(session, input);
    const rejected = expect(approval).rejects.toThrow();
    try {
      await entered.promise;
      await admin.query("SELECT pg_terminate_backend($1)", [pid]); await disconnected;
      release.resolve(); await rejected;
      expect(sent).toHaveLength(0);
      expect((await dependencies.store.getBundle(session.accountId, quote.bundle!.id))!.paymentTx).toBeNull();
      // No payment was published or retained, so a new session can safely retry.
      expect((await networks.approve(session, input)).bundle.state).toBe("paid");
      expect(sent).toHaveLength(1);
    } finally { release.resolve(); await approval.catch(() => undefined); await fundingPool.end(); }
  });

  it("retains unknown signed payments across restart and expiry without treating another nonce as payment", async () => {
    const { fixture, session, dependencies, networks, rpc, sent } = await setup();
    const firstQuote = await networks.quote(session, { chainIds: [10] }), secondQuote = await networks.quote(session, { chainIds: [42161] });
    const approval = (quote: typeof firstQuote) => ({ bundleId: quote.bundle!.id, assertion: signGet({ ...fixture.credential,
      challenge: quote.challenge!, rpId: session.rpId, origin: fixture.record.intent.origin }) });
    const request = rpc.request;
    const signing = vi.spyOn(dependencies.payer!, "signTransaction");
    vi.spyOn(rpc, "request").mockImplementation(async (chainId, method, params) => {
      if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") return null;
      if (method === "eth_getTransactionCount") return params[1] === "latest" ? "0x6" : "0x5";
      return request(chainId, method, params);
    });
    expect((await networks.approve(session, approval(firstQuote))).bundle.state).toBe("paying");
    const restarted = createWalletNetworks({ ...dependencies, store: new PostgresWalletNetworksStore(pool) });
    await expect(restarted.approve(session, approval(secondQuote))).rejects.toMatchObject({ code: "WALLET_NETWORKS_PAYER_PENDING" });
    expect(signing).toHaveBeenCalledTimes(1);
    const beforeExpiry = await restarted.status(session);
    expect(beforeExpiry.pending).toContainEqual({ id: firstQuote.bundle!.id, state: "paying", chainIds: [10] });
    expect(new Set(sent).size).toBe(1); // Retries may publish only the original bytes.
    const sends = sent.length;
    const expired = createWalletNetworks({ ...dependencies, store: new PostgresWalletNetworksStore(pool), now: () => Date.now() + 1_000_000 });
    const afterExpiry = await expired.status(session);
    expect(afterExpiry.pending).toContainEqual({ id: firstQuote.bundle!.id, state: "paying", chainIds: [10] });
    expect(afterExpiry.offered.map(network => network.chainId)).not.toContain(10);
    expect(sent).toHaveLength(sends);
    await expect(new PostgresWalletNetworksStore(pool).assertPayerNonceAvailable(8453, dependencies.payer!.address, 5))
      .rejects.toMatchObject({ code: "WALLET_NETWORKS_PAYER_PENDING" });
  });

  it("keeps the winning quote's chain reservation when a concurrent quote loses", async () => {
    const { session, dependencies, networks, provider } = await setup();
    const replica = createWalletNetworks({ ...dependencies, store: new PostgresWalletNetworksStore(pool) });
    const ready = deferred(), create = provider.createIndependent;
    let quotes = 0;
    vi.spyOn(provider, "createIndependent").mockImplementation(async entries => {
      const result = await create(entries); if (++quotes === 2) ready.resolve(); await ready.promise; return result;
    });
    const results = await Promise.allSettled([networks.quote(session, { chainIds: [10] }), replica.quote(session, { chainIds: [10] })]);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = results.find(result => result.status === "fulfilled")!;
    expect(winner.status).toBe("fulfilled"); if (winner.status !== "fulfilled") throw new Error("No winning quote");
    expect(await dependencies.store.listNetworks(session.accountId)).toEqual([
      expect.objectContaining({ chainId: 10, bundleId: winner.value.bundle!.id, state: "quoted" }),
    ]);
    // A stale status from the same bundle cannot downgrade a deployed account either.
    await dependencies.store.upsertNetwork(session.accountId, { chainId: 10, bundleId: winner.value.bundle!.id, state: "deployed", txHash: null }, Date.now());
    await dependencies.store.upsertNetwork(session.accountId, { chainId: 10, bundleId: winner.value.bundle!.id, state: "pending", txHash: null }, Date.now());
    expect((await dependencies.store.listNetworks(session.accountId))[0]!.state).toBe("deployed");
  });
});
