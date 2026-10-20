-- An approved operation Signa refused to send, retired under the claim's row lock: it is never
-- claimed, resent or approved again.
ALTER TABLE rest_user_operations DROP CONSTRAINT rest_user_operations_check;
ALTER TABLE rest_user_operations ADD CONSTRAINT rest_user_operations_check CHECK (
  jsonb_typeof(document)='object' AND octet_length(document::text)<=2097152
  AND document->>'id'=id AND document->'actor'->>'accountId'=account_id
  AND document->'actor'->>'principalId'=principal_id AND document->>'planId'=plan_id
  AND document->>'preparationKey'=preparation_key AND (document->>'revision')::bigint=revision
  AND document->>'state' IN ('prepared','submitting','submission_unknown','pending','unknown','confirming','confirmed','reverted','expired','retired')
  AND (document->>'state'<>'retired' OR NOT document ? 'submission')
);
-- Unsettled retired operations by chain and sender, across every account that binds the Safe.
CREATE INDEX rest_user_operations_retired_idx ON rest_user_operations(((document->>'chainId')::bigint),lower(document->>'sender'))
  WHERE document->>'state'='retired' AND NOT document ? 'retiredSettledAt';
