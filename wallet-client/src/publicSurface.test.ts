import { describe, expect, test } from "vitest";
import * as core from "./core/index";
import * as wagmi from "./wagmi/index";
import * as react from "./react/index";

describe("published connect SDK surface", () => {
  test("exports the controller, the passkey option, the callback helper, the connector and the modal", () => {
    expect(Object.keys(core).sort()).toEqual([
      "RestClientError",
      "assertReviewedOperation",
      "completeCenterCallback",
      "createCenterWalletClient",
      "createConnectController",
      "deliverCenterCallback",
      "isFollowedPayment",
      "isSettledPayment",
      "ownerOperationSignature",
      "ownerOperationSigning",
      "passkeyOption",
      "sponsoredCallsCommitment",
      "userOperationMaximumCost",
    ]);
    expect(Object.keys(wagmi)).toEqual(["centerAccountConnector"]);
    expect(Object.keys(react).sort()).toEqual([
      "JBConnectModal",
      "connectModalCss",
      "passkeyLabel",
    ]);
    for (const value of [
      ...Object.values(core),
      ...Object.values(wagmi),
      react.JBConnectModal,
    ])
      expect(value).toBeTypeOf("function");
  });
});

describe("published payment rules", () => {
  test("a payment is settled or followed by its status, and never both", () => {
    const settled = ["paid", "cancelled", "reverted", "expired", "refused"];
    const followed = ["pending", "confirming", "submitting"];
    for (const status of [...settled, ...followed, "reviewing", "approved", "unknown", "nonsense"]) {
      expect(core.isSettledPayment(status)).toBe(settled.includes(status));
      expect(core.isFollowedPayment(status)).toBe(followed.includes(status));
    }
  });
});
