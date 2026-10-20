import { describeJBHookMetadata } from "@bananapus/nana-sdk-core/review/decode";

export type PayMetadataStep = { title: string; rows: [string, string][] };

/** A passkey payment may carry any JBMetadataResolver pay metadata. Pay metadata reaches only the
 * hooks the project configured, so the job here is a faithful description: the SDK's shared review
 * decoder (the one the web clients show), with entries it can't name kept as raw hook data under
 * their id. A buyback minimum may sit above the terminal `minReturnedTokens`: with the reserved
 * split honored (`skipSplits` false, or hook 1.1.1) it covers the swap and leftover mint before the
 * split, while the terminal minimum is the beneficiary's share. A higher hook minimum can only make
 * the payment revert; the terminal minimum stays the payer's guarantee. Returns no steps for empty
 * metadata and throws for anything that isn't the resolver format. */
export function passkeyPayMetadataSteps(metadata: string): PayMetadataStep[] {
  if (metadata.toLowerCase() === "0x") return [];
  const steps = describeJBHookMetadata("pay", metadata);
  if (!steps) throw new Error("A passkey payment carries empty or Juicebox hook metadata.");
  return steps.map(({ title, rows }) => ({ title, rows: rows.map(([label, value]) => [label, value] as [string, string]) }));
}
