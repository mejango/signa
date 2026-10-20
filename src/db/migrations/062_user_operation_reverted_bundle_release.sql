-- A whole-bundle revert rolled the nonce back: its reservation is released for a fresh operation at
-- that very nonce, and the operation holds its wallet to that nonce until the chain settles it.
-- Operations already reverted this way kept their reservation and blocked every later payment. Each
-- is released and, like a fresh one, holds its wallet to its nonce until the chain settles it. The
-- claim's sender locks come first, so a claim that checked the unsettled set commits before this.
SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM (
  SELECT DISTINCT 'user-operation-sender:' || (document->>'chainId')::bigint || ':' || lower(document->>'sender') AS key
  FROM rest_user_operations
  WHERE document->>'state'='reverted' AND document->'observation'->'receipt'->>'status'='reverted'
    AND document->'observation'->'receipt'->>'canonical'='true' AND NOT document ? 'nonceReleasedAt'
  ORDER BY key) senders;
CREATE INDEX rest_user_operations_released_idx ON rest_user_operations(((document->>'chainId')::bigint),lower(document->>'sender'))
  WHERE document ? 'nonceReleasedAt' AND NOT document ? 'retiredSettledAt';
UPDATE rest_user_operations
  SET revision=revision+1,
    document=document || jsonb_build_object('revision', revision+1, 'nonceReleasedAt', floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
  WHERE document->>'state'='reverted' AND document->'observation'->'receipt'->>'status'='reverted'
    AND document->'observation'->'receipt'->>'canonical'='true' AND NOT document ? 'nonceReleasedAt';
DELETE FROM rest_user_operation_nonces n USING rest_user_operations o
  WHERE o.id=n.user_operation_id AND o.document ? 'nonceReleasedAt';
