import { describe, expect, it } from "vitest";
import { projectCatalog } from "../scripts/rest/sync-protocol-operations.mjs";

const operation = (id = "prepare_pay") => ({
  id, description: "Prepare a payment", kind: "prepare", sources: ["onchain"], transaction: true,
  effects: { externalMutation: false, idempotent: true }, inputJsonSchema: { type: "object", properties: {} },
  method: "POST", path: `/api/v1/operations/${id}/plans`,
});
const document = (...operations: unknown[]) => ({ data: { operations } });

describe("reviewed Center operation snapshot", () => {
  it("refreshes only already-reviewed IDs and records deterministic provenance", () => {
    const snapshot = projectCatalog(document(operation(), operation("prepare_new")), ["prepare_pay"]);
    expect(snapshot.operations.map(entry => entry.id)).toEqual(["prepare_pay"]);
    expect(snapshot.source.url).toBe("https://juicebox.center/api/v1/catalog/operations");
    expect(snapshot.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(projectCatalog(document(operation()), ["prepare_pay"])).toEqual(snapshot);
    const changed = { ...operation(), inputJsonSchema: { type: "object", required: ["account"] } };
    expect(projectCatalog(document(changed), ["prepare_pay"]).source.sha256).not.toBe(snapshot.source.sha256);
  });

  it("refuses removed, duplicate or externally mutating operations", () => {
    expect(() => projectCatalog(document(), ["prepare_pay"])).toThrow("Missing or incompatible");
    expect(() => projectCatalog(document(operation(), operation()), ["prepare_pay"])).toThrow("duplicate");
    expect(() => projectCatalog(document({ ...operation(), effects: { externalMutation: true, idempotent: true } }), ["prepare_pay"])).toThrow("incompatible");
    expect(() => projectCatalog(document({ ...operation(), path: "/api/v1/relay" }), ["prepare_pay"])).toThrow("incompatible");
    expect(() => projectCatalog({ operations: [operation()] }, ["prepare_pay"])).toThrow("Expected Center");
  });
});
