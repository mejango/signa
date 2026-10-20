import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRY_POINT_V07_ABI } from "../src/rest/userOperations/chain.js";
import {
  getUserOperationHash,
  packUserOperation,
  userOperationMaximumCost,
} from "../src/rest/userOperations/codec.js";
import {
  createPimlicoV7PaymasterPolicy,
  PIMLICO_LEGACY_V7_PAYMASTER,
} from "../src/rest/userOperations/provider.js";
import type { UserOperationV07 } from "../src/rest/userOperations/types.js";
import {
  createSessionGasEstimation,
  sessionGasEstimationOverrides,
} from "../src/rest/userOperations/estimation.js";
import { SESSION_GUARD_INIT_ABI } from "../src/rest/smartAccounts/compiler.js";
import { encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import { sessionFixture, sessionObservation } from "./fixtures/sessions.js";

const available = anvilAvailable();
const artifact = JSON.parse(
  readFileSync(
    new URL(
      "../src/rest/smartAccounts/stack/artifacts/EntryPoint.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { address: Address; deployedRuntimeBytecode: Hex; runtimeCodeHash: Hex };
const paymasterArtifact = JSON.parse(
  readFileSync(
    new URL(
      "../src/rest/smartAccounts/stack/artifacts/PimlicoSingletonPaymasterV7.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  address: Address;
  abi: Abi;
  deployedRuntimeBytecode: Hex;
  runtimeCodeHash: Hex;
};
let child: ChildProcess | undefined;
let endpoint = "";
let nextId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const result = (await response.json()) as {
    result: T;
    error?: { message: string };
  };
  if (result.error) throw new Error(result.error.message);
  return result.result;
}
describe.skipIf(!available)(
  "actual pinned EntryPoint0.7 runtime in disposable local EVM",
  () => {
    beforeAll(async () => {
      const server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      endpoint = `http://127.0.0.1:${port}`;
      child = spawnAnvil(
        [
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--chain-id",
          "31337",
          "--silent",
        ],
      );
      for (let attempt = 0; ; attempt++) {
        try {
          await rpc("eth_chainId", []);
          break;
        } catch {
          if (attempt > 100) throw new Error("Local EVM did not start");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(keccak256(artifact.deployedRuntimeBytecode)).toBe(
        artifact.runtimeCodeHash,
      );
      await rpc("anvil_setCode", [
        artifact.address,
        artifact.deployedRuntimeBytecode,
      ]);
      expect(keccak256(paymasterArtifact.deployedRuntimeBytecode)).toBe(
        PIMLICO_LEGACY_V7_PAYMASTER.runtimeCodeHash,
      );
      expect(paymasterArtifact.address.toLowerCase()).toBe(
        PIMLICO_LEGACY_V7_PAYMASTER.address,
      );
      await rpc("anvil_setCode", [
        paymasterArtifact.address,
        paymasterArtifact.deployedRuntimeBytecode,
      ]);
    }, 15_000);
    afterAll(async () => {
      if (child && child.exitCode === null) {
        const stopped = new Promise<void>((resolve) =>
          child!.once("exit", () => resolve()),
        );
        child.kill("SIGTERM");
        await stopped;
      }
    });
    it.each([false, true])(
      "matches deployed getUserOpHash with factory/paymaster=%s",
      async (extras) => {
        const operation: UserOperationV07 = {
          sender: "0x1111111111111111111111111111111111111111",
          nonce: toHex((1n << 192n) + 123n),
          callData: "0xabcdef",
          callGasLimit: "0x123456",
          verificationGasLimit: "0x234567",
          preVerificationGas: "0x345678",
          maxFeePerGas: "0x123",
          maxPriorityFeePerGas: "0x12",
          signature: "0x123456",
        };
        if (extras)
          Object.assign(operation, {
            factory: "0x2222222222222222222222222222222222222222",
            factoryData: "0x112233",
            paymaster: "0x3333333333333333333333333333333333333333",
            paymasterData: "0x445566",
            paymasterVerificationGasLimit: "0x1234",
            paymasterPostOpGasLimit: "0x5678",
          });
        const data = encodeFunctionData({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getUserOpHash",
          args: [packUserOperation(operation)],
        });
        const result = await rpc<Hex>("eth_call", [
          { to: artifact.address, data },
          "latest",
        ]);
        const expected = decodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getUserOpHash",
          data: result,
        });
        expect(getUserOperationHash(operation, artifact.address, 31337)).toBe(
          expected,
        );
        expect(
          getUserOperationHash(
            { ...operation, signature: "0xaabb" },
            artifact.address,
            31337,
          ),
        ).toBe(expected);
      },
    );
    it("reads the actual EntryPoint keyed sequence and isolates another nonce lane", async () => {
      const [sender] = await rpc<Address[]>("eth_accounts", []);
      const key = 0x1234567890n;
      const read = async (nonceKey: bigint) => {
        const data = encodeFunctionData({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getNonce",
          args: [sender!, nonceKey],
        });
        return decodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "getNonce",
          data: await rpc<Hex>("eth_call", [
            { to: artifact.address, data },
            "latest",
          ]),
        });
      };
      expect(await read(key)).toBe(key << 64n);
      const data = encodeFunctionData({
        abi: parseAbi(["function incrementNonce(uint192 key)"]),
        functionName: "incrementNonce",
        args: [key],
      });
      // This transaction exists only on the isolated loopback Anvil process.
      const hash = await rpc<Hex>("eth_sendTransaction", [
        { from: sender, to: artifact.address, data },
      ]);
      await expect.poll(async () =>
        (await rpc<{ status: Hex } | null>("eth_getTransactionReceipt", [hash]))?.status).toBe("0x1");
      expect(await read(key)).toBe((key << 64n) + 1n);
      expect(await read(key + 1n)).toBe((key + 1n) << 64n);
    });
    it("authenticates exact sponsorship with the deployed Pimlico runtime and rejects changed calls or revoked signers", async () => {
      // This fixture key and signer storage exist only in the disposable local EVM.
      const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
      const signerSlot = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          [signer.address, 1n],
        ),
      );
      await rpc("anvil_setStorageAt", [
        paymasterArtifact.address,
        signerSlot,
        toHex(1n, { size: 32 }),
      ]);
      const block = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", [
        "latest",
        false,
      ]);
      const until = BigInt(block.timestamp) + 600n;
      const after = BigInt(block.timestamp) - 1n;
      const prefix =
        `0x00${toHex(until, { size: 6 }).slice(2)}${toHex(after, { size: 6 }).slice(2)}` as Hex;
      const operation: UserOperationV07 = {
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x0",
        callData: "0xabcdef",
        callGasLimit: "0x186a0",
        verificationGasLimit: "0x186a0",
        preVerificationGas: "0x186a0",
        maxFeePerGas: "0x10",
        maxPriorityFeePerGas: "0x1",
        signature: "0x1234",
        paymaster: paymasterArtifact.address,
        paymasterData: `${prefix}${"00".repeat(65)}`,
        paymasterVerificationGasLimit: "0x493e0",
        paymasterPostOpGasLimit: "0x0",
      };
      const hashResult = await rpc<Hex>("eth_call", [
        {
          to: paymasterArtifact.address,
          data: encodeFunctionData({
            abi: paymasterArtifact.abi,
            functionName: "getHash",
            args: [0, packUserOperation(operation)],
          }),
        },
        "latest",
      ]);
      const sponsorHash = decodeFunctionResult({
        abi: paymasterArtifact.abi,
        functionName: "getHash",
        data: hashResult,
      }) as Hex;
      operation.paymasterData = `${prefix}${(await signer.signMessage({ message: { raw: sponsorHash } })).slice(2)}`;
      const policy = createPimlicoV7PaymasterPolicy({
        chainId: 31337,
        policyId: "local-fixture",
      });
      expect(policy.inspect(operation, "final")).toMatchObject({
        gasOnly: true,
        validAfter: Number(after),
        validUntil: Number(until),
      });
      const validate = async (
        op: UserOperationV07,
        from = artifact.address,
      ) => {
        const result = await rpc<Hex>("eth_call", [
          {
            from,
            to: paymasterArtifact.address,
            data: encodeFunctionData({
              abi: ENTRY_POINT_V07_ABI,
              functionName: "validatePaymasterUserOp",
              args: [
                packUserOperation(op),
                getUserOperationHash(op, artifact.address, 31337),
                userOperationMaximumCost(op),
              ],
            }),
          },
          "latest",
        ]);
        return decodeFunctionResult({
          abi: ENTRY_POINT_V07_ABI,
          functionName: "validatePaymasterUserOp",
          data: result,
        });
      };
      const [context, validation] = await validate(operation);
      expect(context).toBe("0x");
      expect(validation & ((1n << 160n) - 1n)).toBe(0n);
      expect((validation >> 160n) & ((1n << 48n) - 1n)).toBe(until);
      expect(validation >> 208n).toBe(after);
      expect(
        (await validate({ ...operation, callData: "0xabcdef01" }))[1] &
          ((1n << 160n) - 1n),
      ).toBe(1n);
      await expect(validate(operation, signer.address)).rejects.toThrow();
      await rpc("anvil_setStorageAt", [
        paymasterArtifact.address,
        signerSlot,
        toHex(0n, { size: 32 }),
      ]);
      expect((await validate(operation))[1] & ((1n << 160n) - 1n)).toBe(1n);
    });
    it("limits estimation overrides to compiler-proven ceilings, preserving counters and real authority", async () => {
      const guardArtifact = JSON.parse(
        readFileSync(
          new URL(
            "../src/rest/smartAccounts/stack/artifacts/CenterSessionGuard.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as { abi: Abi; deployedBytecode: Hex };
      const { record } = sessionFixture();
      const compiled = record.compiled;
      compiled.chainId = 31337;
      const guard = compiled.configurations.find(
        (c) => c.kind === "gas-budget",
      )!;
      guard.initData = encodeAbiParameters(SESSION_GUARD_INIT_ABI, [
        paymasterArtifact.address,
        paymasterArtifact.runtimeCodeHash,
        1000n,
        2n,
        1n,
        100000n,
        200000n,
        100n,
        130,
      ]);
      await rpc("anvil_setCode", [
        guard.policy.address,
        guardArtifact.deployedBytecode,
      ]);
      await rpc("anvil_impersonateAccount", [compiled.smartSessions.address]);
      await rpc("anvil_setBalance", [
        compiled.smartSessions.address,
        toHex(10n ** 18n),
      ]);
      await rpc("eth_sendTransaction", [
        {
          from: compiled.smartSessions.address,
          to: guard.policy.address,
          data: encodeFunctionData({
            abi: guardArtifact.abi,
            functionName: "initializeWithMultiplexer",
            args: [compiled.wallet, guard.configId, guard.initData],
          }),
        },
      ]);
      const op: UserOperationV07 = {
        sender: compiled.wallet,
        nonce: "0x0",
        callData: encodeSafe7579Execution([
          { target: artifact.address, value: "0", callData: "0x12345678" },
        ]),
        callGasLimit: "0x64",
        verificationGasLimit: "0x64",
        preVerificationGas: "0x64",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
        signature: "0x1234",
        paymaster: paymasterArtifact.address,
        paymasterData: `0x${"00".repeat(78)}`,
        paymasterVerificationGasLimit: "0x64",
        paymasterPostOpGasLimit: "0x0",
      };
      const checkData = (operation: UserOperationV07) =>
        encodeFunctionData({
          abi: guardArtifact.abi,
          functionName: "checkUserOpPolicy",
          args: [guard.configId, packUserOperation(operation)],
        });
      await rpc("eth_sendTransaction", [
        {
          from: compiled.smartSessions.address,
          to: guard.policy.address,
          data: checkData(op),
        },
      ]);
      const readConfig = async (override?: unknown) =>
        decodeFunctionResult({
          abi: guardArtifact.abi,
          functionName: "getConfig",
          data: await rpc<Hex>("eth_call", [
            {
              to: guard.policy.address,
              data: encodeFunctionData({
                abi: guardArtifact.abi,
                functionName: "getConfig",
                args: [
                  guard.configId,
                  compiled.smartSessions.address,
                  compiled.wallet,
                ],
              }),
            },
            "latest",
            ...(override ? [override] : []),
          ]),
        }) as [Record<string, bigint | Address>, bigint, bigint, bigint];
      const before = await readConfig();
      expect(before.slice(1)).toEqual([400n, 400n, 1n]);
      record.observation = sessionObservation(record, Date.now(), {
        counters: [
          {
            policy: guard.policy.address,
            configId: guard.configId,
            name: "requestedGas",
            used: "400",
            limit: "100000",
          },
          {
            policy: guard.policy.address,
            configId: guard.configId,
            name: "sponsoredCost",
            used: "400",
            limit: "200000",
          },
          {
            policy: guard.policy.address,
            configId: guard.configId,
            name: "calls",
            used: "1",
            limit: "100",
          },
        ],
      });
      const policy = {
        id: "fixture",
        maximumCallGas: 1000000n,
        maximumVerificationGas: 1000000n,
        maximumPreVerificationGas: 1000000n,
        maximumPaymasterVerificationGas: 1000000n,
        maximumPaymasterPostOpGas: 1000000n,
        maximumFeePerGas: 2n,
        maximumPriorityFeePerGas: 1n,
        maximumCost: 1000000n,
        requirePaymaster: true,
      };
      const context = await createSessionGasEstimation(record, policy, op);
      const override = sessionGasEstimationOverrides(context, 31337, op);
      expect(Object.keys(override)).toEqual([guard.policy.address]);
      expect(
        Object.keys(override[guard.policy.address]!.stateDiff),
      ).toHaveLength(5);
      const temporary = await readConfig(override);
      expect(temporary.slice(1)).toEqual(before.slice(1));
      for (const field of [
        "paymaster",
        "paymasterCodeHash",
        "maximumCalls",
        "maxPaymasterDataLength",
      ])
        expect(temporary[0][field]).toEqual(before[0][field]);
      expect(temporary[0].maxGasPerOperation).toBe((1n << 128n) - 1n);
      const inflated = { ...op, callGasLimit: "0x186a0" as Hex };
      const inspect = async (overrides?: unknown) =>
        decodeFunctionResult({
          abi: guardArtifact.abi,
          functionName: "checkUserOpPolicy",
          data: await rpc<Hex>("eth_call", [
            {
              from: compiled.smartSessions.address,
              to: guard.policy.address,
              data: checkData(inflated),
            },
            "latest",
            ...(overrides ? [overrides] : []),
          ]),
        });
      expect(await inspect()).toBe(1n);
      expect(await inspect(override)).toBe(0n);
      expect(() => context.assert(inflated)).toThrow("original owner-approved");
      expect(await readConfig()).toEqual(before);
      expect(await inspect()).toBe(1n);
      await rpc("anvil_stopImpersonatingAccount", [
        compiled.smartSessions.address,
      ]);
    });
  },
);
