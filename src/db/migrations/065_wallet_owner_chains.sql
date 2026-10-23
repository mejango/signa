-- Every owner change Signa sends to the account's chains other than Base, in one table: a recovery's swap,
-- a device's addition, and a network's update to Base's owners. `target` says in owner terms what must still
-- hold for the signed calls to run and what shows they ran; `approval` holds the exact calls in order.
ALTER TABLE rest_wallet_recovery_chains RENAME TO rest_wallet_owner_chains;
ALTER TABLE rest_wallet_owner_chains RENAME COLUMN recovery_id TO change_id;
ALTER TABLE rest_wallet_owner_chains DROP CONSTRAINT rest_wallet_recovery_chains_recovery_id_fkey;
ALTER INDEX rest_wallet_recovery_chains_pkey RENAME TO rest_wallet_owner_chains_pkey;
ALTER INDEX rest_wallet_recovery_chains_open RENAME TO rest_wallet_owner_chains_open;
ALTER TABLE rest_wallet_owner_chains ADD COLUMN kind text NOT NULL DEFAULT 'recovery' CHECK (kind IN ('recovery','device','network'));
ALTER TABLE rest_wallet_owner_chains ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE rest_wallet_owner_chains ADD COLUMN account_id text;
UPDATE rest_wallet_owner_chains c SET account_id=r.account_id FROM rest_wallet_recoveries r WHERE r.id=c.change_id;
ALTER TABLE rest_wallet_owner_chains ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE rest_wallet_owner_chains ADD CONSTRAINT rest_wallet_owner_chains_account CHECK (account_id ~ '^eip155:8453:0x[0-9a-f]{40}$');
ALTER TABLE rest_wallet_owner_chains ADD COLUMN target jsonb CHECK (target IS NULL OR (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 4096));
UPDATE rest_wallet_owner_chains SET target=jsonb_build_object('safeNonce',review->'safeNonce','requires',jsonb_build_array(review->'priorSigner'),
  'add',jsonb_build_array(review->'replacementSigner'),'remove',jsonb_build_array(review->'priorSigner')) WHERE review IS NOT NULL;
UPDATE rest_wallet_owner_chains SET approval=jsonb_build_object('calls',jsonb_build_array(approval->'createSigner',approval->'ownerChange'),'safeTxHash',approval->'safeTxHash')
  WHERE approval IS NOT NULL;
-- A network's update carries several Safe transactions, each with its signature.
ALTER TABLE rest_wallet_owner_chains DROP CONSTRAINT rest_wallet_recovery_chains_review_check;
ALTER TABLE rest_wallet_owner_chains DROP CONSTRAINT rest_wallet_recovery_chains_approval_check;
ALTER TABLE rest_wallet_owner_chains ADD CONSTRAINT rest_wallet_owner_chains_review CHECK (review IS NULL OR (jsonb_typeof(review) = 'object' AND octet_length(review::text) <= 32768));
ALTER TABLE rest_wallet_owner_chains ADD CONSTRAINT rest_wallet_owner_chains_approval CHECK (approval IS NULL OR (jsonb_typeof(approval) = 'object'
  AND jsonb_typeof(approval->'calls') = 'array' AND octet_length(approval::text) <= 32768));
ALTER TABLE rest_wallet_owner_chains ADD CONSTRAINT rest_wallet_owner_chains_target_open CHECK (state NOT IN ('review','approved','submitted') OR target IS NOT NULL);
-- A network's update sends its Safe transactions one per bundle; attempts count for the one last sent.
ALTER TABLE rest_wallet_owner_chains ADD COLUMN sent_step integer NOT NULL DEFAULT 0 CHECK (sent_step BETWEEN 0 AND 64);
CREATE INDEX rest_wallet_owner_chains_account ON rest_wallet_owner_chains(account_id) WHERE state IN ('review','approved','submitted');
-- One approved change per account and chain is on its way at a time, so two never fund calls for the same Safe nonce.
-- An older approved change that never left gives way to a sent or newer one; a sent one keeps its payment record.
UPDATE rest_wallet_owner_chains c SET state='failed',reason='superseded' WHERE c.state='approved' AND EXISTS (SELECT 1 FROM rest_wallet_owner_chains o
  WHERE o.account_id=c.account_id AND o.chain_id=c.chain_id AND o.change_id<>c.change_id
    AND (o.state='submitted' OR (o.state='approved' AND (o.updated_at_ms,o.change_id) > (c.updated_at_ms,c.change_id))));
CREATE UNIQUE INDEX rest_wallet_owner_chains_underway ON rest_wallet_owner_chains(account_id,chain_id) WHERE state IN ('approved','submitted');
