-- Signa's per-account, per-chain daily limit on Pimlico sponsorship. A row reserves an operation's
-- maximum gas cost from preparation; it lapses at expires_at until the owner signs (then NULL), is
-- replaced by spent_wei from the canonical UserOperationEvent, or is released on proven non-submission.
-- An unknown outcome keeps its reservation.
CREATE TABLE rest_sponsor_cap_reservations (
  operation_id text PRIMARY KEY CHECK (octet_length(operation_id) BETWEEN 1 AND 192),
  chain_id bigint NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  account_id text NOT NULL CHECK (octet_length(account_id) BETWEEN 1 AND 256),
  reserved_wei numeric(78,0) NOT NULL CHECK (reserved_wei > 0 AND reserved_wei < 2::numeric^256),
  spent_wei numeric(78,0) CHECK (spent_wei >= 0 AND spent_wei < 2::numeric^256),
  created_at bigint NOT NULL CHECK (created_at > 0 AND created_at <= 9007199254740991),
  expires_at bigint CHECK (expires_at > 0 AND expires_at <= 9007199254740991),
  released_at bigint CHECK (released_at > 0 AND released_at <= 9007199254740991)
);
CREATE INDEX rest_sponsor_cap_reservations_account_idx ON rest_sponsor_cap_reservations(chain_id, account_id, created_at);
