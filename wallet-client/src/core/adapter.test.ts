import { describe, expect, test, vi } from "vitest";
import { signaWalletAdapter } from "./adapter";

const account = ("0x" + "33".repeat(20)) as `0x${string}`;
const operationHash = ("0x" + "11".repeat(32)) as `0x${string}`;
const transactionHash = ("0x" + "22".repeat(32)) as `0x${string}`;
const call = { chainId: 8453, to: ("0x" + "44".repeat(20)) as `0x${string}`, data: "0x1234" as `0x${string}`, value: 5n };
const approvalUrl = "https://signa.center/wallet/payment?review=r";
const callbackUrl = "https://app.example/center/callback?review=r";

type Status = { status: string; approvalUrl: string | null; operationHash: `0x${string}`; observation?: unknown };
const status = (value: string, observation?: unknown): Status => ({ status: value, approvalUrl, operationHash, ...(observation ? { observation } : {}) });
const receipt = (hash: `0x${string}`, canonical = true) => ({ state: "confirmed", operationHash, transactionHash: hash,
  receipt: { transactionHash: hash, canonical } });

function setup(input: { approve?: string | null; complete?: Status; submit?: Status; refreshes?: Status[]; pending?: Status | null; cancel?: Status } = {}) {
  const refreshes = [...(input.refreshes ?? [])];
  const reviews = {
    prepareReview: vi.fn(async () => status("reviewing")),
    completeReview: vi.fn(async () => input.complete ?? status("approved")),
    submitReview: vi.fn(async () => input.submit ?? status("confirming", receipt(transactionHash))),
    refreshReview: vi.fn(async () => refreshes.shift() ?? status("pending")),
    cancelReview: vi.fn(async () => input.cancel ?? status("cancelled")),
    pendingReview: vi.fn(() => input.pending ?? null),
    clearReview: vi.fn(),
    prepareSignature: vi.fn(async () => ({ status: "reviewing", approvalUrl })),
    completeSignature: vi.fn(async () => ({ status: "approved", approvalUrl, signature: "0xabcd" as `0x${string}` })),
    cancelSignature: vi.fn(async () => ({ status: "cancelled", approvalUrl })),
  };
  const wallet = { restoreConnection: () => ({ address: account }), reviews: () => reviews };
  const approve = vi.fn(async () => (input.approve === undefined ? callbackUrl : input.approve));
  return { reviews, approve, adapter: signaWalletAdapter(wallet as never, { approve }) };
}

describe("signaWalletAdapter", () => {
  test("hands Signa the raw calls and resolves the canonical transaction hash", async () => {
    const { adapter, reviews, approve } = setup();
    expect(adapter.kind).toBe("self-reviewing");
    expect(adapter.account()).toBe(account);
    await expect(adapter.submitToReviewer!({ account, calls: [call] })).resolves.toBe(transactionHash);
    expect(reviews.prepareReview).toHaveBeenCalledWith({ chainId: 8453, calls: [{ to: call.to, data: call.data, value: call.value }] });
    expect(approve).toHaveBeenCalledWith(approvalUrl);
    expect(reviews.completeReview).toHaveBeenCalledWith(callbackUrl);
  });

  test("submit resolves the UserOperationEvent transaction hash, never the userOpHash", async () => {
    // A pending observation's hash, or a receipt that is not canonical yet, is waited past.
    const { adapter, reviews } = setup({ submit: status("pending", { state: "pending", operationHash, transactionHash: operationHash }),
      refreshes: [status("confirming", receipt(operationHash)), status("confirming", receipt(transactionHash, false)), status("paid", receipt(transactionHash))] });
    await expect(adapter.submitToReviewer!({ account, calls: [call] })).resolves.toBe(transactionHash);
    expect(reviews.refreshReview).toHaveBeenCalledWith({ waitSeconds: 20 });
    expect(reviews.refreshReview).toHaveBeenCalledTimes(3);
    expect(reviews.clearReview).toHaveBeenCalledTimes(1);
  });

  test("refuses a request spanning more than one chain before Signa", async () => {
    const { adapter, reviews, approve } = setup();
    await expect(adapter.submitToReviewer!({ account, calls: [call, { ...call, chainId: 10 }] }))
      .rejects.toMatchObject({ message: "Signa sends one chain at a time.", code: 4200 });
    expect(reviews.prepareReview).not.toHaveBeenCalled();
    expect(reviews.pendingReview).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  test("a closed or cancelled review is a rejection: nothing was sent", async () => {
    const closed = setup({ approve: null });
    await expect(closed.adapter.submitToReviewer!({ account, calls: [call] })).rejects.toMatchObject({ code: 4001 });
    expect(closed.reviews.completeReview).not.toHaveBeenCalled();
    expect(closed.reviews.submitReview).not.toHaveBeenCalled();
    // Withdrawn on Signa and cleared here, so the next call set prepares at once.
    expect(closed.reviews.cancelReview).toHaveBeenCalled();
    expect(closed.reviews.clearReview).toHaveBeenCalled();
    const cancelled = setup({ complete: status("cancelled") });
    await expect(cancelled.adapter.submitToReviewer!({ account, calls: [call] })).rejects.toMatchObject({ code: 4001 });
    expect(cancelled.reviews.clearReview).toHaveBeenCalled();
    expect(cancelled.reviews.submitReview).not.toHaveBeenCalled();
  });

  test("an outcome Signa cannot prove sent or unsent is never a rejection", async () => {
    // Refused is proven unsent: the app releases the calls.
    const refused = setup({ submit: status("refused") });
    await expect(refused.adapter.submitToReviewer!({ account, calls: [call] }))
      .rejects.toMatchObject({ code: 4001, message: "Signa did not send this. Nothing was charged; review it again." });
    // A send Signa refused and retired is the same.
    const retired = setup();
    retired.reviews.submitReview.mockRejectedValueOnce(new Error("refused"));
    retired.reviews.pendingReview.mockReturnValueOnce(null).mockReturnValue(status("refused"));
    await expect(retired.adapter.submitToReviewer!({ account, calls: [call] })).rejects.toMatchObject({ code: 4001 });
    expect(retired.reviews.clearReview).toHaveBeenCalled();
    // Mined, but the account's own execution failed: never done, never unsent.
    const reverted = setup({ submit: status("confirming", { ...receipt(transactionHash), semantic: { status: "failed" } }) });
    const failure = await reverted.adapter.submitToReviewer!({ account, calls: [call] }).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ message: "This ran onchain and failed, so none of it took effect.", transactionHash });
    expect((failure as { code?: unknown }).code).toBeUndefined();
    // A failed send Signa did not retire may have gone out.
    const failed = setup();
    failed.reviews.submitReview.mockRejectedValueOnce(new Error("lost"));
    failed.reviews.pendingReview.mockReturnValue(status("unknown"));
    const lost = await failed.adapter.submitToReviewer!({ account, calls: [call] }).catch((caught: unknown) => caught);
    expect(lost).toMatchObject({ message: "lost" });
    expect((lost as { code?: unknown }).code).toBeUndefined();
    const waiting = setup({ submit: status("pending") });
    const late = await waiting.adapter.submitToReviewer!({ account, calls: [call] }).catch((caught: unknown) => caught);
    expect(late).toMatchObject({ message: "Submitted. Signa is still waiting for it onchain; check its status again shortly." });
    expect((late as { code?: unknown }).code).toBeUndefined();
    expect(waiting.reviews.clearReview).not.toHaveBeenCalled();
  });

  test("clears a settled earlier review first, and refuses another account", async () => {
    const { adapter, reviews } = setup({ pending: status("pending"), refreshes: [status("paid", receipt(transactionHash))] });
    await expect(adapter.submitToReviewer!({ account, calls: [call] })).resolves.toBe(transactionHash);
    expect(reviews.clearReview).toHaveBeenCalledTimes(1);
    await expect(adapter.submitToReviewer!({ account: ("0x" + "55".repeat(20)) as `0x${string}`, calls: [call] }))
      .rejects.toThrow("The connected account changed. Review again.");
  });

  test("signs typed data and messages through Signa's own review", async () => {
    const { adapter, reviews } = setup();
    const typedData = { domain: { name: "Permit2", chainId: 8453n, verifyingContract: call.to }, primaryType: "Mail" as const,
      types: { Mail: [{ name: "amount", type: "uint256" }, { name: "small", type: "uint8" }] }, message: { amount: 2n ** 160n, small: 3n } };
    await expect(adapter.signTypedData(typedData as never)).resolves.toBe("0xabcd");
    expect(reviews.prepareSignature).toHaveBeenCalledWith({ kind: "typed-data", chainId: 8453, typedData: {
      domain: { name: "Permit2", chainId: 8453, verifyingContract: call.to }, primaryType: "Mail", types: typedData.types,
      message: { amount: (2n ** 160n).toString(), small: 3 } } });
    await expect(adapter.signMessage("hello")).resolves.toBe("0xabcd");
    expect(reviews.prepareSignature).toHaveBeenLastCalledWith({ kind: "message", chainId: 8453, message: "hello" });
    // Still open after its callback: unsettled, never a rejection.
    reviews.completeSignature.mockResolvedValueOnce({ status: "reviewing", approvalUrl } as never);
    const open = await adapter.signMessage("open").catch((caught: unknown) => caught);
    expect(open).toMatchObject({ message: "Signa has not settled this signature yet. Check it again shortly." });
    expect((open as { code?: unknown }).code).toBeUndefined();
    reviews.completeSignature.mockResolvedValueOnce({ status: "cancelled", approvalUrl } as never);
    await expect(adapter.signMessage("again")).rejects.toMatchObject({ code: 4001 });
    const closed = setup({ approve: null });
    await expect(closed.adapter.signMessage("hello")).rejects.toMatchObject({ code: 4001, message: "The review was closed. Nothing was signed." });
    expect(closed.reviews.completeSignature).not.toHaveBeenCalled();
  });

  test("only a refusal Signa states before any review is a rejection", async () => {
    const refused = setup();
    refused.reviews.prepareReview.mockRejectedValueOnce(Object.assign(new Error("Call 1: refused"), { code: "REVIEWED_CALLS_REFUSED", status: 422 }));
    await expect(refused.adapter.submitToReviewer!({ account, calls: [call] })).rejects.toMatchObject({ code: 4001, message: "Call 1: refused" });
    // A refused signature says why in one line, naming the chain.
    refused.reviews.prepareSignature.mockRejectedValueOnce(Object.assign(new Error("The service rejected this request (422, REVIEWED_SIGNATURE_REFUSED)"),
      { code: "REVIEWED_SIGNATURE_REFUSED", status: 422, refusal: "account-not-deployed" }));
    await expect(refused.adapter.signTypedData({ domain: { chainId: 10 }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 1n } }))
      .rejects.toMatchObject({ code: 4001, message: "Your Signa account isn't on Optimism yet." });
    const pending = setup();
    pending.reviews.prepareReview.mockRejectedValueOnce(Object.assign(new Error("pending"), { code: "WALLET_PAYMENT_PENDING" }));
    const error = await pending.adapter.submitToReviewer!({ account, calls: [call] }).catch((caught: unknown) => caught);
    expect((error as { code?: unknown }).code).toBe("WALLET_PAYMENT_PENDING");
  });

  test("refuses what Signa does not take from an app", async () => {
    const { adapter } = setup();
    for (const refused of [() => adapter.chainId(), () => adapter.isSafe()]) expect(refused).toThrow(expect.objectContaining({ code: 4200 }));
    await expect(adapter.switchChain(10)).rejects.toMatchObject({ code: 4200 });
    await expect(adapter.sendTransaction({ ...call })).rejects.toMatchObject({ code: 4200 });
  });
});
