import { describeJBHookMetadata } from "@bananapus/nana-sdk-core/review/decode";

export type PayMetadataStep = { title: string; rows: [string, string][] };

/** A passkey payment may carry any JBMetadataResolver pay metadata. Pay metadata reaches only the
 * hooks the project configured, so the job here is a faithful description: the SDK's shared review
 * decoder (the one the web clients show), with entries it can't name kept as raw hook data under
 * their id. Every buyback minimum it reads must sit within the terminal `minReturnedTokens`, so the
 * terminal minimum stays the payer's guarantee whatever the hook does. Returns no steps for empty
 * metadata and throws for anything that isn't the resolver format. */
export function passkeyPayMetadataSteps(metadata: string, minReturnedTokens: bigint): PayMetadataStep[] {
  if (metadata.toLowerCase() === "0x") return [];
  const steps = describeJBHookMetadata("pay", metadata);
  if (!steps) throw new Error("A passkey payment carries empty or Juicebox hook metadata.");
  for (const { rows } of steps) for (const [label, value] of rows) {
    // Single readings label the minimum; ambiguous ones list it inside each reading.
    const minimums = label === "Minimum swap output" ? [value] : [...value.matchAll(/minimum swap output: (\d+)/g)].map(match => match[1]!);
    for (const minimum of minimums)
      if (BigInt(/^\d+/.exec(minimum)?.[0] ?? "x") > minReturnedTokens)
        throw new Error("A buyback minimum in the metadata exceeds the terminal minimum.");
  }
  return steps.map(({ title, rows }) => ({ title, rows: rows.map(([label, value]) => [label, value] as [string, string]) }));
}
