-- The account's owners and threshold as last read on each chain, at the block they were read.
-- A row is reused only while its block is still that chain's head; any other head re-reads it.
CREATE TABLE rest_wallet_owner_states (
  account text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  block_number numeric NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_timestamp numeric NOT NULL CHECK (block_timestamp >= 0),
  owners jsonb NOT NULL CHECK (jsonb_typeof(owners) = 'array' AND jsonb_array_length(owners) <= 64),
  threshold numeric NOT NULL CHECK (threshold >= 0),
  PRIMARY KEY (account, chain_id)
);
