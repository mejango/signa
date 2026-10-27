import type { Address, Hex, TypedDataDefinition } from "viem";
import type { createCenterWalletClient } from "../../../src/rest/client/wallet-package.js";
import { isSettledPayment } from "../../../src/rest/client/paymentStates.js";
import { SIGNA_HOME_CHAIN_ID } from "../../../src/rest/wallet/chains.js";

/** The slice of a Signa wallet client the adapter needs (`createCenterWalletClient` satisfies it). */
export type SignaAdapterWallet = {
  restoreConnection(): { address: Address } | null;
  reviews(): ReturnType<ReturnType<typeof createCenterWalletClient>["reviews"]>;
};
/** The raw calls core hands a self-reviewing wallet. */
export type SignaReviewedRequest = {
  account: Address;
  calls: readonly { chainId: number; to: Address; data: Hex; value: bigint; gas?: bigint }[];
};
/** Core's `WalletAdapter` for a self-reviewing wallet, declared here so this package never depends on core. */
export type SignaWalletAdapter = {
  kind: "self-reviewing";
  account(): Address | undefined;
  chainId(): number | undefined;
  isSafe(): boolean;
  switchChain(chainId: number): Promise<void>;
  sendTransaction(tx: { chainId: number; to: Address; data: Hex; value: bigint; gas?: bigint }): Promise<Hex>;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
  submitToReviewer(request: SignaReviewedRequest): Promise<Hex>;
};

/** How many held reads (up to 20 s each) a sent call set is followed for before its hash is left to the app's status check. */
const WAITS = 6;
const failure = (message: string, code?: number) =>
  Object.assign(new Error(message), code === undefined ? {} : { code });
/** EIP-1193 4001, the only error that means nothing was sent or signed: closed, cancelled, refused or expired. */
const rejected = (message: string) => failure(message, 4001);
/** EIP-1193 4200: a request Signa does not take from an app. */
const unsupported = (message = "This wallet request is not supported.") => failure(message, 4200);
/** Refusals Signa states about the request itself, before any review of it exists: nothing can be sent or signed. */
const refusedBeforeReview = ["REVIEWED_CALLS_REFUSED", "REVIEWED_CALLS_INPUT", "REVIEWED_SIGNATURE_REFUSED", "REVIEWED_SIGNATURE_INPUT"];
const preparing = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: string };
    if (typeof code === "string" && refusedBeforeReview.includes(code)) throw Object.assign(rejected(message ?? "Signa refused this."), { cause: error });
    throw error;
  }
};
const refuse = (): never => {
  throw unsupported();
};
/** Typed data as JSON: integers that fit a number stay numbers, larger ones go as decimal strings. */
const json = (value: unknown): unknown =>
  typeof value === "bigint"
    ? Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    : Array.isArray(value)
      ? value.map(json)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]))
        : value;

/**
 * Signa as core's self-reviewing wallet: `sendReviewed` hands it the raw calls, and Signa's own page,
 * shown by `approve`, is the one confirmation. `approve` opens that page (a frame or popup the app
 * shows) and resolves the callback URL Signa sends back, or null when the person closed it. A review
 * closed, cancelled, refused or expired throws EIP-1193 4001: nothing was sent. A call set resolves the
 * canonical transaction hash of its UserOperationEvent, never the userOpHash, so the app waits on a real
 * receipt; one whose execution failed throws a plain error carrying that `transactionHash`. Signatures go
 * through the same page and resolve the account's ERC-1271 signature.
 */
export function signaWalletAdapter(
  wallet: SignaAdapterWallet,
  options: { approve(approvalUrl: string): Promise<string | null> },
): SignaWalletAdapter {
  const sign = async (request: Parameters<ReturnType<SignaAdapterWallet["reviews"]>["prepareSignature"]>[0]) => {
    const reviews = wallet.reviews();
    let status = await preparing(reviews.prepareSignature(request));
    let callback: string | null = "";
    if (status.status === "reviewing") {
      // A review in progress always names its page. A page closed without its callback is withdrawn on
      // Signa, so no late approval can sign it; an approval that won the race is the signature.
      callback = await options.approve(status.approvalUrl!);
      status = callback === null ? await reviews.cancelSignature() : await reviews.completeSignature(callback);
    }
    if (status.status === "approved" && status.signature) return status.signature;
    if (status.status === "cancelled")
      throw rejected(callback === null ? "The review was closed. Nothing was signed." : "The signature was cancelled. Nothing was signed.");
    throw failure("Signa has not settled this signature yet. Check it again shortly.");
  };
  return {
    kind: "self-reviewing",
    account: () => wallet.restoreConnection()?.address,
    chainId: refuse,
    isSafe: refuse,
    switchChain: () => Promise.reject(unsupported()),
    sendTransaction: () => Promise.reject(unsupported()),
    signTypedData: (typedData) =>
      sign({ kind: "typed-data", chainId: Number(typedData.domain?.chainId ?? SIGNA_HOME_CHAIN_ID), typedData: json(typedData) as never }),
    signMessage: (message) => sign({ kind: "message", chainId: SIGNA_HOME_CHAIN_ID, message }),
    async submitToReviewer({ account, calls }) {
      const chainId = calls[0]?.chainId;
      if (chainId === undefined || calls.some((call) => call.chainId !== chainId))
        throw unsupported("Signa sends one chain at a time.");
      if (wallet.restoreConnection()?.address.toLowerCase() !== account.toLowerCase())
        throw failure("The connected account changed. Review again.");
      const reviews = wallet.reviews();
      // An earlier call set that has settled makes way; one still open resumes when it is these calls.
      const earlier = reviews.pendingReview();
      if (earlier && isSettledPayment((isSettledPayment(earlier.status) ? earlier : await reviews.refreshReview()).status))
        reviews.clearReview();
      let status = await preparing(reviews.prepareReview({ chainId, calls: calls.map(({ to, data, value }) => ({ to, data, value })) }));
      let callback: string | null = "";
      if (status.status === "reviewing") {
        callback = await options.approve(status.approvalUrl!);
        // A page closed without a decision is withdrawn on Signa so the next call set needn't wait for it,
        // unless an approval raced the close: that one is read back and sent.
        status = callback === null ? await reviews.cancelReview() : await reviews.completeReview(callback);
      }
      if (status.status === "cancelled") {
        reviews.clearReview();
        throw rejected(callback === null ? "The review was closed. Nothing was sent." : "The review was cancelled. Nothing was sent.");
      }
      if (status.status === "approved") {
        try {
          status = await reviews.submitReview();
        } catch (error) {
          // A send Signa refused and retired is proven unsent; any other failure may have sent it.
          if (reviews.pendingReview()?.status !== "refused") throw error;
          status = reviews.pendingReview()!;
        }
      }
      for (let wait = 0; ; wait++) {
        const receipt = status.observation?.receipt;
        if (receipt?.canonical === true && /^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) &&
          receipt.transactionHash.toLowerCase() !== status.operationHash.toLowerCase()) {
          if (isSettledPayment(status.status)) reviews.clearReview();
          // The bundle's receipt succeeds even when the account's own execution failed: EntryPoint says which.
          if (status.status === "reverted" || receipt.status === "reverted" || status.observation?.semantic?.status === "failed")
            throw Object.assign(failure("This ran onchain and failed, so none of it took effect."), { transactionHash: receipt.transactionHash });
          return receipt.transactionHash;
        }
        // Proven never sent and never sendable: the app releases the calls.
        if (status.status === "refused" || status.status === "expired") {
          reviews.clearReview();
          throw rejected(status.status === "refused" ? "Signa did not send this. Nothing was charged; review it again."
            : "This expired before it was included onchain. Nothing was charged; review it again.");
        }
        if (wait === WAITS) throw failure("Submitted. Signa is still waiting for it onchain; check its status again shortly.");
        status = await reviews.refreshReview({ waitSeconds: 20 });
      }
    },
  };
}
