import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  keccak256,
  stringToHex,
  toHex,
  type Hex,
} from "viem";
import type { RestBlockEvidence } from "../core.js";
import { assertSafe7579Execution } from "../smartAccounts/accountExecution.js";
import type { SemanticResult, StoredReceipt } from "../transactions/types.js";
import { ENTRY_POINT_V07_ABI, type UserOperationChain } from "./chain.js";
import {
  getUserOperationHash,
  normalizeUserOperation,
  unpackUserOperation,
  uoBytes,
  uoCanonical,
  uoHash,
  uoObject,
  uoQuantity,
  userOperationCommitment,
  userOperationMaximumCost,
} from "./codec.js";
import type {
  PackedUserOperationV07,
  PayFailure,
  UserOperationExecutionBinding,
  UserOperationObservation,
} from "./types.js";

const beforeTopic = keccak256(stringToHex("BeforeExecution()"));
const operationTopic = keccak256(
  stringToHex(
    "UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
  ),
);
const same = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
export interface ObserveUserOperationOptions {
  chain: UserOperationChain;
  binding: UserOperationExecutionBinding;
  signedCommitment: Hex;
  transactionHash?: Hex;
  confirmations: number;
  now: number;
  /** The signed validity end (seconds). Past it, with a reorg margin, an unincluded operation is final. */
  validUntil?: number;
  /** Check full Safe singleton/module/fallback/validator configuration at THIS canonical block.
   * Resolving `"pending"` means the check is under way elsewhere: the execution is reported as
   * confirming with its evidence, and confirmed only once a later observation finds it verified. */
  verifyAccountAtBlock(
    binding: UserOperationExecutionBinding,
    evidence: RestBlockEvidence,
    chain: UserOperationChain,
  ): Promise<void | "pending">;
  /** Receives only logs within this operation's EntryPoint execution interval. */
  verifySemantics?(receipt: StoredReceipt): Promise<SemanticResult>;
  /** Why the operation's payment reverted, for an execution the EntryPoint reports failed. */
  payFailure?(transactionHash: Hex, blockHash: Hex): Promise<PayFailure | undefined>;
}
/** A bundler receipt supplies only a hint. Every proof below comes from the configured chain. */
export async function observeUserOperation(
  options: ObserveUserOperationOptions,
): Promise<UserOperationObservation> {
  const { chain, binding } = options;
  const operation = normalizeUserOperation(binding.operation);
  const operationHash = getUserOperationHash(
    operation,
    binding.entryPoint.address,
    binding.chainId,
  );
  const base = { operationHash };
  const unknown = (reason: string): UserOperationObservation => ({
    ...base,
    state: "unknown",
    ...(options.transactionHash
      ? { transactionHash: options.transactionHash }
      : {}),
    reason,
  });
  if (
    !same(operationHash, binding.operationHash) ||
    !same(
      userOperationCommitment(
        operation,
        binding.entryPoint.address,
        binding.chainId,
      ),
      options.signedCommitment,
    )
  )
    return unknown(
      "The signed operation does not match its immutable commitment.",
    );
  if (
    !Number.isSafeInteger(options.confirmations) ||
    options.confirmations < 1 ||
    options.confirmations > 1024
  )
    return unknown("The configured confirmation depth is invalid.");
  assertSafe7579Execution(
    operation.callData,
    binding.calls.map((call) => ({
      target: call.to,
      value: call.value,
      callData: call.data,
    })),
  );
  if (
    binding.calls.some((call) => call.chainId !== binding.chainId) ||
    !same(operation.sender, binding.accountCode.address)
  )
    return unknown(
      "The operation does not bind the reviewed account and calls.",
    );
  // The EntryPoint refuses validation once block.timestamp passes validUntil; two minutes of
  // canonical blocks beyond it rule out a late inclusion by reorg. The verdict rests on the
  // chain alone: the sender's nonce at that same head must still be this operation's, or
  // something executed and only execution evidence can say what.
  const unincluded = async (reason: string, known?: RestBlockEvidence): Promise<UserOperationObservation> => {
    if (options.validUntil === undefined) return { ...base, state: "pending", reason };
    const head = known ?? (await chain.snapshot(binding.chainId));
    if (BigInt(head.timestamp) <= BigInt(options.validUntil) + 120n) return { ...base, state: "pending", reason };
    const nonce = BigInt(operation.nonce);
    const current = await chain.readNonce(binding.chainId, operation.sender, nonce >> 64n, binding.entryPoint.address, head);
    return current === nonce
      ? { ...base, state: "expired", reason: "The operation's validity ended before any inclusion; it can no longer execute." }
      : { ...base, state: "unknown", reason: "The sender nonce advanced past the validity window; execution evidence is required." };
  };
  if (!options.transactionHash)
    return unincluded("No independently verifiable outer transaction hash is available.");
  const transactionHash = uoHash(
    options.transactionHash,
    "outer transaction hash",
  );
  const [tx, raw, head] = await Promise.all([
    chain.request(binding.chainId, "eth_getTransactionByHash", [
      transactionHash,
    ]),
    chain.request(binding.chainId, "eth_getTransactionReceipt", [
      transactionHash,
    ]),
    chain.snapshot(binding.chainId),
  ]);
  if (tx === null || raw === null) {
    const result = await unincluded("The bundle is not mined on the configured chain.", head);
    return result.state === "expired" ? result : { ...result, transactionHash };
  }
  if (
    !uoObject(tx) ||
    !uoObject(raw) ||
    uoHash(tx.hash, "transaction hash") !== transactionHash ||
    uoHash(raw.transactionHash, "receipt hash") !== transactionHash ||
    typeof tx.to !== "string" ||
    !same(tx.to, binding.entryPoint.address) ||
    typeof raw.to !== "string" ||
    !same(raw.to, binding.entryPoint.address) ||
    typeof tx.from !== "string" ||
    !isAddress(tx.from) ||
    typeof raw.from !== "string" ||
    !isAddress(raw.from) ||
    !same(tx.from, raw.from) ||
    uoQuantity(tx.value, "outer value") !== 0n ||
    (tx.chainId !== undefined &&
      uoQuantity(tx.chainId, "outer chain") !== BigInt(binding.chainId))
  )
    return unknown(
      "The outer transaction and receipt do not match the reviewed EntryPoint.",
    );
  // A node a block behind the one that served the receipt still shows the transaction pending:
  // not yet settled from here, never an invalid operation.
  if (tx.blockHash == null || tx.blockNumber == null || tx.transactionIndex == null)
    return { ...base, state: "pending", transactionHash, reason: "The transaction is not yet in a block from this node's view." };
  const blockNumber = uoQuantity(raw.blockNumber, "receipt block");
  const blockHash = uoHash(raw.blockHash, "receipt block hash");
  const transactionIndex = uoQuantity(
    raw.transactionIndex,
    "receipt transaction index",
  );
  if (
    uoHash(tx.blockHash, "transaction block hash") !== blockHash ||
    uoQuantity(tx.blockNumber, "transaction block") !== blockNumber ||
    uoQuantity(tx.transactionIndex, "transaction index") !== transactionIndex
  )
    return unknown(
      "The transaction and receipt have inconsistent block positions.",
    );
  const input = uoBytes(tx.input, "bundle calldata", 1_048_576);
  let packedOperations: readonly PackedUserOperationV07[];
  try {
    const decoded = decodeFunctionData({
      abi: ENTRY_POINT_V07_ABI,
      data: input,
    });
    if (
      decoded.functionName !== "handleOps" ||
      decoded.args[0].length < 1 ||
      decoded.args[0].length > 128 ||
      encodeFunctionData({
        abi: ENTRY_POINT_V07_ABI,
        functionName: "handleOps",
        args: decoded.args,
      }).toLowerCase() !== input
    )
      return unknown(
        "The bundle is not one canonical, bounded v0.7 handleOps call.",
      );
    packedOperations = decoded.args[0];
  } catch {
    return unknown(
      "The outer transaction does not encode the reviewed EntryPoint v0.7 operation.",
    );
  }
  const unpacked = packedOperations.map(unpackUserOperation);
  const hashes = unpacked.map((value) =>
    getUserOperationHash(value, binding.entryPoint.address, binding.chainId),
  );
  const matching = hashes.flatMap((hash, index) =>
    hash === operationHash ? [index] : [],
  );
  if (
    matching.length !== 1 ||
    userOperationCommitment(
      unpacked[matching[0]!]!,
      binding.entryPoint.address,
      binding.chainId,
    ) !== options.signedCommitment.toLowerCase()
  )
    return unknown(
      "The bundle does not contain exactly the stored full signed operation.",
    );
  const block = await chain.request(binding.chainId, "eth_getBlockByNumber", [
    toHex(blockNumber),
    false,
  ]);
  if (
    !uoObject(block) ||
    uoHash(block.hash, "canonical block") !== blockHash ||
    uoQuantity(block.number, "canonical height") !== blockNumber
  )
    return unknown("The receipt is not in the canonical chain.");
  const evidence: RestBlockEvidence = {
    chainId: binding.chainId,
    blockNumber: blockNumber.toString(),
    blockHash,
    timestamp: uoQuantity(block.timestamp, "block timestamp").toString(),
    source: "onchain",
  };
  await Promise.all([
    chain.runtime(binding.chainId, binding.entryPoint, evidence),
    chain.runtime(binding.chainId, binding.accountCode, evidence),
  ]);
  if (
    !Array.isArray(raw.logs) ||
    raw.logs.length > 2048 ||
    Buffer.byteLength(uoCanonical(raw.logs)) > 524_288
  )
    return unknown("Receipt logs exceed their verification bounds.");
  let previous = -1n;
  for (const log of raw.logs) {
    if (
      !uoObject(log) ||
      typeof log.address !== "string" ||
      !isAddress(log.address) ||
      !Array.isArray(log.topics) ||
      log.topics.length > 4 ||
      !log.topics.every(
        (topic) =>
          typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic),
      ) ||
      typeof log.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data) ||
      log.data.length > 262_146 ||
      log.removed === true ||
      uoHash(log.transactionHash, "log transaction") !== transactionHash ||
      uoHash(log.blockHash, "log block hash") !== blockHash ||
      uoQuantity(log.blockNumber, "log block") !== blockNumber ||
      uoQuantity(log.transactionIndex, "log transaction index") !==
        transactionIndex
    )
      return unknown(
        "The receipt logs have inconsistent canonical identities.",
      );
    const index = uoQuantity(log.logIndex, "log index");
    if (index <= previous)
      return unknown("Receipt log positions are duplicated or unordered.");
    previous = index;
  }
  const depth =
    BigInt(head.blockNumber) >= blockNumber
      ? BigInt(head.blockNumber) - blockNumber + 1n
      : 0n;
  const confirmations = Number(depth > 1024n ? 1024n : depth);
  const status = uoQuantity(raw.status, "receipt status");
  if (status !== 0n && status !== 1n)
    return unknown("The outer receipt has an invalid status.");
  const receipt: StoredReceipt = {
    transactionHash,
    blockHash,
    blockNumber: blockNumber.toString(),
    status: status === 1n ? "success" : "reverted",
    confirmations,
    canonical: true,
    observedAt: options.now,
    logs: [],
  };
  await chain.canonical(evidence);
  if (status === 0n)
    return {
      ...base,
      transactionHash,
      receipt,
      state: confirmations >= options.confirmations ? "reverted" : "confirming",
      semantic: {
        status: "failed",
        details: "The entire EntryPoint bundle reverted.",
      },
    };
  const events: {
    position: number;
    hash: Hex;
    sender: Hex;
    paymaster: Hex;
    nonce: bigint;
    success: boolean;
    actualGasCost: bigint;
  }[] = [];
  const boundaries: number[] = [];
  for (let position = 0; position < raw.logs.length; position++) {
    const log = raw.logs[position]!;
    if (!same(log.address, binding.entryPoint.address)) continue;
    if (log.topics[0]?.toLowerCase() === beforeTopic) {
      if (log.topics.length !== 1 || log.data !== "0x")
        return unknown("The EntryPoint execution boundary is malformed.");
      boundaries.push(position);
      continue;
    }
    if (log.topics[0]?.toLowerCase() !== operationTopic) continue;
    if (log.topics.length !== 4 || log.data.length !== 258)
      return unknown("An EntryPoint operation event has noncanonical fields.");
    try {
      const event = decodeEventLog({
        abi: ENTRY_POINT_V07_ABI,
        eventName: "UserOperationEvent",
        topics: log.topics,
        data: log.data,
        strict: true,
      });
      events.push({
        position,
        hash: event.args.userOpHash,
        sender: event.args.sender,
        paymaster: event.args.paymaster,
        nonce: event.args.nonce,
        success: event.args.success,
        actualGasCost: event.args.actualGasCost,
      });
    } catch {
      return unknown("An EntryPoint operation event is malformed.");
    }
  }
  if (
    boundaries.length !== 1 ||
    events.length !== hashes.length ||
    events.some(
      (event, index) =>
        event.hash.toLowerCase() !== hashes[index] ||
        event.position <= boundaries[0]! ||
        event.nonce !== BigInt(unpacked[index]!.nonce) ||
        !same(event.sender, unpacked[index]!.sender) ||
        !same(
          event.paymaster,
          unpacked[index]!.paymaster ??
            "0x0000000000000000000000000000000000000000",
        ),
    )
  )
    return unknown(
      "The EntryPoint execution events do not match the exact ordered operation bundle.",
    );
  const position = matching[0]!;
  const event = events[position]!;
  if (event.actualGasCost > userOperationMaximumCost(operation))
    return unknown(
      "The reported operation gas charge exceeds its maximum prefund.",
    );
  if (!event.success) {
    const reverted = confirmations >= options.confirmations;
    // Only a settled revert is explained, and only if its block is still canonical after the trace.
    const payFailure = reverted ? await options.payFailure?.(transactionHash, blockHash) : undefined;
    if (payFailure) await chain.canonical(evidence);
    return {
      ...base,
      transactionHash,
      receipt,
      state: reverted ? "reverted" : "confirming",
      semantic: {
        status: "failed",
        details:
          "EntryPoint independently reports that this account execution failed.",
      },
      ...(payFailure ? { payFailure } : {}),
    };
  }
  const verified = (await options.verifyAccountAtBlock(binding, evidence, chain)) !== "pending";
  const start =
    position === 0 ? boundaries[0]! : events[position - 1]!.position;
  const scopedLogs = raw.logs.slice(start + 1, event.position);
  const scopedReceipt = { ...receipt, logs: scopedLogs };
  const semantic = options.verifySemantics
    ? await options.verifySemantics(scopedReceipt)
    : {
        status: "unknown" as const,
        details: "No operation-specific semantic verifier is installed.",
      };
  await chain.canonical(evidence);
  chain.check();
  return {
    ...base,
    transactionHash,
    state: verified && confirmations >= options.confirmations ? "confirmed" : "confirming",
    receipt: scopedReceipt,
    scopedLogs,
    semantic,
    ...(verified ? { verifiedAtBlock: evidence.blockHash } : { reason: "The account is being verified at the execution block." }),
  };
}
