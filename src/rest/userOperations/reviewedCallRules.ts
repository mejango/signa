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
export const ETHERSCAN_SOURCE_LINE = "ABI from Etherscan, not reviewed by Juicebox";
export const LOOKUP_FAILED_LINE = "Couldn't look up this contract.";
export const RAW_CALL_WARNING = "Raw calldata: no verified ABI describes this call. Check the destination and bytes before approving.";

// ERC-7579 executions name their call type in the mode's first byte; 0xff is delegatecall.
const modeExecutions = new Set(["function execute(bytes32 mode,bytes executionCalldata)",
  "function executeFromExecutor(bytes32 mode,bytes executionCalldata)"].map(signature => toFunctionSelector(signature)));
// Safe executions carry the operation as their fourth word; anything but 0 (CALL) is refused.
const safeExecutions = new Set(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)",
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
