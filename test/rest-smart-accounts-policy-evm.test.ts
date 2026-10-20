import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  amountRule,
  decodeUniversalAction,
  encodeTimeFrame,
  encodeUniversalAction,
  equalRule,
} from "../src/rest/smartAccounts/compiler/encoding.js";
import type {
  LegacySession,
  ParameterRule,
} from "../src/rest/smartAccounts/compiler/types.js";
import {
  createLegacySessionCompiler,
  type SessionReview,
} from "../src/rest/smartAccounts/compiler.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import type { ContractPin } from "../src/rest/smartAccounts/types.js";

// These tests execute the reviewed contract runtimes in an isolated local EVM.
// The account caller is impersonated at the validator boundary. Safe owner
// activation, EntryPoint timestamp rejection, gas charging and target execution
// are deliberately outside this suite's evidence.
const available = anvilAvailable();
type Artifact = {
  name: string;
  address: Address;
  source: unknown;
  runtimeCodeHash: Hex;
  runtime: Hex;
  abi: Abi;
};
const artifact = (name: string): Artifact =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/smartAccounts/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const smart = artifact("SmartSession");
const time = artifact("TimeFramePolicy");
const universal = artifact("UniActionPolicy");
const value = artifact("ValueLimitPolicy");
const ownable = artifact("OwnableValidator");
const guardArtifact = JSON.parse(
  readFileSync(
    new URL(
      "../src/rest/smartAccounts/stack/artifacts/CenterSessionGuard.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  abi: Abi;
  deployedBytecode: Hex;
  runtimeCodeHash: Hex;
  source: { compilerArtifactSha256: string };
};
const guard: Artifact = {
  name: "CenterSessionGuard",
  address: "0x6000000000000000000000000000000000000006",
  source: guardArtifact.source,
  runtime: guardArtifact.deployedBytecode,
  runtimeCodeHash: guardArtifact.runtimeCodeHash,
  abi: guardArtifact.abi,
};
const artifacts = [smart, time, universal, value, ownable, guard];
const account = "0x1000000000000000000000000000000000000001" as const;
const attacker = "0x2000000000000000000000000000000000000002" as const;
const terminal = "0x3000000000000000000000000000000000000003" as const;
const token = "0x4000000000000000000000000000000000000004" as const;
const recipient = "0x5000000000000000000000000000000000000005" as const;
const native = "0x000000000000000000000000000000000000EEEe" as const;
const bot = privateKeyToAccount(`0x${"33".repeat(32)}`);
const operationHash = keccak256(toHex("pinned local validator operation"));
const validAfter = 1_800_000_000;
const validUntil = validAfter + 7 * 86400;
const expectedValidationData =
  (BigInt(validUntil) << 160n) | (BigInt(validAfter) << 208n);
const actionAbi = parseAbi([
  "function transfer(address to,uint256 amount) returns (bool)",
  "function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function execute(bytes32 mode,bytes executionCalldata)",
  "function installModule(uint256 moduleType,address module,bytes initData)",
]);
const rule = (
  offset: number,
  ref: Hex | bigint,
  cap?: bigint,
): ParameterRule =>
  cap === undefined
    ? equalRule(offset, ref)
    : amountRule(offset, String(ref), String(cap));
const universalData = (rules: ParameterRule[], valueLimitPerUse: bigint): Hex =>
  encodeUniversalAction(String(valueLimitPerUse), rules).initData;
const timeData = encodeTimeFrame(validAfter, validUntil);
const transferData = (amount: bigint, to: Address = recipient) =>
  encodeFunctionData({
    abi: actionAbi,
    functionName: "transfer",
    args: [to, amount],
  });
const payData = (
  amount: bigint,
  options: {
    memo?: string;
    metadata?: Hex;
    projectId?: bigint;
    beneficiary?: Address;
    asset?: Address;
    minimum?: bigint;
  } = {},
) =>
  encodeFunctionData({
    abi: actionAbi,
    functionName: "pay",
    args: [
      options.projectId ?? 123n,
      options.asset ?? native,
      amount,
      options.beneficiary ?? recipient,
      options.minimum ?? 7n,
      options.memo ?? "",
      options.metadata ?? "0x",
    ],
  });
const single = (
  target: Address,
  amount: bigint,
  data: Hex,
  mode: Hex = zeroHash,
) =>
  encodeFunctionData({
    abi: actionAbi,
    functionName: "execute",
    args: [
      mode,
      encodePacked(["address", "uint256", "bytes"], [target, amount, data]),
    ],
  });
const mode = (callType: number, executionType = 0) =>
  concatHex([
    toHex(callType, { size: 1 }),
    toHex(executionType, { size: 1 }),
    `0x${"00".repeat(30)}`,
  ]);
const batch = (
  executions: { target: Address; value: bigint; callData: Hex }[],
) =>
  encodeFunctionData({
    abi: actionAbi,
    functionName: "execute",
    args: [
      mode(1),
      encodeAbiParameters(
        parseAbiParameters("(address target,uint256 value,bytes callData)[]"),
        [executions],
      ),
    ],
  });

describe.runIf(available)(
  "pinned legacy SmartSession policies in local Anvil",
  () => {
    let child: ChildProcess | undefined;
    let endpoint = "";
    let snapshot: Hex;
    let rpcId = 0;
    let stderr = "";
    async function rpc<T = unknown>(
      method: string,
      params: unknown[] = [],
    ): Promise<T> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await response.json()) as {
        result: T;
        error?: { message: string; data?: unknown };
      };
      if (body.error)
        throw new Error(
          `${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? "")}`,
        );
      return body.result;
    }
    const dataFor = (
      contract: Artifact,
      functionName: string,
      args: readonly unknown[],
    ) => encodeFunctionData({ abi: contract.abi, functionName, args });
    async function call(
      contract: Artifact,
      functionName: string,
      args: readonly unknown[],
      from: Address = account,
    ): Promise<unknown> {
      const data = await rpc<Hex>("eth_call", [
        {
          from,
          to: contract.address,
          data: dataFor(contract, functionName, args),
          gas: "0x1c9c380",
        },
        "latest",
      ]);
      return decodeFunctionResult({ abi: contract.abi, functionName, data });
    }
    async function write(
      contract: Artifact,
      functionName: string,
      args: readonly unknown[],
      from: Address = account,
    ) {
      const hash = await rpc<Hex>("eth_sendTransaction", [
        {
          from,
          to: contract.address,
          data: dataFor(contract, functionName, args),
          gas: "0x1c9c380",
        },
      ]);
      let receipt: { status: Hex } | null = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        receipt = await rpc<{ status: Hex } | null>(
          "eth_getTransactionReceipt",
          [hash],
        );
        if (receipt) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(
        receipt?.status,
        `${contract.name}.${functionName} transaction status`,
      ).toBe("0x1");
      return hash;
    }
    async function initialize(
      contract: Artifact,
      id: Hex,
      data: Hex,
      multiplexer: Address = account,
    ) {
      await write(
        contract,
        "initializeWithMultiplexer",
        [account, id, data],
        multiplexer,
      );
    }
    function session(
      salt: Hex = keccak256(toHex("generation one")),
    ): LegacySession {
      return {
        sessionValidator: ownable.address,
        sessionValidatorInitData: encodeAbiParameters(
          parseAbiParameters("uint256,address[]"),
          [1n, [bot.address]],
        ),
        salt,
        userOpPolicies: [{ policy: time.address, initData: timeData }],
        erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
        actions: [
          {
            actionTarget: token,
            actionTargetSelector: transferData(1n).slice(0, 10) as Hex,
            actionPolicies: [
              {
                policy: universal.address,
                initData: universalData(
                  [rule(0, recipient), rule(32, 60n, 100n)],
                  0n,
                ),
              },
              { policy: time.address, initData: timeData },
            ],
          },
          {
            actionTarget: terminal,
            actionTargetSelector: payData(1n).slice(0, 10) as Hex,
            actionPolicies: [
              {
                policy: universal.address,
                initData: universalData(
                  [
                    rule(0, 123n),
                    rule(32, native),
                    rule(96, recipient),
                    rule(128, 7n),
                    rule(160, 224n),
                    rule(192, 256n),
                    rule(224, 0n),
                    rule(256, 0n),
                    rule(64, 60n, 100n),
                  ],
                  60n,
                ),
              },
              {
                policy: value.address,
                initData: encodeAbiParameters(parseAbiParameters("uint256"), [
                  100n,
                ]),
              },
              { policy: time.address, initData: timeData },
            ],
          },
        ],
        permitERC4337Paymaster: false,
      };
    }
    async function install(data = session()) {
      const enable = smart.abi.find(
        (item): item is AbiFunction =>
          item.type === "function" && item.name === "enableSessions",
      )!;
      // UNSAFE_ENABLE bypasses the attestation registry only for local setup;
      // it is a call made by the account, never an accepted bot activation path.
      await write(smart, "onInstall", [
        concatHex(["0x02", encodeAbiParameters(enable.inputs, [[data]])]),
      ]);
      const permissionId = (await call(smart, "getPermissionId", [
        data,
      ])) as Hex;
      expect(
        await call(smart, "isPermissionEnabled", [permissionId, account]),
      ).toBe(true);
      return { data, permissionId };
    }
    async function operation(
      permissionId: Hex,
      callData = single(token, 0n, transferData(10n)),
      options: {
        sender?: Address;
        signer?: typeof bot;
        paymasterAndData?: Hex;
      } = {},
    ) {
      return {
        sender: options.sender ?? account,
        nonce: 0n,
        initCode: "0x" as Hex,
        callData,
        accountGasLimits: zeroHash as Hex,
        preVerificationGas: 0n,
        gasFees: zeroHash as Hex,
        paymasterAndData: options.paymasterAndData ?? "0x",
        signature: concatHex([
          "0x00",
          permissionId,
          await (options.signer ?? bot).signMessage({
            message: { raw: operationHash },
          }),
        ]),
      };
    }
    async function validate(
      permissionId: Hex,
      callData?: Hex,
      options?: Parameters<typeof operation>[2],
      from: Address = account,
    ) {
      return call(
        smart,
        "validateUserOp",
        [await operation(permissionId, callData, options), operationHash],
        from,
      );
    }

    beforeAll(async () => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing local test port");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      endpoint = `http://127.0.0.1:${address.port}`;
      child = spawnAnvil(
        [
          "--host",
          "127.0.0.1",
          "--port",
          String(address.port),
          "--chain-id",
          "31337",
          "--timestamp",
          String(validAfter),
          "--silent",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await rpc("eth_chainId");
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      if (!ready) throw new Error(`Local Anvil did not start: ${stderr}`);
      for (const caller of [account, attacker]) {
        await rpc("anvil_impersonateAccount", [caller]);
        await rpc("anvil_setBalance", [caller, "0x56bc75e2d63100000"]);
      }
      for (const contract of artifacts) {
        expect(keccak256(contract.runtime)).toBe(contract.runtimeCodeHash);
        await rpc("anvil_setCode", [contract.address, contract.runtime]);
        expect(
          keccak256(
            await rpc<Hex>("eth_getCode", [contract.address, "latest"]),
          ),
        ).toBe(contract.runtimeCodeHash);
      }
      snapshot = await rpc<Hex>("evm_snapshot");
    }, 20_000);
    beforeEach(async () => {
      expect(await rpc("evm_revert", [snapshot])).toBe(true);
      snapshot = await rpc<Hex>("evm_snapshot");
    });
    afterAll(async () => {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolve) =>
          child!.once("exit", () => resolve()),
        );
        child.kill("SIGTERM");
        await exited;
      }
    });

    it("executes the pinned runtimes and decodes current 12-byte timeframe initialization", async () => {
      expect(artifacts.slice(0, 5).map((a) => a.runtimeCodeHash)).toEqual([
        "0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c",
        "0xa8c18f7a974673552d03d7325bbc33a102a5aaab5bc5a3c11ecae1648ca4e026",
        "0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd",
        "0x086e8421c6c9daab4a93e63366c83e8f20cc3f736b7be5a97e0e81633581e4ed",
        "0xd9ad90a204447aec1a1528d764e1d80212c8011dc0125b3995875e58ec9a43bf",
      ]);
      await initialize(time, zeroHash, timeData);
      expect(
        await call(time, "checkAction", [
          zeroHash,
          account,
          terminal,
          0n,
          "0x",
        ]),
      ).toBe(expectedValidationData);
      expect(
        await call(time, "check1271SignedAction", [
          zeroHash,
          zeroAddress,
          account,
          zeroHash,
          "0x",
        ]),
      ).toBe(true);
      await rpc("evm_setNextBlockTimestamp", [validUntil + 1]);
      await rpc("evm_mine");
      expect(
        await call(time, "check1271SignedAction", [
          zeroHash,
          zeroAddress,
          account,
          zeroHash,
          "0x",
        ]),
      ).toBe(false);
      // ERC-4337 expiry is encoded, not checked by checkAction itself.
      expect(
        await call(time, "checkAction", [
          zeroHash,
          account,
          terminal,
          0n,
          "0x",
        ]),
      ).toBe(expectedValidationData);
    });

    it("accepts a real bot signature and preserves policy validity through legacy validateUserOp", async () => {
      const { permissionId } = await install();
      expect(await validate(permissionId)).toBe(expectedValidationData);
      await rpc("evm_setNextBlockTimestamp", [validUntil + 1]);
      await rpc("evm_mine");
      expect(await validate(permissionId)).toBe(expectedValidationData);
      expect((expectedValidationData >> 160n) & ((1n << 48n) - 1n)).toBe(
        BigInt(validUntil),
      );
    });

    it("enforces exact ERC20 recipient, zero native value, per-call and durable cumulative amount", async () => {
      const { permissionId } = await install();
      await expect(
        validate(permissionId, single(token, 0n, transferData(1n, attacker))),
      ).rejects.toThrow();
      await expect(
        validate(permissionId, single(token, 1n, transferData(1n))),
      ).rejects.toThrow();
      await expect(
        validate(permissionId, single(token, 0n, transferData(61n))),
      ).rejects.toThrow();
      await write(smart, "validateUserOp", [
        await operation(permissionId, single(token, 0n, transferData(60n))),
        operationHash,
      ]);
      expect(
        await validate(permissionId, single(token, 0n, transferData(40n))),
      ).toBe(expectedValidationData);
      await expect(
        validate(permissionId, single(token, 0n, transferData(41n))),
      ).rejects.toThrow();
      await write(smart, "validateUserOp", [
        await operation(permissionId, single(token, 0n, transferData(40n))),
        operationHash,
      ]);
      await expect(
        validate(permissionId, single(token, 0n, transferData(1n))),
      ).rejects.toThrow();
    });

    it("rejects V6 pay memo, metadata, redirected fixed arguments and shifted dynamic tails", async () => {
      const { permissionId } = await install();
      expect(
        await validate(permissionId, single(terminal, 10n, payData(10n))),
      ).toBe(expectedValidationData);
      for (const options of [
        { memo: "x" },
        { metadata: "0xab" as Hex },
        { projectId: 124n },
        { beneficiary: attacker },
        { asset: token },
        { minimum: 0n },
      ]) {
        await expect(
          validate(permissionId, single(terminal, 10n, payData(10n, options))),
        ).rejects.toThrow();
      }
      const canonical = payData(10n);
      const pointerOffset = 2 + 8 + 160 * 2;
      const shifted =
        `${canonical.slice(0, pointerOffset)}${toHex(256n, { size: 32 }).slice(2)}${canonical.slice(pointerOffset + 64)}` as Hex;
      await expect(
        validate(permissionId, single(terminal, 10n, shifted)),
      ).rejects.toThrow();
      await expect(
        validate(
          permissionId,
          single(terminal, 10n, canonical.slice(0, -64) as Hex),
        ),
      ).rejects.toThrow();
    });

    it("bounds cumulative actual native value even when pay amount is zero", async () => {
      const { permissionId } = await install();
      await expect(
        validate(permissionId, single(terminal, 61n, payData(0n))),
      ).rejects.toThrow();
      await write(smart, "validateUserOp", [
        await operation(permissionId, single(terminal, 60n, payData(0n))),
        operationHash,
      ]);
      expect(
        await validate(permissionId, single(terminal, 40n, payData(0n))),
      ).toBe(expectedValidationData);
      await expect(
        validate(permissionId, single(terminal, 41n, payData(0n))),
      ).rejects.toThrow();
    });

    it("rejects delegate, try, self, module administration and unmatched target or selector", async () => {
      const { permissionId } = await install();
      const admin = encodeFunctionData({
        abi: actionAbi,
        functionName: "installModule",
        args: [1n, attacker, "0x"],
      });
      for (const data of [
        single(token, 0n, transferData(1n), mode(255)),
        single(token, 0n, transferData(1n), mode(0, 1)),
        single(account, 0n, admin),
        admin,
        single(attacker, 0n, transferData(1n)),
        single(
          token,
          0n,
          encodeFunctionData({
            abi: actionAbi,
            functionName: "approve",
            args: [attacker, 100n],
          }),
        ),
        single(
          smart.address,
          0n,
          dataFor(smart, "removeSession", [permissionId]),
        ),
      ])
        await expect(validate(permissionId, data)).rejects.toThrow();
    });

    it("rejects foreign callers, wrong session signatures and unauthorized paymaster data", async () => {
      const { permissionId } = await install();
      await expect(
        validate(permissionId, undefined, undefined, attacker),
      ).rejects.toThrow();
      expect(
        await validate(permissionId, undefined, {
          signer: privateKeyToAccount(`0x${"44".repeat(32)}`),
        }),
      ).toBe(1n);
      await expect(
        validate(permissionId, undefined, { paymasterAndData: attacker }),
      ).rejects.toThrow();
    });

    it("shares action counters across batch entries and rejects empty or mixed unauthorized batches", async () => {
      const { permissionId } = await install();
      const entry = (amount: bigint, target: Address = token) => ({
        target,
        value: 0n,
        callData: transferData(amount),
      });
      expect(
        await validate(permissionId, batch([entry(60n), entry(40n)])),
      ).toBe(expectedValidationData);
      await expect(
        validate(permissionId, batch([entry(60n), entry(41n)])),
      ).rejects.toThrow();
      await expect(
        validate(permissionId, batch([entry(10n), entry(1n, attacker)])),
      ).rejects.toThrow();
      await expect(validate(permissionId, batch([]))).rejects.toThrow();
      await write(smart, "validateUserOp", [
        await operation(permissionId, batch([entry(60n), entry(40n)])),
        operationHash,
      ]);
      await expect(
        validate(permissionId, single(token, 0n, transferData(1n))),
      ).rejects.toThrow();
    });

    it("isolates outsider policy initialization from installed counters", async () => {
      const { permissionId } = await install();
      await write(smart, "validateUserOp", [
        await operation(permissionId, single(terminal, 60n, payData(0n))),
        operationHash,
      ]);
      const actionId = keccak256(
        encodePacked(
          ["address", "bytes4"],
          [terminal, payData(0n).slice(0, 10) as Hex],
        ),
      );
      const actionPolicyId = keccak256(concatHex([permissionId, actionId]));
      const configId = keccak256(
        encodePacked(["address", "bytes32"], [account, actionPolicyId]),
      );
      expect(
        await call(value, "getUsed", [configId, smart.address, account]),
      ).toBe(60n);
      await initialize(
        value,
        configId,
        encodeAbiParameters(parseAbiParameters("uint256"), [10_000n]),
        attacker,
      );
      expect(
        await call(value, "getUsed", [configId, smart.address, account]),
      ).toBe(60n);
      await expect(
        validate(permissionId, single(terminal, 41n, payData(0n))),
      ).rejects.toThrow();
    });

    it("removes the permission and advances the enable nonce while retaining owner isolation", async () => {
      const { data, permissionId } = await install();
      const nonceBefore = await call(smart, "getNonce", [
        permissionId,
        account,
      ]);
      const digestBefore = await call(smart, "getSessionDigest", [
        permissionId,
        account,
        data,
        2,
      ]);
      await write(smart, "revokeEnableSignature", [permissionId], attacker);
      expect(await call(smart, "getNonce", [permissionId, account])).toBe(
        nonceBefore,
      );
      await write(smart, "removeSession", [permissionId]);
      expect(
        await call(smart, "isPermissionEnabled", [permissionId, account]),
      ).toBe(false);
      // Removal alone does not invalidate previously signed enable material.
      expect(await call(smart, "getNonce", [permissionId, account])).toBe(
        nonceBefore,
      );
      expect(
        await call(smart, "getSessionDigest", [permissionId, account, data, 2]),
      ).toBe(digestBefore);
      await write(smart, "revokeEnableSignature", [permissionId]);
      expect(await call(smart, "getNonce", [permissionId, account])).toBe(
        (nonceBefore as bigint) + 1n,
      );
      expect(
        await call(smart, "getSessionDigest", [permissionId, account, data, 2]),
      ).not.toBe(digestBefore);
      await expect(validate(permissionId)).rejects.toThrow();
      const replacement = session(keccak256(toHex("generation two")));
      const replacementId = await call(smart, "getPermissionId", [replacement]);
      expect(replacementId).not.toBe(permissionId);
    });

    it("binds the installed-state reader's private mapping and UAP storage offsets to the actual legacy artifacts", async () => {
      const data = session();
      data.permitERC4337Paymaster = true;
      const { permissionId } = await install(data);
      const word = (value: bigint | Hex) => toHex(BigInt(value), { size: 32 });
      const mapping = (key: Hex, slot: Hex) =>
        keccak256(concatHex([word(key), word(slot)]));
      const read = async (contract: Address, slot: Hex) =>
        BigInt(await rpc<Hex>("eth_getStorageAt", [contract, slot, "latest"]));
      // $permitERC4337Paymaster[permissionId][account] is private slot 10
      // in the reviewed f24dddf storage layout, not a public getter.
      const permitSlot = mapping(account, mapping(permissionId, word(10n)));
      expect(await read(smart.address, permitSlot)).toBe(1n);
      await write(smart, "setPermit4337Paymaster", [permissionId, false]);
      expect(await read(smart.address, permitSlot)).toBe(0n);
      const actionId = keccak256(
        encodePacked(
          ["address", "bytes4"],
          [token, transferData(1n).slice(0, 10) as Hex],
        ),
      );
      const configId = keccak256(
        encodePacked(
          ["address", "bytes32"],
          [account, keccak256(concatHex([permissionId, actionId]))],
        ),
      );
      // UAP actionConfigs[id][multiplexer][account] starts at mapping slot 0.
      const base = mapping(
        account,
        mapping(smart.address, mapping(configId, word(0n))),
      );
      const decoded = decodeUniversalAction(
        data.actions[0]!.actionPolicies[0]!.initData,
      );
      const expected = [
        BigInt(decoded.valueLimitPerUse),
        BigInt(decoded.paramRules.length),
      ];
      for (const rule of decoded.paramRules.rules)
        expected.push(
          BigInt(rule.condition) |
            (BigInt(rule.offset) << 8n) |
            (BigInt(rule.isLimited ? 1 : 0) << 72n),
          BigInt(rule.ref),
          BigInt(rule.usage.limit),
          BigInt(rule.usage.used),
        );
      const observed = await Promise.all(
        expected.map((_value, index) =>
          read(universal.address, word(BigInt(base) + BigInt(index))),
        ),
      );
      expect(observed).toEqual(expected);
      await write(smart, "validateUserOp", [
        await operation(permissionId, single(token, 0n, transferData(60n))),
        operationHash,
      ]);
      // Two header slots; second rule; fourth slot in ParamRule is usage.used.
      expect(
        await read(universal.address, word(BigInt(base) + 2n + 4n + 3n)),
      ).toBe(60n);
    });

    it("executes compiler-produced session bytes with mandatory sponsorship and bounded gas/call counters", async () => {
      const pin = (contract: Artifact): ContractPin => {
        const source = contract.source as {
          repository?: string;
          repo?: string;
          commit?: string;
          artifactSha256?: string;
          compilerArtifactSha256?: string;
        };
        return {
          address: contract.address,
          runtimeCodeHash: contract.runtimeCodeHash,
          source: {
            repository:
              source.repository ??
              source.repo ??
              "juicebox-center-local-uncommitted-source",
            commit: source.commit ?? "0".repeat(40),
            artifactSha256:
              source.artifactSha256 ?? source.compilerArtifactSha256!,
          },
        };
      };
      // A real policy runtime supplies the code identity here. The guard only
      // checks that identity; this does not claim this contract is a paymaster or
      // that EntryPoint sponsorship succeeded.
      const sponsor = value;
      const policy = {
        schemaVersion: 1,
        ownerAccountId: `eip155:1:${account}`,
        bindingId: zeroHash,
        grantId: "local-evm-grant",
        sessionKey: bot.address,
        chainId: 31337,
        wallet: account,
        generation: "1",
        nonce: keccak256(toHex("compiler fixture nonce")),
        validAfter,
        validUntil,
        maximumCalls: "2",
        salt: keccak256(toHex("compiler fixture generation")),
        restrictToActions: true,
        signing: { mode: "disabled" },
        crossChainPermits: false,
        claimPolicies: false,
        wildcardFallback: false,
        allocations: [],
        gasBudget: {
          paymaster: sponsor.address,
          paymasterCodeHash: sponsor.runtimeCodeHash,
          paymasterReviewId: "local-code-identity-only",
          maxGasPerOperation: "1000",
          maxFeePerGas: "2",
          maxPriorityFeePerGas: "1",
          totalGasLimit: "2000",
          totalSponsoredCostLimit: "4000",
          maxPaymasterDataLength: 130,
        },
        actions: [
          {
            kind: "erc20-transfer",
            target: token,
            selector: transferData(1n).slice(0, 10),
            asset: token,
            beneficiary: recipient,
            perCallLimit: "60",
            totalLimit: "100",
          },
          {
            kind: "v6-pay",
            target: terminal,
            selector: payData(1n).slice(0, 10),
            asset: native,
            projectId: "123",
            beneficiary: recipient,
            minReturnedTokens: "7",
            perCallLimit: "60",
            totalLimit: "100",
          },
        ],
      };
      const review = {
        policy,
        policyHash: fingerprint(policy),
        manifestRevision: zeroHash,
      } as unknown as SessionReview;
      const compiled = createLegacySessionCompiler({
        stack: {
          smartSessions: pin(smart),
          sessionValidator: pin(ownable),
          timeFrame: pin(time),
          universalAction: pin(universal),
          valueLimit: pin(value),
          sessionGuard: pin(guard),
        },
      }).compile({ review, activationEnableNonce: "0" });
      const { permissionId } = await install(compiled.session);
      expect(permissionId).toBe(compiled.permissionId);
      const verifier = createInstalledSessionVerifier({
        rpc: {
          request: async (chainId, method, params) => {
            expect(chainId).toBe(31337);
            return rpc(method, [...params]);
          },
        },
        findCompiled: async () => compiled,
      });
      const initialObservation = await verifier.verify(compiled);
      expect(initialObservation.enabled).toBe(true);
      expect(
        initialObservation.counters.every((counter) => counter.used === "0"),
      ).toBe(true);
      const sponsored = await operation(
        permissionId,
        single(terminal, 10n, payData(10n)),
      );
      sponsored.accountGasLimits = encodePacked(
        ["uint128", "uint128"],
        [100n, 100n],
      );
      sponsored.preVerificationGas = 50n;
      sponsored.gasFees = encodePacked(["uint128", "uint128"], [1n, 2n]);
      sponsored.paymasterAndData = concatHex([
        encodePacked(
          ["address", "uint128", "uint128"],
          [sponsor.address, 100n, 100n],
        ),
        `0x${"00".repeat(78)}`,
      ]);
      const checked = (overrides: Partial<typeof sponsored> = {}) =>
        call(smart, "validateUserOp", [
          { ...sponsored, ...overrides },
          operationHash,
        ]);
      expect(await checked()).toBe(expectedValidationData);
      for (const overrides of [
        { paymasterAndData: "0x" as Hex },
        {
          paymasterAndData: encodePacked(
            ["address", "uint128", "uint128"],
            [attacker, 100n, 100n],
          ),
        },
        {
          accountGasLimits: encodePacked(["uint128", "uint128"], [1000n, 100n]),
        },
        { preVerificationGas: 1001n },
        { gasFees: encodePacked(["uint128", "uint128"], [1n, 3n]) },
        {
          callData: batch([
            { target: token, value: 0n, callData: transferData(1n) },
          ]),
        },
        { callData: single(token, 0n, transferData(1n), mode(0, 1)) },
        { callData: single(terminal, 10n, payData(10n, { memo: "x" })) },
        { callData: single(terminal, 61n, payData(0n)) },
      ])
        await expect(checked(overrides)).rejects.toThrow();
      await write(smart, "validateUserOp", [sponsored, operationHash]);
      await write(smart, "validateUserOp", [sponsored, operationHash]);
      const configuration = compiled.configurations.find(
        (c) => c.kind === "gas-budget",
      )!;
      const stored = (await call(guard, "getConfig", [
        configuration.configId,
        smart.address,
        account,
      ])) as readonly unknown[];
      expect(stored.slice(1)).toEqual([900n, 1800n, 2n]);
      const usedObservation = await verifier.verify(compiled);
      expect(usedObservation.configurationHash).toBe(
        initialObservation.configurationHash,
      );
      expect(
        usedObservation.counters.find((counter) => counter.name === "calls")
          ?.used,
      ).toBe("2");
      expect(
        usedObservation.counters.find(
          (counter) => counter.name === "nativeValue",
        )?.used,
      ).toBe("20");
      await expect(checked()).rejects.toThrow();
      await write(smart, "setPermit4337Paymaster", [permissionId, false]);
      await expect(verifier.verify(compiled)).rejects.toMatchObject({
        code: "SMART_INSTALLED_POLICY_MISMATCH",
      });
      await write(smart, "setPermit4337Paymaster", [permissionId, true]);
      const nativeConfig = compiled.configurations.find(
        (config) => config.kind === "value-limit",
      )!;
      await rpc("anvil_impersonateAccount", [smart.address]);
      await rpc("anvil_setBalance", [smart.address, "0x1000000000000000000"]);
      await initialize(
        value,
        nativeConfig.configId,
        encodeAbiParameters([{ type: "uint256" }], [1000n]),
        smart.address,
      );
      await expect(verifier.verify(compiled)).rejects.toMatchObject({
        code: "SMART_INSTALLED_POLICY_MISMATCH",
      });
      await write(smart, "removeSession", [permissionId]);
      await expect(verifier.verifyRevoked(compiled, "1")).rejects.toMatchObject(
        { code: "SMART_INSTALLED_POLICY_MISMATCH" },
      );
      await write(smart, "revokeEnableSignature", [permissionId]);
      expect(await verifier.verifyRevoked(compiled, "1")).toMatchObject({
        enabled: false,
        enableNonce: "1",
        counters: [],
      });
      await install(session(keccak256(toHex("replacement generation"))));
      expect(await verifier.verifyRevoked(compiled, "1")).toMatchObject({
        enabled: false,
        enableNonce: "1",
      });
    });
  },
);
