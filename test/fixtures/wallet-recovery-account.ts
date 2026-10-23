import type { Pool } from 'pg';
import { enrollmentDigest } from '../../src/rest/wallet/enrollment.js';
import { bindSmartAccountInTransaction } from '../../src/rest/smartAccounts/postgres.js';
import { createWalletAuthorityContextFixture } from './wallet-authority-context.js';

/** A verified account with its passkey credential and bound smart account (modeled canonical metadata). */
export async function insertWalletAccount(pool: Pool, now: number) {
  const context = await createWalletAuthorityContextFixture(now), e = context.enrollment, c = context.credential;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO rest_accounts(id,owner_address,authority_chain_id,display_name,bio,created_at,updated_at)
      VALUES($1,$2,8453,'','',$3,$3)`, [context.accountId, context.accountId.slice(12), Math.floor(e.createdAt / 1000)]);
    await client.query(`INSERT INTO rest_wallet_enrollments(id,user_handle,state,intent_digest,created_at,expires_at,retain_until,
      intent,candidate,candidate_digest,creation,possession,safe_address,account_id,verified_at,receipt)
      VALUES($1,$2,'verified',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [e.intent.id, e.intent.userHandle, enrollmentDigest(e.intent), e.createdAt, e.intent.expiresAt, e.intent.expiresAt + 86400000,
      e.intent, e.candidate, e.candidateDigest, e.creation, e.possession, e.creation!.address.toLowerCase(), context.accountId, c.verifiedAtMs, e.receipt]);
    await client.query(`INSERT INTO rest_wallet_credentials(rp_id,credential_id,enrollment_id,account_id,user_handle,public_key_x,public_key_y,backup_eligible,verified_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [c.rpId, c.credentialId, c.enrollmentId, c.accountId, c.userHandle, c.publicKey.x, c.publicKey.y, c.backupEligible, c.verifiedAtMs]);
    await bindSmartAccountInTransaction(client, context.binding, context.binding.authorization.setup!.issuedAt);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return context;
}
