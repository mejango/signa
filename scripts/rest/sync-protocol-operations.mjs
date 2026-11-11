import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const catalogUrl = "https://juicebox.center/api/v1/catalog/operations";
const destination = new URL("../../src/rest/protocol/operations.json", import.meta.url);
const maximumBytes = 5 * 1024 * 1024;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only refresh already-reviewed operations. Adding an operation also needs local
 * request/draft validation; fetching a catalog must never enable it by itself. */
export function projectCatalog(document, supportedIds) {
  if (!record(document) || !record(document.data) || !Array.isArray(document.data.operations))
    throw new Error("Expected Center's {data:{operations}} catalog response");
  const entries = new Map();
  for (const entry of document.data.operations) {
    if (!record(entry) || typeof entry.id !== "string" || entries.has(entry.id))
      throw new Error("Catalog contains an invalid or duplicate operation");
    entries.set(entry.id, entry);
  }
  const operations = supportedIds.map(id => {
    const entry = entries.get(id);
    if (!entry || entry.transaction !== true || entry.kind !== "prepare" ||
        typeof entry.description !== "string" || !Array.isArray(entry.sources) ||
        !entry.sources.includes("onchain") || !entry.sources.every(source => typeof source === "string") ||
        !record(entry.effects) || entry.effects.externalMutation !== false || entry.effects.idempotent !== true ||
        !record(entry.inputJsonSchema) || entry.inputJsonSchema.type !== "object" ||
        entry.method !== "POST" || entry.path !== `/api/v1/operations/${id}/plans`)
      throw new Error(`Missing or incompatible transaction operation: ${id}`);
    return { id, description: entry.description, kind: entry.kind, sources: entry.sources,
      transaction: true, effects: { externalMutation: false, idempotent: true }, inputJsonSchema: entry.inputJsonSchema };
  });
  const sha256 = createHash("sha256").update(JSON.stringify(operations)).digest("hex");
  return { source: { url: catalogUrl, sha256 }, operations };
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" }, check: { type: "boolean", default: false } } });
  const current = JSON.parse(await readFile(destination, "utf8"));
  let bytes;
  if (values.input) bytes = await readFile(values.input);
  else {
    const response = await fetch(catalogUrl, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
    if (!response.ok || !response.body) throw new Error(`Center catalog unavailable: HTTP ${response.status}`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximumBytes) throw new Error("Center catalog exceeds five MiB");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > maximumBytes) throw new Error("Center catalog exceeds five MiB");
  const projected = projectCatalog(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), current.operations.map(entry => entry.id));
  const serialized = JSON.stringify(projected, null, 2) + "\n";
  if (values.check) {
    if (await readFile(destination, "utf8") !== serialized) throw new Error("Protocol operation snapshot differs; refresh and review the diff");
  } else await writeFile(destination, serialized);
  console.log(`${values.check ? "Verified" : "Updated"} ${projected.operations.length} protocol operation schemas (${projected.source.sha256})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
