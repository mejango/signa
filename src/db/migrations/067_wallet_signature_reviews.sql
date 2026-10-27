-- A signature review keeps the account's ERC-1271 signature: a 20-byte validator selector and Safe's
-- owner signatures (65-byte entry, 32-byte length, the passkey's contract signature of up to 2240
-- bytes), 2357 bytes at most. Its row key is 'signature:' and the review id; it has no operation.
ALTER TABLE rest_wallet_payment_reviews DROP CONSTRAINT rest_wallet_payment_reviews_signature_check;
ALTER TABLE rest_wallet_payment_reviews ADD CONSTRAINT rest_wallet_payment_reviews_signature_check
  CHECK (signature ~ '^0x[0-9a-f]+$' AND length(signature) BETWEEN 2 AND 4716 AND length(signature)%2=0);
