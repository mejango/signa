import { randomUUID } from "node:crypto";
import { keccak256, stringToHex, toHex, type Hex } from "viem";
import { RestError } from "../core.js";
import { CURRENT_PIMLICO_PAYMASTER } from "../smartAccounts/stack/current-pimlico/pins.js";
import {
  sessionGasEstimationOverrides,
  type SessionGasEstimation,
} from "./estimation.js";
import {
  getUserOperationHash,
  normalizeUserOperation,
  uoAddress,
  uoBytes,
  uoCanonical,
  uoError,
  uoHash,
  uoObject,
  uoQuantity,
  USER_OPERATION_LIMITS,
  withoutUserOperationSignature,
} from "./codec.js";
import type {
  PaymasterDataProof,
  PaymasterStub,
  UserOperationGasEstimate,
  UserOperationPaymasterPolicy,
  UserOperationProviderConfig,
  UserOperationV07,
} from "./types.js";

/** Exact Sourcify creation/runtime match; current-master flag layouts are NOT interchangeable. */
export const PIMLICO_LEGACY_V7_PAYMASTER = Object.freeze({
  address: "0x0000000000000039cd5e8ae05257ce51c473ddd1" as const,
  runtimeCodeHash:
    "0x1cd962f550282d1e4eadd0db10a956db2338c40f69c8b07cb434486275e1c11a" as const,
});
/** Independently reproduced solc 0.8.26 deployment; see stack/current-pimlico. */
export const PIMLICO_CURRENT_V7_PAYMASTER = CURRENT_PIMLICO_PAYMASTER;

export function createPimlicoCurrentV7PaymasterPolicy(options: {
  policyId: string;
  chainId: number;
  context?: Record<string, unknown>;
}): UserOperationPaymasterPolicy {
  if (
    !/^[a-zA-Z0-9._-]{1,128}$/.test(options.policyId) ||
    !Number.isSafeInteger(options.chainId) ||
    options.chainId <= 0
  )
    uoError(
      "INVALID_USER_OPERATION_PROVIDER",
      "The Pimlico policy identity or chain is invalid.",
      500,
    );
  return {
    id: options.policyId,
    profile: "pimlico-v7-current-flags",
    contract: { ...PIMLICO_CURRENT_V7_PAYMASTER },
    context: options.context ?? {},
    maximumPaymasterDataLength: 130,
    inspect(operation) {
      const op = normalizeUserOperation(operation);
      const data = op.paymasterData;
      // Exact deployed source: mode = flags >> 1; low bit is allowAllBundlers.
      // Only verifying mode zero has empty context and cannot charge account tokens.
      // Its OpenZeppelin ECDSA.recover(bytes) accepts a 65-byte signature only.
      if (
        op.paymaster !== PIMLICO_CURRENT_V7_PAYMASTER.address ||
        !data ||
        data.length !== 158 ||
        !["00", "01"].includes(data.slice(2, 4))
      )
        uoError(
          "PIMLICO_SPONSOR_MODE_REQUIRED",
          "Only the runtime-pinned current Pimlico verifying mode is supported. Token charging and unknown formats are rejected.",
        );
      const validUntil = Number(BigInt(`0x${data.slice(4, 16)}`));
      const validAfter = Number(BigInt(`0x${data.slice(16, 28)}`));
      return {
        policyId: options.policyId,
        gasOnly: true,
        validAfter,
        validUntil: validUntil === 0 ? Number((1n << 48n) - 1n) : validUntil,
        commitment: keccak256(
          stringToHex(
            uoCanonical({
              profile: "pimlico-v7-current-flags",
              chainId: options.chainId,
              contract: PIMLICO_CURRENT_V7_PAYMASTER,
              operation: withoutUserOperationSignature(op),
            }),
          ),
        ),
      };
    },
  };
}

export function createPimlicoV7PaymasterPolicy(options: {
  policyId: string;
  chainId: number;
  context?: Record<string, unknown>;
}): UserOperationPaymasterPolicy {
  if (
    !/^[a-zA-Z0-9._-]{1,128}$/.test(options.policyId) ||
    !Number.isSafeInteger(options.chainId) ||
    options.chainId <= 0
  )
    uoError(
      "INVALID_USER_OPERATION_PROVIDER",
      "The Pimlico policy identity or chain is invalid.",
      500,
    );
  return {
    id: options.policyId,
    profile: "pimlico-v7-legacy-mode",
    contract: { ...PIMLICO_LEGACY_V7_PAYMASTER },
    context: options.context ?? {},
    maximumPaymasterDataLength: 130,
    inspect(operation) {
      const op = normalizeUserOperation(operation);
      const data = op.paymasterData;
      // Verified deployed legacy source: byte 0 is mode itself. Byte 1 is
      // ERC20 charging, NOT the newer allowAllBundlers flag. Never accept it.
      if (
        op.paymaster !== PIMLICO_LEGACY_V7_PAYMASTER.address ||
        !data ||
        data.length !== 158 ||
        data.slice(2, 4) !== "00"
      )
        uoError(
          "PIMLICO_SPONSOR_MODE_REQUIRED",
          "Only the runtime-pinned legacy Pimlico gas-sponsorship mode is supported. Token charging and unknown formats are rejected.",
        );
      const validUntil = Number(BigInt(`0x${data.slice(4, 16)}`));
      const validAfter = Number(BigInt(`0x${data.slice(16, 28)}`));
      return {
        policyId: options.policyId,
        gasOnly: true,
        validAfter,
        validUntil: validUntil === 0 ? Number((1n << 48n) - 1n) : validUntil,
        commitment: keccak256(
          stringToHex(
            uoCanonical({
              profile: "pimlico-v7-legacy-mode",
              chainId: options.chainId,
              contract: PIMLICO_LEGACY_V7_PAYMASTER,
              operation: withoutUserOperationSignature(op),
            }),
          ),
        ),
      };
    },
  };
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    uoError(
      "USER_OPERATION_CANCELLED",
      "The user operation request was cancelled.",
      499,
    );
}
function endpoint(input: string): string {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.hostname
    )
      throw new Error();
    return url.href;
  } catch {
    return uoError(
      "INVALID_USER_OPERATION_PROVIDER",
      "Configure a fixed HTTPS provider endpoint.",
      500,
    );
  }
}
function headers(input: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(input))
    if (
      !/^(authorization|x-api-key|x-pimlico-api-key)$/i.test(key) ||
      typeof value !== "string" ||
      value.length > 4096 ||
      /[\r\n]/.test(value)
    )
      uoError(
        "INVALID_USER_OPERATION_PROVIDER",
        "Provider credential headers are invalid.",
        500,
      );
  return {
    ...input,
    "content-type": "application/json",
    accept: "application/json",
  };
}
/** Provider-neutral ERC-4337/EIP-7677 JSON-RPC; no URL or context is accepted from callers. */
export class UserOperationProvider {
  private readonly configurations = new Map<
    number,
    UserOperationProviderConfig
  >();
  constructor(
    configurations: readonly UserOperationProviderConfig[],
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
    private readonly now = Date.now,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      configurations.length > 8
    )
      uoError(
        "INVALID_USER_OPERATION_PROVIDER",
        "Provider bounds are invalid.",
        500,
      );
    for (const config of configurations) {
      if (
        !Number.isSafeInteger(config.chainId) ||
        config.chainId <= 0 ||
        this.configurations.has(config.chainId) ||
        !/^[a-zA-Z0-9._-]{1,128}$/.test(config.providerId)
      )
        uoError(
          "INVALID_USER_OPERATION_PROVIDER",
          "Provider chain or identity is invalid.",
          500,
        );
      uoAddress(config.entryPoint.address, "EntryPoint");
      uoHash(config.entryPoint.runtimeCodeHash, "EntryPoint code hash");
      if (config.simulationBundlerAddress !== undefined) {
        uoAddress(config.simulationBundlerAddress, "simulation bundler");
        if (
          config.paymasterPolicy?.profile !== "pimlico-v7-current-flags" ||
          BigInt(config.simulationBundlerAddress) === 0n
        )
          uoError(
            "INVALID_USER_OPERATION_PROVIDER",
            "A simulation bundler must be a nonzero operator-configured address for the current Pimlico profile.",
            500,
          );
      }
      headers(config.bundlerHeaders);
      headers(config.paymasterHeaders);
      if (Boolean(config.paymasterPolicy) !== Boolean(config.paymasterUrl))
        uoError(
          "INVALID_USER_OPERATION_PROVIDER",
          "A paymaster endpoint needs a reviewed contract and data policy.",
          500,
        );
      if (config.paymasterPolicy) {
        uoAddress(config.paymasterPolicy.contract.address, "paymaster");
        uoHash(
          config.paymasterPolicy.contract.runtimeCodeHash,
          "paymaster code hash",
        );
        if (
          typeof config.paymasterPolicy.inspect !== "function" ||
          Buffer.byteLength(uoCanonical(config.paymasterPolicy.context)) > 8192
        )
          uoError(
            "INVALID_USER_OPERATION_PROVIDER",
            "The paymaster policy is invalid.",
            500,
          );
        const maximum =
          config.paymasterPolicy.maximumPaymasterDataLength ??
          USER_OPERATION_LIMITS.paymasterBytes + 52;
        if (
          !Number.isSafeInteger(maximum) ||
          maximum < 52 ||
          maximum > USER_OPERATION_LIMITS.paymasterBytes + 52
        )
          uoError(
            "INVALID_USER_OPERATION_PROVIDER",
            "The reviewed paymaster byte limit is invalid.",
            500,
          );
      }
      this.configurations.set(config.chainId, {
        ...config,
        bundlerUrl: endpoint(config.bundlerUrl),
        ...(config.paymasterUrl
          ? { paymasterUrl: endpoint(config.paymasterUrl) }
          : {}),
        ...(config.bundlerHeaders
          ? { bundlerHeaders: { ...config.bundlerHeaders } }
          : {}),
        ...(config.paymasterHeaders
          ? { paymasterHeaders: { ...config.paymasterHeaders } }
          : {}),
      });
    }
  }
  /** Trusted application configuration. Never return this object through HTTP. */
  configuration(chainId: number): UserOperationProviderConfig {
    return (
      this.configurations.get(chainId) ??
      uoError(
        "USER_OPERATION_PROVIDER_UNAVAILABLE",
        "No reviewed provider is configured for this chain.",
        503,
      )
    );
  }
  capabilities() {
    return [...this.configurations.values()].map((config) => ({
      chainId: config.chainId,
      providerId: config.providerId,
      entryPoint: config.entryPoint.address,
      version: "0.7",
      paymasterConfigured: Boolean(config.paymasterPolicy),
    }));
  }
  /** The bundler's own fee floor (Pimlico's fast tier, so a quote taken at preparation still
   * clears the floor minutes later at submission). An operation priced below it waits in the
   * mempool until it expires. Null only when the bundler answers that it has no such method. */
  async gasPrice(
    chainId: number,
    signal?: AbortSignal,
  ): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null> {
    const config = this.configuration(chainId);
    let value: unknown;
    try {
      value = await this.rpc(config, false, "pimlico_getUserOperationGasPrice", [], signal);
    } catch (error) {
      if (error instanceof RestError && error.code === "USER_OPERATION_PROVIDER_REJECTED") return null;
      throw error;
    }
    const fast = uoObject(value) && uoObject(value.fast) ? value.fast : uoError(
      "USER_OPERATION_PROVIDER_RESPONSE", "The bundler fee quote is malformed.", 502);
    return {
      maxFeePerGas: uoQuantity(fast.maxFeePerGas, "bundler max fee"),
      maxPriorityFeePerGas: uoQuantity(fast.maxPriorityFeePerGas, "bundler priority fee"),
    };
  }
  /** A bundler's chain and EntryPoint hold for a minute; every preparation checked both before. */
  private readonly ready = new Map<number, { until: number; result: Awaited<ReturnType<UserOperationProvider["checkReadiness"]>> }>();
  private readonly stubs = new Map<number, { until: number; result: unknown }>();
  async readiness(chainId: number, signal?: AbortSignal) {
    const kept = this.ready.get(chainId);
    if (kept && kept.until > this.now()) return { ...kept.result };
    const result = await this.checkReadiness(chainId, signal);
    this.ready.set(chainId, { until: this.now() + 60_000, result });
    return result;
  }
  private async checkReadiness(chainId: number, signal?: AbortSignal) {
    const config = this.configuration(chainId);
    const [chain, entries] = await Promise.all([
      this.rpc(config, false, "eth_chainId", [], signal),
      this.rpc(config, false, "eth_supportedEntryPoints", [], signal),
    ]);
    if (
      uoQuantity(chain, "bundler chain") !== BigInt(chainId) ||
      !Array.isArray(entries) ||
      entries.length > 16 ||
      !entries.every((entry) => typeof entry === "string") ||
      !entries.some(
        (entry) =>
          entry.toLowerCase() === config.entryPoint.address.toLowerCase(),
      )
    )
      uoError(
        "USER_OPERATION_PROVIDER_MISMATCH",
        "The bundler did not confirm the expected chain and EntryPoint.",
        502,
      );
    return {
      chainId,
      providerId: config.providerId,
      entryPoint: config.entryPoint.address,
    };
  }
  async estimate(
    chainId: number,
    operation: UserOperationV07,
    signal?: AbortSignal,
    sessionGas?: SessionGasEstimation,
  ): Promise<UserOperationGasEstimate> {
    const config = this.configuration(chainId);
    const op = normalizeUserOperation(operation);
    const params = [
      op,
      config.entryPoint.address,
      ...(sessionGas
        ? [sessionGasEstimationOverrides(sessionGas, chainId, op)]
        : []),
    ];
    let value: unknown;
    try {
      value = await this.rpc(
        config,
        false,
        "eth_estimateUserOperationGas",
        params,
        signal,
      );
    } catch (error) {
      if (
        sessionGas &&
        error instanceof RestError &&
        error.code === "USER_OPERATION_PROVIDER_REJECTED"
      )
        uoError(
          "SESSION_GAS_ESTIMATION_UNAVAILABLE",
          "The hosted bundler could not estimate this bounded session with source-verified gas-ceiling overrides. Verify provider stateDiff support and remaining onchain action/call budgets; no unsigned fallback or publication was attempted.",
          502,
        );
      throw error;
    }
    const fields = [
      "callGasLimit",
      "verificationGasLimit",
      "preVerificationGas",
      "paymasterVerificationGasLimit",
      "paymasterPostOpGasLimit",
    ];
    if (
      !uoObject(value) ||
      Object.keys(value).some((key) => !fields.includes(key))
    )
      uoError(
        "INVALID_USER_OPERATION_ESTIMATE",
        "The bundler returned an unsupported gas estimate.",
        502,
      );
    const result: UserOperationGasEstimate = {
      callGasLimit: toHex(
        uoQuantity(value.callGasLimit, "estimated call gas", 128),
      ),
      verificationGasLimit: toHex(
        uoQuantity(
          value.verificationGasLimit,
          "estimated verification gas",
          128,
        ),
      ),
      preVerificationGas: toHex(
        uoQuantity(value.preVerificationGas, "estimated pre-verification gas"),
      ),
    };
    for (const key of fields.slice(3) as (
      "paymasterVerificationGasLimit" | "paymasterPostOpGasLimit"
    )[])
      if (key in value) {
        const quantity = uoQuantity(value[key], `estimated ${key}`, 128);
        if (op.paymaster) result[key] = toHex(quantity);
        else if (quantity !== 0n)
          uoError(
            "INVALID_USER_OPERATION_ESTIMATE",
            "The bundler added an unrequested paymaster estimate.",
            502,
          );
      }
    return result;
  }
  private paymasterResult(
    config: UserOperationProviderConfig,
    operation: UserOperationV07,
    value: unknown,
    phase: "stub" | "final",
  ): PaymasterStub {
    const policy =
      config.paymasterPolicy ??
      uoError(
        "USER_OPERATION_PAYMASTER_UNAVAILABLE",
        "No reviewed paymaster is configured.",
        503,
      );
    const allowed =
      phase === "stub"
        ? [
            "paymaster",
            "paymasterData",
            "paymasterVerificationGasLimit",
            "paymasterPostOpGasLimit",
            "isFinal",
            "sponsor",
          ]
        : [
            "paymaster",
            "paymasterData",
            "paymasterVerificationGasLimit",
            "paymasterPostOpGasLimit",
          ];
    if (
      !uoObject(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) ||
      ("isFinal" in value && typeof value.isFinal !== "boolean")
    )
      uoError(
        "INVALID_USER_OPERATION_PAYMASTER",
        "The paymaster returned unsupported fields.",
        502,
      );
    if (
      uoAddress(value.paymaster, "returned paymaster") !==
      policy.contract.address.toLowerCase()
    )
      uoError(
        "USER_OPERATION_PAYMASTER_MISMATCH",
        "The paymaster does not match the reviewed contract.",
        502,
      );
    if (phase === "stub" && value.paymasterPostOpGasLimit === undefined)
      uoError(
        "INVALID_USER_OPERATION_PAYMASTER",
        "EIP-7677 v0.7 stub data must specify post-op gas.",
        502,
      );
    const op = normalizeUserOperation({
      ...operation,
      paymaster: value.paymaster,
      paymasterData: uoBytes(
        value.paymasterData,
        "returned paymaster data",
        USER_OPERATION_LIMITS.paymasterBytes,
      ),
      paymasterVerificationGasLimit:
        value.paymasterVerificationGasLimit ??
        operation.paymasterVerificationGasLimit ??
        "0x0",
      paymasterPostOpGasLimit:
        value.paymasterPostOpGasLimit ?? operation.paymasterPostOpGasLimit,
    });
    const proof = this.inspectPaymaster(config.chainId, op, phase);
    return {
      operation: op,
      isFinal: phase === "final" || value.isFinal === true,
      proof,
    };
  }
  inspectPaymaster(
    chainId: number,
    operation: UserOperationV07,
    phase: "stub" | "final",
  ): PaymasterDataProof {
    const policy =
      this.configuration(chainId).paymasterPolicy ??
      uoError(
        "USER_OPERATION_PAYMASTER_UNAVAILABLE",
        "No reviewed paymaster data policy is configured.",
        503,
      );
    const op = normalizeUserOperation(operation);
    if (op.paymaster !== policy.contract.address.toLowerCase())
      uoError(
        "USER_OPERATION_PAYMASTER_MISMATCH",
        "An unreviewed paymaster cannot fund this operation.",
      );
    if (
      (op.paymasterData!.length - 2) / 2 + 52 >
      (policy.maximumPaymasterDataLength ??
        USER_OPERATION_LIMITS.paymasterBytes + 52)
    )
      uoError(
        "USER_OPERATION_PAYMASTER_POLICY",
        "Paymaster data exceeds the reviewed onchain byte limit.",
      );
    const proof = policy.inspect(op, phase);
    const now = Math.floor(this.now() / 1000);
    if (
      !proof ||
      proof.policyId !== policy.id ||
      proof.gasOnly !== true ||
      !Number.isSafeInteger(proof.validAfter) ||
      !Number.isSafeInteger(proof.validUntil) ||
      proof.validAfter < 0 ||
      proof.validAfter > now ||
      proof.validUntil <= now + 30 ||
      proof.validUntil <= proof.validAfter
    )
      uoError(
        "USER_OPERATION_PAYMASTER_POLICY",
        "The reviewed paymaster data is not currently eligible.",
      );
    return {
      ...proof,
      commitment: uoHash(proof.commitment, "paymaster proof commitment"),
    };
  }
  async stub(
    chainId: number,
    operation: UserOperationV07,
    signal?: AbortSignal,
  ): Promise<PaymasterStub> {
    const config = this.configuration(chainId);
    const op = normalizeUserOperation(operation);
    if (op.signature !== "0x")
      uoError(
        "USER_OPERATION_ALREADY_SIGNED",
        "Complete sponsorship before requesting the owner/session signature.",
        400,
      );
    // A verifying paymaster's stub is the same for every operation under one policy: it is kept for
    // ten minutes. A kept stub that stops validating (its own window passed) or that a final
    // sponsorship no longer matches is dropped and fetched again, so no stale copy outlives one use.
    const fetchStub = () => this.rpc(
      config,
      true,
      "pm_getPaymasterStubData",
      [
        withoutUserOperationSignature(op),
        config.entryPoint.address,
        toHex(chainId),
        config.paymasterPolicy?.context,
      ],
      signal,
    );
    const kept = this.stubs.get(chainId);
    if (kept && kept.until > this.now()) {
      try { return this.paymasterResult(config, op, kept.result, "stub"); }
      catch { this.stubs.delete(chainId); }
    }
    const result = await fetchStub();
    const stub = this.paymasterResult(config, op, result, "stub");
    if (!stub.isFinal) this.stubs.set(chainId, { result: structuredClone(result), until: this.now() + 600_000 });
    return stub;
  }
  async sponsor(
    chainId: number,
    operation: UserOperationV07,
    signal?: AbortSignal,
  ): Promise<PaymasterStub> {
    const config = this.configuration(chainId);
    const op = normalizeUserOperation(operation);
    if (op.signature !== "0x")
      uoError(
        "USER_OPERATION_ALREADY_SIGNED",
        "Paymaster fields cannot change after owner/session signing.",
        400,
      );
    if (!op.paymaster)
      uoError(
        "USER_OPERATION_PAYMASTER_STUB_REQUIRED",
        "Obtain and estimate the reviewed paymaster stub before final sponsorship.",
        400,
      );
    const result = await this.rpc(
      config,
      true,
      "pm_getPaymasterData",
      [
        withoutUserOperationSignature(op),
        config.entryPoint.address,
        toHex(chainId),
        config.paymasterPolicy?.context,
      ],
      signal,
    );
    const final = this.paymasterResult(config, op, result, "final");
    const countZeroBytes = (data: Hex) =>
      data
        .slice(2)
        .match(/../g)
        ?.filter((byte) => byte === "00").length ?? 0;
    const shapeChanged = final.operation.paymasterData!.length !== op.paymasterData!.length ||
      (config.paymasterPolicy?.profile !== "pimlico-v7-current-flags" &&
        countZeroBytes(op.paymasterData!) > countZeroBytes(final.operation.paymasterData!));
    const gasChanged = final.operation.paymasterVerificationGasLimit !== op.paymasterVerificationGasLimit ||
      final.operation.paymasterPostOpGasLimit !== op.paymasterPostOpGasLimit;
    // The stub the operation was shaped by no longer matches the paymaster: the next preparation fetches a fresh one.
    if (shapeChanged || gasChanged) this.stubs.delete(chainId);
    if (shapeChanged)
      uoError(
        "USER_OPERATION_PAYMASTER_STUB_CHANGED",
        "Final paymaster data invalidates the stub calldata gas estimate.",
      );
    if (gasChanged)
      uoError(
        "USER_OPERATION_PAYMASTER_GAS_CHANGED",
        "The paymaster changed estimated gas fields; prepare and estimate again.",
      );
    return final;
  }
  /** One attempt only. The caller MUST durably reserve this exact operation before invoking it. */
  async send(
    chainId: number,
    operation: UserOperationV07,
    signal?: AbortSignal,
  ): Promise<Hex> {
    const config = this.configuration(chainId);
    const op = normalizeUserOperation(operation);
    if (op.signature === "0x")
      uoError(
        "USER_OPERATION_SIGNATURE_REQUIRED",
        "An external account signature is required.",
        400,
      );
    const expected = getUserOperationHash(
      op,
      config.entryPoint.address,
      chainId,
    );
    try {
      const result = uoHash(
        await this.rpc(
          config,
          false,
          "eth_sendUserOperation",
          [op, config.entryPoint.address],
          signal,
        ),
        "returned operation hash",
      );
      if (result !== expected) throw new Error();
      return expected;
    } catch {
      return uoError(
        "USER_OPERATION_SUBMISSION_UNKNOWN",
        "The bundler may have received this exact operation. Reconcile its known hash; do not change or repeat publication automatically.",
        502,
      );
    }
  }
  async receipt(
    chainId: number,
    hash: Hex,
    signal?: AbortSignal,
  ): Promise<{ transactionHash: Hex } | null> {
    const config = this.configuration(chainId);
    const expected = uoHash(hash, "operation hash");
    const value = await this.rpc(
      config,
      false,
      "eth_getUserOperationReceipt",
      [expected],
      signal,
    );
    if (value === null) return null;
    if (
      !uoObject(value) ||
      uoHash(value.userOpHash, "receipt operation hash") !== expected ||
      !uoObject(value.receipt)
    )
      uoError(
        "INVALID_USER_OPERATION_RECEIPT",
        "The bundler receipt does not bind the expected operation.",
        502,
      );
    return {
      transactionHash: uoHash(
        value.receipt.transactionHash,
        "outer transaction hash",
      ),
    };
  }
  /** The bundle's transaction hash from the bundler's own status, known from the moment it submits the
   * bundle and seconds before its receipt: a hint only, verified on chain like the receipt's. */
  async status(chainId: number, hash: Hex, signal?: AbortSignal): Promise<{ transactionHash: Hex } | null> {
    const config = this.configuration(chainId);
    const value = await this.rpc(config, false, "pimlico_getUserOperationStatus", [uoHash(hash, "operation hash")], signal);
    if (!uoObject(value) || typeof value.transactionHash !== "string") return null;
    return { transactionHash: uoHash(value.transactionHash, "outer transaction hash") };
  }
  private async rpc(
    config: UserOperationProviderConfig,
    paymaster: boolean,
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    cancelled(signal);
    const url = paymaster ? config.paymasterUrl : config.bundlerUrl;
    if (!url)
      uoError(
        "USER_OPERATION_PAYMASTER_UNAVAILABLE",
        "No reviewed paymaster endpoint is configured.",
        503,
      );
    const id = randomUUID();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(body) > USER_OPERATION_LIMITS.operationBytes)
      uoError(
        "USER_OPERATION_TOO_LARGE",
        "The provider request exceeds its byte limit.",
        413,
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new RestError(
            504,
            "USER_OPERATION_PROVIDER_TIMEOUT",
            "The configured provider timed out.",
          ),
        );
        abort();
      }, this.timeoutMs);
    });
    const interrupted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        "abort",
        () =>
          reject(
            new RestError(
              499,
              "USER_OPERATION_CANCELLED",
              "The provider request was interrupted.",
            ),
          ),
        { once: true },
      ),
    );
    const work = (async () => {
      response = await this.fetcher(url, {
        method: "POST",
        headers: headers(
          paymaster ? config.paymasterHeaders : config.bundlerHeaders,
        ),
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        cancelled(controller.signal);
      }
      if (!response.ok || !response.body)
        uoError(
          "USER_OPERATION_PROVIDER_UNAVAILABLE",
          "The configured provider could not answer the request.",
          502,
        );
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d{1,10}$/.test(length) ||
          Number(length) > USER_OPERATION_LIMITS.responseBytes)
      )
        uoError(
          "USER_OPERATION_PROVIDER_LIMIT",
          "The provider response exceeds its byte limit.",
          502,
        );
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > USER_OPERATION_LIMITS.responseBytes)
          uoError(
            "USER_OPERATION_PROVIDER_LIMIT",
            "The provider response exceeds its byte limit.",
            502,
          );
        chunks.push(chunk.value);
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        return uoError(
          "USER_OPERATION_PROVIDER_RESPONSE",
          "The provider returned malformed JSON.",
          502,
        );
      }
      if (
        !uoObject(value) ||
        value.jsonrpc !== "2.0" ||
        value.id !== id ||
        "result" in value === "error" in value
      )
        uoError(
          "USER_OPERATION_PROVIDER_RESPONSE",
          "The provider response is not bound to this request.",
          502,
        );
      if ("error" in value)
        uoError(
          "USER_OPERATION_PROVIDER_REJECTED",
          "The provider rejected the operation. Its private response details are not exposed.",
          502,
        );
      return value.result;
    })();
    try {
      return await Promise.race([work, timeout, interrupted]);
    } catch (error) {
      if (error instanceof RestError) throw error;
      return uoError(
        "USER_OPERATION_PROVIDER_UNAVAILABLE",
        "The configured provider could not answer the request.",
        502,
      );
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (response) void response.body?.cancel().catch(() => {});
    }
  }
}
