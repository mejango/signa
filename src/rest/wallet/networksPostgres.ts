import type { Pool, PoolClient } from "pg";
import { recoverTransactionAddress, type Address, type Hex, type TransactionSerialized } from "viem";
import { RestError } from "../core.js";
import type { WalletNetworkBundle, WalletNetworkRow, WalletNetworksStore } from "./networks.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never { throw new RestError(400, "WALLET_NETWORKS_INVALID", "Invalid network record."); }
type BundleRow = { id: string; account_id: string; family: string; state: string; bundle_uuid: string; document: Omit<WalletNetworkBundle, "id" | "accountId" | "family" | "state" | "createdAtMs" | "updatedAtMs">; created_at_ms: string; updated_at_ms: string };
type NetworkRow = { chain_id: string; state: string; bundle_id: string | null; tx_hash: string | null; updated_at_ms: string };
const bundleOf = (row: BundleRow): WalletNetworkBundle => ({ ...row.document, id: row.id, accountId: row.account_id, family: row.family as WalletNetworkBundle["family"],
  state: row.state as WalletNetworkBundle["state"], createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) });
const networkOf = (row: NetworkRow): WalletNetworkRow => ({ chainId: Number(row.chain_id), state: row.state as WalletNetworkRow["state"], bundleId: row.bundle_id,
  txHash: row.tx_hash as Hex | null, updatedAtMs: Number(row.updated_at_ms) });
/** Durable bundle and per-chain records. Authority for the account itself lives elsewhere; these rows only say what was quoted, paid and seen. */
export class PostgresWalletNetworksStore implements WalletNetworksStore {
  constructor(private readonly pool: Pool, private readonly sql: Pool | PoolClient = pool) {}
  async withPayer<T>(chainId: number, payer: Address, run: (store: WalletNetworksStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(), key = `${chainId}:${payer.toLowerCase()}`;
    // A disconnect between SQL calls must fail through the awaited scoped queries,
    // rather than becoming an unhandled client error while RPC or signing is pending.
    let connectionError: Error | undefined;
    const onError = (error: Error) => { connectionError = error; };
    client.on("error", onError);
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('rest_wallet_network_bundles'::regclass::oid::text||$1,0)) AS locked", [key]);
      if (!result.rows[0]!.locked) throw new RestError(409, "WALLET_NETWORKS_PAYER_BUSY", "Network funding is handling another payment. Try again shortly.");
      locked = true;
      // Funding reads and the irreversible signed write use this locked session. Losing
      // that connection must stop publication rather than continuing through the pool.
      return await run(new PostgresWalletNetworksStore(this.pool, client));
    } finally {
      try {
        if (connectionError) throw connectionError;
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('rest_wallet_network_bundles'::regclass::oid::text||$1,0))", [key]);
      } catch (error) { client.off("error", onError); client.release(true); throw error; }
      client.off("error", onError);
      client.release();
    }
  }
  /** Signed journals reserve nonces even after an unknown send, expiry or restart. */
  async assertPayerNonceAvailable(chainId: number, payer: Address, nonce: number): Promise<void> {
    const rows = (await this.sql.query<{ raw: TransactionSerialized }>(`SELECT document->'paymentTx'->>'raw' AS raw FROM rest_wallet_network_bundles
      WHERE (document->'payment'->>'chainId')::bigint=$1 AND (document->'paymentTx'->>'nonce')::numeric >= $2 LIMIT 256`, [chainId, nonce])).rows;
    if (rows.length === 256) throw new RestError(409, "WALLET_NETWORKS_PAYER_PENDING", "Network funding has retained payments to reconcile.");
    for (const row of rows) {
      if ((await recoverTransactionAddress({ serializedTransaction: row.raw })).toLowerCase() === payer.toLowerCase())
        throw new RestError(409, "WALLET_NETWORKS_PAYER_PENDING", "Network funding is waiting for an earlier signed payment. Check it before trying again.");
    }
  }
  async listNetworks(accountId: string): Promise<WalletNetworkRow[]> {
    return (await this.sql.query<NetworkRow>("SELECT chain_id,state,bundle_id,tx_hash,updated_at_ms FROM rest_wallet_networks WHERE account_id=$1 ORDER BY chain_id", [accountId])).rows.map(networkOf);
  }
  async listBundles(accountId: string): Promise<WalletNetworkBundle[]> {
    return (await this.sql.query<BundleRow>("SELECT * FROM rest_wallet_network_bundles WHERE account_id=$1 ORDER BY created_at_ms,id", [accountId])).rows.map(bundleOf);
  }
  async getBundle(accountId: string, id: string): Promise<WalletNetworkBundle | null> {
    if (!uuid.test(id)) invalid();
    const row = (await this.sql.query<BundleRow>("SELECT * FROM rest_wallet_network_bundles WHERE account_id=$1 AND id=$2", [accountId, id])).rows[0];
    return row ? bundleOf(row) : null;
  }
  async createBundle(bundle: WalletNetworkBundle, now: number): Promise<void> {
    const { id, accountId, family, state, createdAtMs: _c, updatedAtMs: _u, ...document } = bundle;
    if (!uuid.test(id) || !uuid.test(document.quote.bundleUuid)) invalid();
    await this.sql.query(`INSERT INTO rest_wallet_network_bundles(id,account_id,family,state,bundle_uuid,document,created_at_ms,updated_at_ms)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$7)`, [id, accountId, family, state, document.quote.bundleUuid, JSON.stringify(document), now]);
  }
  async transitionBundle(bundle: WalletNetworkBundle, from: WalletNetworkBundle["state"], now: number): Promise<boolean> {
    const { id, accountId, family: _f, state, createdAtMs: _c, updatedAtMs: _u, ...document } = bundle;
    const result = await this.sql.query("UPDATE rest_wallet_network_bundles SET state=$3,document=$4::jsonb,updated_at_ms=GREATEST(updated_at_ms,$5) WHERE account_id=$1 AND id=$2 AND state=$6",
      [accountId, id, state, JSON.stringify(document), now, from]);
    return result.rowCount === 1;
  }
  async claimNetworks(accountId: string, chainIds: number[], bundleId: string, now: number): Promise<number> {
    let claimed = 0;
    for (const chainId of chainIds) {
      const result = await this.sql.query(`INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,$2,'quoted',$3,NULL,$4)
        ON CONFLICT(account_id,chain_id) DO UPDATE SET state='quoted',bundle_id=EXCLUDED.bundle_id,tx_hash=NULL,updated_at_ms=GREATEST(rest_wallet_networks.updated_at_ms,EXCLUDED.updated_at_ms)
        WHERE rest_wallet_networks.state='failed'`, [accountId, chainId, bundleId, now]);
      claimed += result.rowCount ?? 0;
    }
    return claimed;
  }
  async upsertNetwork(accountId: string, row: Omit<WalletNetworkRow, "updatedAtMs">, now: number): Promise<void> {
    await this.sql.query(`INSERT INTO rest_wallet_networks(account_id,chain_id,state,bundle_id,tx_hash,updated_at_ms) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(account_id,chain_id) DO UPDATE SET state=EXCLUDED.state,bundle_id=EXCLUDED.bundle_id,tx_hash=EXCLUDED.tx_hash,updated_at_ms=GREATEST(rest_wallet_networks.updated_at_ms,EXCLUDED.updated_at_ms)
      WHERE (EXCLUDED.bundle_id IS NULL OR rest_wallet_networks.bundle_id=EXCLUDED.bundle_id)
        AND (rest_wallet_networks.state<>'deployed' OR EXCLUDED.state='deployed')`,
      [accountId, row.chainId, row.state, row.bundleId, row.txHash?.toLowerCase() ?? null, now]);
  }
}
