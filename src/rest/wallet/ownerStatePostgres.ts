import type { Pool } from "pg";
import type { Address, Hex } from "viem";
import type { WalletOwnerObservation, WalletOwnerStateStore } from "./ownerState.js";

type Row = { block_number: string; block_hash: string; block_timestamp: string; owners: Address[]; threshold: string };
export class PostgresWalletOwnerStateStore implements WalletOwnerStateStore {
  constructor(private readonly pool: Pool) {}
  async get(account: Address, chainId: number): Promise<WalletOwnerObservation | null> {
    const row = (await this.pool.query<Row>("SELECT block_number,block_hash,block_timestamp,owners,threshold FROM rest_wallet_owner_states WHERE account=$1 AND chain_id=$2",
      [account.toLowerCase(), chainId])).rows[0];
    return row ? { owners: row.owners, threshold: BigInt(row.threshold),
      block: { chainId, blockNumber: row.block_number, blockHash: row.block_hash as Hex, timestamp: row.block_timestamp, source: "onchain" } } : null;
  }
  async put(account: Address, observation: WalletOwnerObservation): Promise<void> {
    const { block } = observation;
    await this.pool.query(`INSERT INTO rest_wallet_owner_states(account,chain_id,block_number,block_hash,block_timestamp,owners,threshold) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (account,chain_id) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,block_timestamp=EXCLUDED.block_timestamp,
      owners=EXCLUDED.owners,threshold=EXCLUDED.threshold`,
    [account.toLowerCase(), block.chainId, block.blockNumber, block.blockHash.toLowerCase(), block.timestamp, JSON.stringify(observation.owners), observation.threshold.toString()]);
  }
}
