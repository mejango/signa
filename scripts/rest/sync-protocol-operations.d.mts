import type { ProtocolOperation } from "../../src/signaProtocol.js";

export function projectCatalog(document: unknown, supportedIds: readonly string[]): {
  source: { url: string; sha256: string };
  operations: ProtocolOperation[];
};
