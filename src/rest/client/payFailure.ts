import { decodePayFailure, type PayFailureReason } from "@bananapus/nana-sdk-core/v6";
import { encodeAbiParameters, keccak256, toFunctionSelector, type Hex } from "viem";
import type { PayFailure } from "../userOperations/types.js";

const amount = (value: unknown) => value === undefined
  || (typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n);
/** The reverts behind every reason the SDK's decoder gives. A new SDK reason
 * fails the type check here until it is listed. */
const shortfallReverts: readonly string[] = ["JBMultiTerminal_UnderMin(uint256,uint256)", "JBBuybackHook_SpecifiedSlippageExceeded(uint256,uint256)",
  "JBBuybackHook_DerivedFloorNotMet(uint256,uint256)", "JBRouterTerminal_SlippageExceeded(uint256,uint256)"];
const payFailureReverts = {
  TERMINAL_UNDER_MIN: ["JBMultiTerminal_UnderMin(uint256,uint256)"],
  BUYBACK_SLIPPAGE_EXCEEDED: ["JBBuybackHook_SpecifiedSlippageExceeded(uint256,uint256)"],
  BUYBACK_DERIVED_FLOOR_NOT_MET: ["JBBuybackHook_DerivedFloorNotMet(uint256,uint256)"],
  ROUTER_SLIPPAGE_EXCEEDED: ["JBRouterTerminal_SlippageExceeded(uint256,uint256)"],
  BUYBACK_SWAP_AMOUNT_TOO_HIGH: ["JBBuybackHook_InsufficientPayAmount(uint256,uint256)"],
  ROUTER_NO_ROUTE: ["JBRouterTerminal_NoRouteFound(uint256,address)", "JBRouterTerminal_NoPoolFound(address,address)"],
  TOKEN_NOT_ACCEPTED: ["JBMultiTerminal_TokenNotAccepted(address)"],
  PAYMENTS_PAUSED: ["JBTerminalStore_RulesetPaymentPaused(uint256,uint256)"], NO_RULESET: ["JBTerminalStore_RulesetNotFound(uint256)"],
  ALLOWANCE_TOO_LOW: ["JBMultiTerminal_PermitAllowanceNotEnough(uint256,uint256)", "ERC20InsufficientAllowance(address,uint256,uint256)",
    "InsufficientAllowance(uint256)"],
  ALLOWANCE_EXPIRED: ["AllowanceExpired(uint256)"], BALANCE_TOO_LOW: ["ERC20InsufficientBalance(address,uint256,uint256)"],
  UNEXPECTED_ETH: ["JBMultiTerminal_NoMsgValueAllowed(uint256)"],
  NFT_SOLD_OUT: ["JB721TiersHookStore_InsufficientSupplyRemaining(uint256)"],
  NFT_UNAVAILABLE: ["JB721TiersHookStore_TierRemoved(uint256)", "JB721TiersHookStore_UnrecognizedTier(uint256)"],
  NFT_PRICE_ABOVE_PAYMENT: ["JB721TiersHookStore_PriceExceedsAmount(uint256,uint256)"], NFT_OVERSPENDING: ["JB721TiersHook_Overspending(uint256)"],
} as const satisfies Record<PayFailureReason, readonly string[]>;
// The router gateway's RouteFailed wraps a failed route's selector hash, so its shortfall has no amounts.
const ROUTE_FAILED = "0xa4ceb15e";
/** The SDK's own reading of each revert behind a reason, rebuilt from the served amounts. */
function sdkPayFailures(reason: PayFailureReason, received?: bigint, minimum?: bigint) {
  return payFailureReverts[reason].map((signature: string) => {
    const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").map(type => ({ type }));
    const selector = toFunctionSelector(signature);
    const data = shortfallReverts.includes(signature)
      ? received === undefined || minimum === undefined ? `${ROUTE_FAILED}${keccak256(selector).slice(2)}`
        : `${selector}${encodeAbiParameters(types, [received, minimum]).slice(2)}`
      : `${selector}${encodeAbiParameters(types, types.map(({ type }) => type === "address" ? `0x${"11".repeat(20)}` : 1n)).slice(2)}`;
    try { return decodePayFailure(data as Hex); } catch { return null; }
  });
}
/** A served payment failure reason, kept only when the SDK's decoder gives exactly it: a known reason,
 * that reason's own sentence for these amounts, and the shortfall's amounts as uint256 integers. */
export function payFailureOf(value: unknown): PayFailure | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { reason, received, minimum, message, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || typeof reason !== "string" || !Object.hasOwn(payFailureReverts, reason)
    || typeof message !== "string" || !amount(received) || !amount(minimum)) return undefined;
  const settled = received === undefined ? undefined : BigInt(received as string);
  const floor = minimum === undefined ? undefined : BigInt(minimum as string);
  const canonical = sdkPayFailures(reason as PayFailureReason, settled, floor).some(failure => failure
    && failure.reason === reason && failure.message === message && failure.received === settled && failure.minimum === floor);
  if (!canonical) return undefined;
  return { reason, message, ...(received === undefined ? {} : { received: received as string }),
    ...(minimum === undefined ? {} : { minimum: minimum as string }) };
}
