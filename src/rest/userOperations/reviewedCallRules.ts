import { decodeFunctionData, encodeFunctionData, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from "viem";

/** The rules of a reviewed call set that the approval page applies too: viem only, no SDK. */

/** One call an app asks a Signa account to make. */
export interface SignaCall { to: Address; value: bigint; data: Hex }
/** Where a call's description comes from. The Etherscan ABI used is stored with the review, so the
 * page decodes with the same one. */
export type CallSource =
  | { source: "first-party" }
  | { source: "etherscan"; abi: Abi; implementation?: Address }
  | { source: "raw"; lookup: "no-abi" | "lookup-failed" };
export type ReviewedCallsRefusal = "account-self-administration" | "delegatecall" | "app-expectation-mismatch";

export const REVIEWED_CALLS_KIND = "reviewed-calls-v1";
/** The plan operation an app's call set is stored under. */
export const REVIEWED_CALLS_OPERATION = "reviewed-calls";
export const ETHERSCAN_SOURCE_LINE = "ABI from Etherscan, not reviewed by Juicebox";
export const LOOKUP_FAILED_LINE = "Couldn't look up this contract.";
export const RAW_CALL_WARNING = "Raw calldata: no verified ABI describes this call. Check the destination and bytes before approving.";

// ERC-7579 executions name their call type in the mode's first byte; 0xff is delegatecall. The selector tables are
// pure, so a bundle that never reviews a call leaves them out.
const modeExecutions = /* @__PURE__ */ new Set(/* @__PURE__ */ ["function execute(bytes32 mode,bytes executionCalldata)",
  "function executeFromExecutor(bytes32 mode,bytes executionCalldata)"].map(signature => toFunctionSelector(signature)));
// Safe executions carry the operation as their fourth word; anything but 0 (CALL) is refused.
const safeExecutions = /* @__PURE__ */ new Set(/* @__PURE__ */ ["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)",
  "function execTransactionFromModule(address to,uint256 value,bytes data,uint8 operation)",
  "function execTransactionFromModuleReturnData(address to,uint256 value,bytes data,uint8 operation)"].map(signature => toFunctionSelector(signature)));

/** Read from the raw call, before any decode or lookup. A call to the account itself, whatever its
 * selector, would change its owners, modules, guard or fallback outside Signa's own ceremonies. */
export function reviewedCallRefusal(account: string, call: { to: string; data: string }): Exclude<ReviewedCallsRefusal, "app-expectation-mismatch"> | null {
  if (call.to.toLowerCase() === account.toLowerCase()) return "account-self-administration";
  const data = call.data.toLowerCase(), selector = data.slice(0, 10);
  if (modeExecutions.has(selector as Hex) && data.slice(10, 12) === "ff") return "delegatecall";
  if (safeExecutions.has(selector as Hex) && (data.length < 10 + 4 * 64 || BigInt(`0x${data.slice(10 + 3 * 64, 10 + 4 * 64)}`) !== 0n)) return "delegatecall";
  return null;
}

/** The function of `abi` that `data` selects, when `data` is exactly the canonical encoding of its
 * decoded arguments. A tampered ABI can at most rename parameters. */
export function exactFunction(abi: unknown, data: Hex): { item: AbiFunction; args: readonly unknown[] } | null {
  if (!Array.isArray(abi) || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase();
  try {
    const item = (abi as Abi).find((entry): entry is AbiFunction => entry?.type === "function" && toFunctionSelector(entry) === selector);
    if (!item) return null;
    const { args = [] } = decodeFunctionData({ abi: [item], data });
    return encodeFunctionData({ abi: [item], functionName: item.name, args }).toLowerCase() === data.toLowerCase() ? { item, args } : null;
  } catch { return null; }
}

const NATIVE_TOKEN = "0x000000000000000000000000000000000000eeee";
// The SDK review's token-amount rule (its TOKEN_CALLS and terminal pay/addToBalanceOf), keyed by exact signature, which
// the selector binds; argument names are not. A parity test holds this to the SDK's.
const TOKEN_AMOUNTS: Record<string, { token?: number; amount: number }> = {
  "approve(address,uint256)": { amount: 1 }, "increaseAllowance(address,uint256)": { amount: 1 }, "transfer(address,uint256)": { amount: 1 },
  "transferFrom(address,address,uint256)": { amount: 2 }, "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)": { amount: 2 },
  "approve(address,address,uint160,uint48)": { token: 0, amount: 2 },
  "pay(uint256,address,uint256,address,uint256,string,bytes)": { token: 1, amount: 2 },
  "addToBalanceOf(uint256,address,uint256,bool,string,bytes)": { token: 1, amount: 2 },
};
/** The token a decoded call's amount counts (lowercase, or "native") and that amount's argument position; null when it moves none. */
export function tokenAmountOf(item: AbiFunction, args: readonly unknown[], target: string): { token: string; position: number } | null {
  const shape = TOKEN_AMOUNTS[`${item.name}(${item.inputs.map(input => input.type).join(",")})`];
  if (!shape) return null;
  const token = String(shape.token === undefined ? target : args[shape.token]).toLowerCase();
  return { token: token === NATIVE_TOKEN ? "native" : token, position: shape.amount };
}

// The SDK review's approval shapes and owner actions (its TOKEN_CALLS spender entries and OWNER_ACTIONS), held to it by a parity test.
const SPENDS: Record<string, { spender: number; amount: number }> = {
  "approve(address,uint256)": { spender: 0, amount: 1 }, "increaseAllowance(address,uint256)": { spender: 0, amount: 1 },
  "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)": { spender: 1, amount: 2 }, "approve(address,address,uint160,uint48)": { spender: 1, amount: 2 },
};
const OWNER_ACTIONS = new Set(["transferOwnership", "renounceOwnership", "addOwnerWithThreshold", "removeOwner", "swapOwner", "changeThreshold",
  "enableModule", "setGuard", "setFallbackHandler", "transferOwnershipToProject", "setControllerOf", "setTerminalsOf"]);
const granted = (address: unknown) => typeof address === "string" && !/^0x0{40}$/i.test(address);
/** A decoded call's security warnings, as the SDK's review derives them from its bytes. `required` the SDK always
 * gives; `possible` the page shows itself where the served model has none: a grant to an address the SDK may know by
 * name, which this page cannot, and an unlimited amount the ABI calls a token ID, since a served parameter name is unchecked. */
export function callWarnings(item: AbiFunction, args: readonly unknown[]): { required: string[]; possible: string[] } {
  const shape = SPENDS[`${item.name}(${item.inputs.map(input => input.type).join(",")})`], required: string[] = [], possible: string[] = [];
  const tokenId = shape && item.inputs[shape.amount]!.name === "tokenId";
  if (shape && args[shape.amount] === (1n << BigInt(item.inputs[shape.amount]!.type.slice(4) || 256)) - 1n) (tokenId ? possible : required).push("unlimited-approval");
  if (OWNER_ACTIONS.has(item.name)) required.push("owner-action");
  if (item.name === "setPermissionsFor") required.push("permission-grant");
  else if (item.name === "setApprovalForAll" ? args[1] === true && granted(args[0]) : shape && granted(args[shape.spender]) && (tokenId || args[shape.amount] !== 0n))
    possible.push("permission-grant");
  return { required, possible };
}
