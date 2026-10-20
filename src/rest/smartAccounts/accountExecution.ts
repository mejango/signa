import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashMessage,
  hashTypedData,
  recoverAddress,
  size,
  sliceHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { RestError } from "../core.js";
import { address, exactObject, integer } from "../protocol/abi.js";
import {
  getUserOperationHash,
  normalizeUserOperation,
  packUserOperation,
} from "../userOperations/codec.js";
import type { UserOperationV07 } from "../userOperations/types.js";

/** f22a194 Safe7579.sol and src/lib/ExecutionLib.sol, not an SDK execution mode. */
export const SAFE7579_EXECUTION_ABI = [{"name":"execute","type":"function","stateMutability":"nonpayable","inputs":[{"type":"bytes32","name":"mode"},{"type":"bytes","name":"executionCalldata"}],"outputs":[]}] as const;
const executionsParameter = [{"type":"tuple[]","components":[{"type":"address","name":"target"},{"type":"uint256","name":"value"},{"type":"bytes","name":"callData"}]}] as const;
export const SAFE7579_SINGLE_MODE = `0x${"00".repeat(32)}` as Hex;
export const SAFE7579_BATCH_MODE = `0x01${"00".repeat(31)}` as Hex;
const MAX_EXECUTIONS = 16;
const MAX_EXECUTION_BYTES = 65_536;

export interface Safe7579Call {
  target: Address;
  value: string;
  callData: Hex;
}

function fail(message: string): never {
  throw new RestError(400, "SMART_ACCOUNT_ENVELOPE_INVALID", message);
}
function hex(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    (value.length - 2) / 2 < minimum ||
    (value.length - 2) / 2 > maximum
  )
    fail(`${label} must contain ${minimum} to ${maximum} complete bytes.`);
  return value.toLowerCase() as Hex;
}
function callsChecked(calls: readonly Safe7579Call[]): Safe7579Call[] {
  if (
    !Array.isArray(calls) ||
    calls.length < 1 ||
    calls.length > MAX_EXECUTIONS
  )
    fail(`An execution must contain 1 to ${MAX_EXECUTIONS} exact calls.`);
  return calls.map((call, index) => {
    exactObject(call, ["target", "value", "callData"], `calls[${index}]`);
    return {
      target: address(call.target, `calls[${index}].target`, true),
      value: integer(call.value, `calls[${index}].value`).toString(),
      callData: hex(
        call.callData,
        `calls[${index}].callData`,
        0,
        MAX_EXECUTION_BYTES,
      ),
    };
  });
}

/** EntryPoint key = validator (160 bits) || caller-selected lane (32 bits). */
export function safe7579NonceKey(validator: Address, lane = "0"): string {
  return (
    (BigInt(address(validator, "validator", true)) << 32n) |
    integer(lane, "lane", false, 32)
  ).toString();
}

/** Safe7579 selects uint160(nonce >> 96); EntryPoint consumes the low 64-bit sequence. */
export function encodeSafe7579Nonce(input: {
  validator: Address;
  lane: string;
  sequence: string;
}): string {
  exactObject(input, ["validator", "lane", "sequence"], "nonce");
  return (
    (BigInt(safe7579NonceKey(input.validator, input.lane)) << 64n) |
    integer(input.sequence, "sequence", false, 64)
  ).toString();
}

export function decodeSafe7579Nonce(nonce: string): {
  validator: Address;
  lane: string;
  sequence: string;
  key: string;
} {
  const value = integer(nonce, "nonce");
  const validator = getAddress(toHex(value >> 96n, { size: 20 }));
  // A zero validator invokes owner-signature fallback, never a session validator.
  if (BigInt(validator) === 0n)
    fail("A session nonce must select a nonzero validator.");
  return {
    validator,
    lane: ((value >> 64n) & 0xffff_ffffn).toString(),
    sequence: (value & 0xffff_ffff_ffff_ffffn).toString(),
    key: (value >> 64n).toString(),
  };
}

/** f24dddf EncodeLib.encodeUse: packed USE(0), permissionId, opaque validator signature. */
export function encodeLegacyUseSignature(
  permissionId: Hex,
  signature: Hex,
): Hex {
  const permission = hex(permissionId, "permissionId", 32, 32);
  if (BigInt(permission) === 0n) fail("A permission ID must be nonzero.");
  return concatHex(["0x00", permission, hex(signature, "signature", 1, 4096)]);
}

export function decodeLegacyUseSignature(envelope: Hex): {
  permissionId: Hex;
  signature: Hex;
} {
  const data = hex(envelope, "signature envelope", 34, 4129);
  if (sliceHex(data, 0, 1) !== "0x00")
    fail("Only an already installed session's USE signature is accepted.");
  const permissionId = sliceHex(data, 1, 33);
  if (BigInt(permissionId) === 0n) fail("A permission ID must be nonzero.");
  return { permissionId, signature: sliceHex(data, 33) };
}

/** Raw encoder for trusted callers; execution admission must also call assertSafe7579Execution. */
export function encodeSafe7579Execution(calls: readonly Safe7579Call[]): Hex {
  const checked = callsChecked(calls);
  const first = checked[0]!;
  const mode =
    checked.length === 1 ? SAFE7579_SINGLE_MODE : SAFE7579_BATCH_MODE;
  const executionCalldata =
    checked.length === 1
      ? concatHex([
          first.target,
          toHex(BigInt(first.value), { size: 32 }),
          first.callData,
        ])
      : encodeAbiParameters(executionsParameter, [
          checked.map((call) => ({
            ...call,
            value: BigInt(call.value),
          })),
        ]);
  const encoded = encodeFunctionData({
    abi: SAFE7579_EXECUTION_ABI,
    functionName: "execute",
    args: [mode, executionCalldata],
  });
  if (size(encoded) > MAX_EXECUTION_BYTES)
    fail("The complete execution exceeds the byte limit.");
  return encoded.toLowerCase() as Hex;
}

/** Rejects try/delegate/custom modes, empty batches, aliases, padding, and trailing bytes. */
export function decodeSafe7579Execution(callData: Hex): Safe7579Call[] {
  const data = hex(callData, "execution", 4, MAX_EXECUTION_BYTES);
  try {
    const decoded = decodeFunctionData({ abi: SAFE7579_EXECUTION_ABI, data });
    const [mode, execution] = decoded.args;
    let calls: Safe7579Call[];
    if (mode === SAFE7579_SINGLE_MODE) {
      if (size(execution) < 52)
        fail("A packed single execution requires target and value.");
      calls = [
        {
          target: getAddress(sliceHex(execution, 0, 20)),
          value: BigInt(sliceHex(execution, 20, 52)).toString(),
          // viem rejects a slice starting at the end of an exact target/value body.
          callData: size(execution) === 52 ? "0x" : sliceHex(execution, 52),
        },
      ];
    } else if (mode === SAFE7579_BATCH_MODE) {
      const [batch] = decodeAbiParameters(executionsParameter, execution);
      if (batch.length < 2)
        fail("Canonical batches contain at least two calls.");
      calls = batch.map((call) => ({ ...call, value: call.value.toString() }));
    } else
      fail("Only default single or batch CALL execution modes are accepted.");
    if (encodeSafe7579Execution(calls) !== data)
      fail("The execution must use its exact canonical ABI encoding.");
    return calls;
  } catch (error) {
    if (error instanceof RestError) throw error;
    return fail("The account execution cannot be decoded canonically.");
  }
}

/** Expected calls come from the server's compiled action checks, never from request authority. */
export function assertSafe7579Execution(
  callData: Hex,
  expectedCalls: readonly Safe7579Call[],
): Safe7579Call[] {
  const decoded = decodeSafe7579Execution(callData);
  if (encodeSafe7579Execution(expectedCalls) !== callData.toLowerCase())
    fail(
      "The execution differs from the exact approved calls, values, or ordering.",
    );
  return decoded;
}

/** f22a194 ISafeOp.SAFE_OP_TYPEHASH = 0xc03dfc11...ef6ea7f. The domain is the adapter,
 * since Safe calls it normally through its fallback; the Safe address is a message field. */
export const SAFE7579_OWNER_TYPES = {
  EIP712Domain: [
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  SafeOp: [
    { name: "safe", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "verificationGasLimit", type: "uint128" },
    { name: "callGasLimit", type: "uint128" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "maxPriorityFeePerGas", type: "uint128" },
    { name: "maxFeePerGas", type: "uint128" },
    { name: "paymasterAndData", type: "bytes" },
    { name: "validAfter", type: "uint48" },
    { name: "validUntil", type: "uint48" },
    { name: "entryPoint", type: "address" },
  ],
} as const;

export interface Safe7579OwnerSigningInput {
  operation: UserOperationV07;
  chainId: number;
  safe7579: Address;
  entryPoint: Address;
  validAfter: string;
  validUntil: string;
}

/** Zero validator selects Safe owner fallback. This is deliberately separate from session nonces. */
export function encodeSafe7579OwnerNonce(sequence: string, lane = "0"): string {
  return (
    (integer(lane, "lane", false, 32) << 64n) |
    integer(sequence, "sequence", false, 64)
  ).toString();
}

export function safe7579OwnerSigningPayload(input: Safe7579OwnerSigningInput) {
  const operation = normalizeUserOperation(input.operation);
  if (BigInt(operation.nonce) >> 96n)
    fail("Owner signing requires a zero-validator nonce.");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0)
    fail("Use the verified execution chain.");
  const validAfter = integer(input.validAfter, "validAfter", false, 48);
  const validUntil = integer(input.validUntil, "validUntil", false, 48);
  if (validUntil <= validAfter)
    fail("Owner operations require a finite ordered validity interval.");
  const packed = packUserOperation(operation);
  const typedData = {
    domain: {
      chainId: BigInt(input.chainId),
      verifyingContract: address(input.safe7579, "safe7579", true),
    },
    types: SAFE7579_OWNER_TYPES,
    primaryType: "SafeOp" as const,
    message: {
      safe: operation.sender,
      nonce: BigInt(operation.nonce),
      initCode: packed.initCode,
      callData: operation.callData,
      verificationGasLimit: BigInt(operation.verificationGasLimit),
      callGasLimit: BigInt(operation.callGasLimit),
      preVerificationGas: BigInt(operation.preVerificationGas),
      maxPriorityFeePerGas: BigInt(operation.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(operation.maxFeePerGas),
      paymasterAndData: packed.paymasterAndData,
      validAfter: Number(validAfter),
      validUntil: Number(validUntil),
      entryPoint: address(input.entryPoint, "entryPoint", true),
    },
  };
  const digest = hashTypedData(typedData);
  return {
    scheme: "eip712-safe7579-owner" as const,
    digest,
    // JSON-safe eth_signTypedData_v4 payload; uint values remain exact decimal strings.
    typedData: {
      ...typedData,
      domain: { ...typedData.domain, chainId: input.chainId },
      message: {
        ...typedData.message,
        nonce: typedData.message.nonce.toString(),
        verificationGasLimit: typedData.message.verificationGasLimit.toString(),
        callGasLimit: typedData.message.callGasLimit.toString(),
        preVerificationGas: typedData.message.preVerificationGas.toString(),
        maxPriorityFeePerGas: typedData.message.maxPriorityFeePerGas.toString(),
        maxFeePerGas: typedData.message.maxFeePerGas.toString(),
        validAfter: validAfter.toString(),
        validUntil: validUntil.toString(),
      },
    },
    validAfter: validAfter.toString(),
    validUntil: validUntil.toString(),
  };
}

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export function canonicalEoaSignature(value: Hex): Hex {
  const signature = hex(value, "ECDSA signature", 65, 65);
  const r = BigInt(sliceHex(signature, 0, 32));
  const s = BigInt(sliceHex(signature, 32, 64));
  const v = Number(BigInt(sliceHex(signature, 64)));
  if (
    r === 0n ||
    r >= SECP256K1_ORDER ||
    s === 0n ||
    s > SECP256K1_ORDER / 2n ||
    (v !== 27 && v !== 28)
  )
    fail("Use canonical low-s ECDSA signatures with recovery byte 27 or 28.");
  return signature;
}

export function encodeSafe7579OwnerSignature(input: {
  validAfter: string;
  validUntil: string;
  /** Packed signatures must already be sorted by recovered owner address. */
  signatures: Hex;
}): Hex {
  const after = integer(input.validAfter, "validAfter", false, 48);
  const until = integer(input.validUntil, "validUntil", false, 48);
  if (until <= after)
    fail("Owner operations require a finite ordered validity interval.");
  const signatures = hex(input.signatures, "owner signatures", 65, 16 * 65);
  if (size(signatures) % 65 !== 0)
    fail("Owner signatures must be exact 65-byte entries.");
  for (let offset = 0; offset < size(signatures); offset += 65)
    canonicalEoaSignature(sliceHex(signatures, offset, offset + 65));
  return concatHex([
    toHex(after, { size: 6 }),
    toHex(until, { size: 6 }),
    signatures,
  ]);
}

/** Current EOA owners and threshold are supplied by the canonical ownership verifier. */
export async function verifySafe7579OwnerSignature(
  input: Safe7579OwnerSigningInput & {
    owners: readonly Address[];
    threshold: number;
  },
): Promise<Address[]> {
  const signatures = hex(
    input.operation.signature,
    "owner envelope",
    77,
    12 + 16 * 65,
  );
  const expectedPrefix = concatHex([
    toHex(integer(input.validAfter, "validAfter", false, 48), { size: 6 }),
    toHex(integer(input.validUntil, "validUntil", false, 48), { size: 6 }),
  ]);
  if (sliceHex(signatures, 0, 12) !== expectedPrefix)
    fail("Owner signature validity differs from its review.");
  const ownerSet = new Set(
    input.owners.map((owner) => address(owner, "owner", true).toLowerCase()),
  );
  if (
    !Number.isInteger(input.threshold) ||
    input.threshold < 1 ||
    input.threshold > 16 ||
    input.threshold > ownerSet.size ||
    ownerSet.size !== input.owners.length ||
    size(signatures) !== 12 + input.threshold * 65
  )
    fail(
      "Supply the exact current EOA owner threshold and packed signature count.",
    );
  const digest = safe7579OwnerSigningPayload(input).digest;
  const recovered: Address[] = [];
  let previous = 0n;
  for (let i = 0; i < input.threshold; i++) {
    const signature = canonicalEoaSignature(
      sliceHex(signatures, 12 + i * 65, 12 + (i + 1) * 65),
    );
    let signer: Address;
    try {
      signer = await recoverAddress({ hash: digest, signature });
    } catch {
      throw new RestError(
        403,
        "SMART_OWNER_SIGNATURE_INVALID",
        "The owner signature could not be recovered.",
      );
    }
    if (!ownerSet.has(signer.toLowerCase()) || BigInt(signer) <= previous)
      throw new RestError(
        403,
        "SMART_OWNER_SIGNATURE_INVALID",
        "Use sorted distinct signatures from the current owner threshold.",
      );
    recovered.push(signer);
    previous = BigInt(signer);
  }
  return recovered;
}

export interface LegacySessionSigningInput {
  operation: UserOperationV07;
  chainId: number;
  entryPoint: Address;
  smartSessions: Address;
  permissionId: Hex;
}

/** ff742c54 OwnableValidator.validateSignatureWithData prefixes the 32-byte UserOp hash. */
export function legacySessionSigningPayload(input: LegacySessionSigningInput) {
  const operation = normalizeUserOperation(input.operation);
  const selected = decodeSafe7579Nonce(BigInt(operation.nonce).toString());
  if (
    selected.validator.toLowerCase() !==
    address(input.smartSessions, "smartSessions", true).toLowerCase()
  )
    fail("The nonce must select the exact installed SmartSession validator.");
  const permissionId = hex(input.permissionId, "permissionId", 32, 32);
  if (BigInt(permissionId) === 0n) fail("A permission ID must be nonzero.");
  const operationHash = getUserOperationHash(
    operation,
    input.entryPoint,
    input.chainId,
  );
  return {
    scheme: "eip191-legacy-ownable-user-operation" as const,
    operationHash,
    digest: hashMessage({ raw: operationHash }),
    message: { raw: operationHash },
    permissionId,
    /** The prefix is an envelope selector, not an additional field in the signed UserOp hash. */
    signaturePrefix: concatHex(["0x00", permissionId]),
  };
}

export async function verifyLegacySessionSignature(
  input: LegacySessionSigningInput & {
    sessionKey: Address;
  },
): Promise<Address> {
  const payload = legacySessionSigningPayload(input);
  const envelope = decodeLegacyUseSignature(input.operation.signature);
  if (envelope.permissionId !== payload.permissionId)
    fail("The signature selects a different compiled permission.");
  const signature = canonicalEoaSignature(envelope.signature);
  let signer: Address;
  try {
    signer = await recoverAddress({ hash: payload.digest, signature });
  } catch {
    throw new RestError(
      403,
      "SMART_SESSION_SIGNATURE_INVALID",
      "The session signature could not be recovered.",
    );
  }
  if (
    signer.toLowerCase() !==
    address(input.sessionKey, "sessionKey", true).toLowerCase()
  )
    throw new RestError(
      403,
      "SMART_SESSION_SIGNATURE_INVALID",
      "The signature is not from the compiled session key.",
    );
  return signer;
}
