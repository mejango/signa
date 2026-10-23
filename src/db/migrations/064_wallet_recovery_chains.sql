-- A recovery's swap on each other chain the account is deployed on: the reviewed swap, the
-- recovery owner's exact approval, and the Relayr bundle that carries it. Base keeps its own lane.
-- A row is never deleted: an approved swap stays on record until the chain shows it or it fails.
CREATE TABLE rest_wallet_recovery_chains (
  recovery_id uuid NOT NULL REFERENCES rest_wallet_recoveries(id) ON DELETE RESTRICT,
  chain_id bigint NOT NULL CHECK (chain_id > 0 AND chain_id <> 8453),
  state text NOT NULL CHECK (state IN ('review','approved','submitted','updated','failed')),
  review jsonb CHECK (review IS NULL OR (jsonb_typeof(review) = 'object' AND octet_length(review::text) <= 8192)),
  approval jsonb CHECK (approval IS NULL OR (jsonb_typeof(approval) = 'object' AND octet_length(approval::text) <= 8192)),
  bundle_id uuid REFERENCES rest_wallet_network_bundles(id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Za-z0-9_-]{1,64}$'),
  checked_at_ms bigint NOT NULL DEFAULT 0 CHECK (checked_at_ms >= 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms > 0),
  PRIMARY KEY (recovery_id, chain_id),
  CHECK (state <> 'review' OR (review IS NOT NULL AND approval IS NULL)),
  CHECK (state NOT IN ('approved','submitted') OR (review IS NOT NULL AND approval IS NOT NULL)),
  CHECK (state <> 'submitted' OR bundle_id IS NOT NULL)
);
CREATE INDEX rest_wallet_recovery_chains_open ON rest_wallet_recovery_chains(checked_at_ms) WHERE state IN ('approved','submitted');
