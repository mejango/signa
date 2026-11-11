import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/rest/wallet/json.js";

describe("wallet signed JSON", () => {
  it("preserves the existing canonical bytes for nested objects and arrays", () => {
    expect(canonicalJson({ z: [2, 1], a: { y: true, x: null } })).toBe(
      '{"a":{"x":null,"y":true},"z":[2,1]}',
    );
    expect(canonicalJson({ a: 'quoted " value', b: false })).toBe(
      JSON.stringify({ a: 'quoted " value', b: false }),
    );
  });
});
