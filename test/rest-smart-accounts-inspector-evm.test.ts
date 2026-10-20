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
  getAddress,
  keccak256,
  padHex,
  parseAbi,
  toHex,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  createSafe7579Inspector,
  SAFE7579_INSPECTOR_ID,
  SAFE7579_SESSION_STATEFUL_SELECTORS,
  SAFE7579_STORAGE_SOURCE,
  safe7579FallbackSlot,
  safe7579MappingSlot,
} from "../src/rest/smartAccounts/inspector.js";
import {
  prepareSafe7579Creation,
  SAFE_141_PROXY_CREATION_CODE,
  verifySafe7579CreationCall,
} from "../src/rest/smartAccounts/creation.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import {
  createLegacySessionCompiler,
  type SessionReview,
} from "../src/rest/smartAccounts/compiler.js";
import { fingerprint } from "../src/rest/smartAccounts/service.js";
import { LEGACY_SESSION_PARAMETERS } from "../src/rest/smartAccounts/setup.js";
import { MemorySafe7579CheckpointStore } from "../src/rest/smartAccounts/checkpoints.js";
import type {
  ContractPin,
  SmartAccountManifest,
  SmartSnapshot,
} from "../src/rest/smartAccounts/types.js";
import {
  safe7579OwnerSigningPayload,
  encodeSafe7579OwnerSignature,
  encodeSafe7579Execution,
} from "../src/rest/smartAccounts/accountExecution.js";
import { packUserOperation } from "../src/rest/userOperations/codec.js";
import { RestError } from "../src/rest/core.js";
import { privateKeyToAccount } from "viem/accounts";

type Artifact = {
  address: Address;
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  deployedRuntimeBytecode?: Hex;
  runtimeCodeHash: Hex;
  source: { repo: string; commit: string; artifactSha256: string };
};
const artifact = (name: string): Artifact =>
  JSON.parse(
    readFileSync(
      new URL(
        `../src/rest/smartAccounts/stack/artifacts/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const safe = artifact("SafeL2"),
  factory = artifact("SafeProxyFactory"),
  proxy = artifact("SafeProxy"),
  adapter = artifact("Safe7579"),
  utility = artifact("Safe7579DCUtil"),
  launchpad = artifact("Safe7579Launchpad"),
  sessions = artifact("SmartSession"),
  entry = artifact("EntryPoint"),
  senderCreator = artifact("SenderCreator"),
  ownable = artifact("OwnableValidator");
const pin = (a: Artifact): ContractPin => ({
  address: a.address,
  runtimeCodeHash: a.runtimeCodeHash,
  source: {
    repository: a.source.repo,
    commit: a.source.commit,
    artifactSha256: a.source.artifactSha256,
  },
});
const manifest: SmartAccountManifest = {
  id: "local-pinned-safe",
  mode: "execution-candidate",
  chainId: 31337,
  revision: keccak256(toHex("local-pinned-safe")),
  safeVersion: "1.4.1",
  proxyRuntimeCodeHash: proxy.runtimeCodeHash,
  singleton: pin(safe),
  factory: pin(factory),
  safe7579: pin(adapter),
  launchpad: pin(launchpad),
  entryPoint: { ...pin(entry), version: "0.7" },
  smartSessions: { ...pin(sessions), generation: "legacy-validator" },
  policies: [],
  moduleInspectorId: SAFE7579_INSPECTOR_ID,
};
const available = anvilAvailable();
const attack = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/smartAccounts/InspectorAttackModule.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { abi: Abi; bytecode: Hex; deployedBytecode: Hex };
const moduleAbi = parseAbi([
  "function installModule(uint256 moduleType,address module,bytes initData)",
  "function uninstallModule(uint256 moduleType,address module,bytes initData)",
  "function getFallbackHandlerBySelector(bytes4 selector) view returns(bytes1 calltype,address handler)",
  "function setRegistry(address registry,address[] attesters,uint8 threshold)",
]);
const ownAbi = parseAbi([
  "function swapOwner(address previous,address oldOwner,address newOwner)",
  "function changeThreshold(uint256 threshold)",
]);
const sentinel = "0x0000000000000000000000000000000000000001" as const;

it("covers every stateful entry in the pinned SmartSession artifact", () => {
  const stateful = sessions.abi
    .filter(
      (item) =>
        item.type === "function" &&
        !["view", "pure"].includes(item.stateMutability),
    )
    .map((item) =>
      toFunctionSelector(item as Extract<Abi[number], { type: "function" }>),
    );
  expect([...SAFE7579_SESSION_STATEFUL_SELECTORS].sort()).toEqual(
    stateful.sort(),
  );
});
it("uses storage slots reproduced by the exact pinned Solidity compiler input", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/smartAccounts/Safe7579.storage-layout.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    verificationInputSha256: string;
    compiler: string;
    storageLayout: {
      storage: { label: string; slot: string; offset: number }[];
      types: Record<
        string,
        {
          label: string;
          members?: { label: string; slot: string; offset: number }[];
        }
      >;
    };
  };
  expect(fixture.verificationInputSha256).toBe(
    SAFE7579_STORAGE_SOURCE.verificationInputSha256,
  );
  expect(fixture.compiler).toBe(SAFE7579_STORAGE_SOURCE.compiler);
  const labels = [
    "$registry",
    "$nonces",
    "$validators",
    "$executors",
    "$fallbackStorage",
    "$globalHook",
    "$emergencyUninstallTime",
    "$preValidationHook4337",
    "$preValidationHook1271",
  ];
  expect(
    fixture.storageLayout.storage.map((item) => ({
      label: item.label,
      slot: Number(item.slot),
      offset: item.offset,
    })),
  ).toEqual(labels.map((label, slot) => ({ label, slot, offset: 0 })));
  expect(Object.values(SAFE7579_STORAGE_SOURCE.slots)).toEqual(
    labels.map((_, slot) => slot),
  );
  const fallback = Object.values(fixture.storageLayout.types).find(
    (type) => type.label === "struct FallbackHandler",
  );
  expect(
    fallback?.members?.map((member) => ({
      label: member.label,
      slot: member.slot,
      offset: member.offset,
    })),
  ).toEqual([
    { label: "handler", slot: "0", offset: 0 },
    { label: "calltype", slot: "0", offset: 20 },
  ]);
});

it("accepts only canonical creation input and rejects hidden trailing calls or another predicted wallet", () => {
  const owner = "0x1111111111111111111111111111111111111111" as const;
  const prepared = prepareSafe7579Creation({
    manifest,
    owners: [owner],
    threshold: 1,
    saltNonce: "42",
  });
  expect(
    verifySafe7579CreationCall(
      manifest,
      prepared.address,
      prepared.transaction.data,
    ).address,
  ).toBe(prepared.address);
  expect(() =>
    verifySafe7579CreationCall(
      manifest,
      prepared.address,
      concatHex([prepared.transaction.data, "0x00"]),
    ),
  ).toThrowError(
    expect.objectContaining({ code: "SMART_CREATION_UNSUPPORTED" }),
  );
  expect(() =>
    verifySafe7579CreationCall(manifest, owner, prepared.transaction.data),
  ).toThrowError(
    expect.objectContaining({ code: "SMART_CREATION_UNSUPPORTED" }),
  );
});
it.each([
  { owners: [] },
  { owners: [zeroAddress] },
  { owners: new Array<Address>(1) },
  { owners: [sentinel] },
  { threshold: 0 },
  { threshold: 2 },
  { saltNonce: "01" },
  { saltNonce: String(1n << 256n) },
])("rejects unsupported owner configuration or salt: %j", (change) => {
  expect(() =>
    prepareSafe7579Creation({
      manifest,
      owners: ["0x1111111111111111111111111111111111111111"],
      threshold: 1,
      saltNonce: "42",
      ...change,
    }),
  ).toThrowError(
    expect.objectContaining({ code: "SMART_CREATION_UNSUPPORTED" }),
  );
});

describe.skipIf(!available)(
  "source-pinned Safe7579 creation and exhaustive inspector in local EVM",
  () => {
    let child: ChildProcess | undefined,
      endpoint: string,
      owner: Address,
      otherOwner: Address,
      account: Address,
      attackAddress: Address,
      baseline: Hex,
      creationHash: Hex;
    let requestId = 0;
    async function rpc<T = unknown>(
      method: string,
      params: readonly unknown[] = [],
    ): Promise<T> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++requestId,
          method,
          params,
        }),
      });
      const result = (await response.json()) as {
        result: T;
        error?: { message: string };
      };
      if (result.error) throw new Error(`${method}: ${result.error.message}`);
      return result.result;
    }
    const transport = {
      request: (_chain: number, method: string, params: readonly unknown[]) =>
        rpc(method, params),
    };
    async function snapshot(): Promise<SmartSnapshot> {
      const block = await rpc<{ hash: Hex; number: Hex; timestamp: Hex }>(
        "eth_getBlockByNumber",
        ["latest", false],
      );
      const tag = { blockHash: block.hash, requireCanonical: true as const };
      return {
        evidence: {
          chainId: 31337,
          blockNumber: String(BigInt(block.number)),
          timestamp: String(BigInt(block.timestamp)),
          blockHash: block.hash,
          source: "onchain",
        },
        tag,
        request: (method, params) => rpc(method, [...params, tag]),
      };
    }
    function inspector(rpcOverride = transport) {
      return createSafe7579Inspector({
        rpc: rpcOverride,
        utility: pin(utility),
        inspectSessions: createInstalledSessionVerifier({ rpc: rpcOverride })
          .inspectAllAt,
      });
    }
    async function inspect(subject = inspector()) {
      return subject.inspect({ account, manifest, snapshot: await snapshot() });
    }
    async function send(to: Address | undefined, data: Hex, from = owner) {
      const hash = await rpc<Hex>("eth_sendTransaction", [
        { from, ...(to ? { to } : {}), data, gas: "0xf42400" },
      ]);
      type Receipt = {
        status: Hex;
        contractAddress: Address | null;
        blockNumber: Hex;
      };
      let receipt: Receipt | null = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [
          hash,
        ]);
        if (receipt) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!receipt)
        throw new Error("The local fixture transaction was not mined.");
      expect(receipt.status).toBe("0x1");
      return { ...receipt, hash };
    }
    async function ownerCall(
      to: Address,
      data: Hex,
      operation = 0,
      from = owner,
    ) {
      const signatures = concatHex([
        padHex(from, { size: 32 }),
        zeroHash,
        "0x01",
      ]);
      const call = encodeFunctionData({
        abi: safe.abi,
        functionName: "execTransaction",
        args: [
          to,
          0n,
          data,
          operation,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          signatures,
        ],
      });
      const result = await rpc<Hex>("eth_call", [
        { from, to: account, data: call },
        "latest",
      ]);
      expect(
        decodeFunctionResult({
          abi: safe.abi,
          functionName: "execTransaction",
          data: result,
        }),
      ).toBe(true);
      return send(account, call, from);
    }
    async function install(type: bigint, module: Address, initData: Hex) {
      return ownerCall(
        account,
        encodeFunctionData({
          abi: moduleAbi,
          functionName: "installModule",
          args: [type, module, initData],
        }),
      );
    }
    beforeAll(async () => {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      endpoint = `http://127.0.0.1:${port}`;
      child = spawnAnvil(
        [
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--chain-id",
          "31337",
          // Match the pinned stack's execution target; Anvil's moving latest default changes mining work.
          "--hardfork",
          "cancun",
          "--silent",
        ],
        // Retain enough archive state for the fixtures.
        { stdio: ["ignore", "ignore", "pipe"], history: 512 },
      );
      for (let i = 0; i < 100; i++) {
        try {
          await rpc("eth_chainId");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      [owner, otherOwner] = await rpc<[Address, Address]>("eth_accounts");
      // Exact verified runtimes are placed at their canonical dependency addresses. All subsequent
      // creation, owner transactions, module installs and reads execute their actual contract code.
      for (const a of [
        safe,
        factory,
        adapter,
        utility,
        launchpad,
        sessions,
        entry,
        senderCreator,
        ownable,
      ]) {
        const runtime = a.deployedRuntimeBytecode ?? a.deployedBytecode;
        expect(keccak256(runtime)).toBe(a.runtimeCodeHash);
        await rpc("anvil_setCode", [a.address, runtime]);
      }
      expect(SAFE_141_PROXY_CREATION_CODE).toBe(proxy.bytecode);
      const prepared = prepareSafe7579Creation({
        manifest,
        owners: [owner],
        threshold: 1,
        saltNonce: "4242",
      });
      account = prepared.address;
      const created = await send(
        prepared.transaction.to,
        prepared.transaction.data,
      );
      expect(await rpc("eth_getCode", [account, "latest"])).toBe(
        proxy.deployedBytecode,
      );
      expect(
        verifySafe7579CreationCall(manifest, account, prepared.transaction.data)
          .initializerHash,
      ).toBe(prepared.initializerHash);
      expect(created.blockNumber).toBe("0x1");
      creationHash = created.hash;
      const deployed = await send(undefined, attack.bytecode);
      attackAddress = deployed.contractAddress!;
      baseline = await rpc<Hex>("evm_snapshot");
    }, 30000);
    beforeEach(async () => {
      expect(await rpc("evm_revert", [baseline])).toBe(true);
      baseline = await rpc<Hex>("evm_snapshot");
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

    it("atomically deploys the predicted Safe and proves exact empty-validator authority, nonce and complete traces", async () => {
      const proof = await inspect();
      expect(proof.complete).toBe(true);
      expect(proof.details).toMatchObject({
        validators: [sessions.address.toLowerCase()],
        executors: [],
        fallbacks: [],
        registry: { enforcement: "disabled-in-source", attesters: [] },
        sessions: { permissionIds: [] },
        nonce: { validator: sessions.address, lane: "0", sequence: "0" },
      });
    });
    it("uses an incremental canonical checkpoint without changing the configuration digest for unrelated transactions", async () => {
      const subject = inspector();
      const before = await inspect(subject);
      await send(otherOwner, "0x");
      expect((await inspect(subject)).stateHash).toBe(before.stateHash);
    });
    it("executes setRegistry and proves that this revision leaves registry and attesters inert", async () => {
      const before = await inspect();
      await ownerCall(
        account,
        encodeFunctionData({
          abi: moduleAbi,
          functionName: "setRegistry",
          args: [attackAddress, [otherOwner], 1],
        }),
      );
      expect(
        await rpc("eth_getStorageAt", [
          adapter.address,
          safe7579MappingSlot(account, 0),
          "latest",
        ]),
      ).toBe(zeroHash);
      expect((await inspect()).stateHash).toBe(before.stateHash);
    });
    it("rejects an actual alternate installed validator that could bypass the session policy", async () => {
      const init = encodeAbiParameters(
        [{ type: "uint256" }, { type: "address[]" }],
        [1n, [otherOwner]],
      );
      await install(1n, ownable.address, init);
      await expect(inspect()).rejects.toMatchObject({
        code: "SMART_MODULE_HISTORY_UNSUPPORTED",
      });
    });
    it("finds an unknown fallback selector from full history, including after its handler is removed", async () => {
      const selector = "0xaabbccdd";
      await install(
        3n,
        attackAddress,
        encodeAbiParameters(
          [{ type: "bytes4" }, { type: "bytes1" }, { type: "bytes" }],
          [selector, "0x00", "0x"],
        ),
      );
      const data = encodeFunctionData({
        abi: moduleAbi,
        functionName: "getFallbackHandlerBySelector",
        args: [selector],
      });
      const answer = await rpc<Hex>("eth_call", [
        { from: account, to: adapter.address, data },
        "latest",
      ]);
      expect(
        decodeFunctionResult({
          abi: moduleAbi,
          functionName: "getFallbackHandlerBySelector",
          data: answer,
        }),
      ).toEqual(["0x00", getAddress(attackAddress)]);
      expect(
        BigInt(
          await rpc<Hex>("eth_getStorageAt", [
            adapter.address,
            safe7579FallbackSlot(account, selector),
            "latest",
          ]),
        ),
      ).toBe(BigInt(attackAddress));
      await expect(inspect()).rejects.toMatchObject({
        code: "SMART_MODULE_HISTORY_UNSUPPORTED",
      });
      await ownerCall(
        account,
        encodeFunctionData({
          abi: moduleAbi,
          functionName: "uninstallModule",
          args: [
            3n,
            attackAddress,
            encodeAbiParameters(
              [{ type: "bytes4" }, { type: "bytes" }],
              [selector, "0x"],
            ),
          ],
        }),
      );
      await expect(inspect()).rejects.toMatchObject({
        code: "SMART_MODULE_HISTORY_UNSUPPORTED",
      });
    });
    it.each([2n, 4n, 8n, 9n])(
      "rejects real installed executor/hook authority type %s",
      async (type) => {
        const init =
          type >= 8n
            ? encodeAbiParameters(
                [{ type: "uint256" }, { type: "bytes" }],
                [type, "0x"],
              )
            : "0x";
        await install(type, attackAddress, init);
        await expect(inspect()).rejects.toMatchObject({
          code: "SMART_MODULE_HISTORY_UNSUPPORTED",
        });
      },
    );
    it("rejects multi-type install whose single type-zero event hides a fallback selector", async () => {
      const context = encodeAbiParameters(
        [{ type: "bytes4" }, { type: "bytes1" }, { type: "bytes" }],
        ["0xdeadbeef", "0x00", "0x"],
      );
      const init = encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes" }],
        [[1n, 3n], ["0x", context], "0x"],
      );
      await install(0n, attackAddress, init);
      await expect(inspect()).rejects.toMatchObject({
        code: "SMART_MODULE_HISTORY_UNSUPPORTED",
      });
    });
    it("records owner rotation even after the previous owner returns, invalidating an old binding", async () => {
      const subject = inspector();
      const original = await inspect(subject);
      await ownerCall(
        account,
        encodeFunctionData({
          abi: ownAbi,
          functionName: "swapOwner",
          args: [sentinel, owner, otherOwner],
        }),
      );
      const changed = await inspect(subject);
      expect(changed.stateHash).not.toBe(original.stateHash);
      await ownerCall(
        account,
        encodeFunctionData({
          abi: ownAbi,
          functionName: "swapOwner",
          args: [sentinel, otherOwner, owner],
        }),
        0,
        otherOwner,
      );
      const restored = await inspect(subject);
      expect(restored.stateHash).not.toBe(original.stateHash);
      expect(restored.stateHash).not.toBe(changed.stateHash);
    });
    it("rejects an owner delegatecall even when it leaves the final singleton unchanged", async () => {
      await ownerCall(
        attackAddress,
        encodeFunctionData({
          abi: attack.abi,
          functionName: "rewriteSingleton",
          args: [safe.address],
        }),
        1,
      );
      expect(await rpc("eth_getStorageAt", [account, zeroHash, "latest"])).toBe(
        padHex(safe.address, { size: 32 }),
      );
      await expect(inspect()).rejects.toMatchObject({
        code: "SMART_AUTHORITY_HISTORY_UNSUPPORTED",
      });
    });
    it("rejects incomplete or unavailable traces and does not treat ordinary module logs as complete proof", async () => {
      const incomplete = {
        request: async (
          chain: number,
          method: string,
          params: readonly unknown[],
        ) =>
          method === "debug_traceTransaction"
            ? []
            : transport.request(chain, method, params),
      };
      await expect(inspect(inspector(incomplete))).rejects.toMatchObject({
        code: "SMART_HISTORY_INCOMPLETE",
      });
      const unavailable = {
        request: async (
          chain: number,
          method: string,
          params: readonly unknown[],
        ) => {
          if (method === "debug_traceTransaction")
            throw new Error("no archive tracer");
          return transport.request(chain, method, params);
        },
      };
      await expect(inspect(inspector(unavailable))).rejects.toMatchObject({
        code: "SMART_TRACE_REQUIRED",
      });
    });
    it("binds every candidate trace to its exact canonical transaction and successful receipt", async () => {
      for (const mutation of [
        { from: otherOwner },
        { to: otherOwner },
        { input: "0x" },
        { value: "0x1" },
        { type: "CREATE" },
        { error: "execution reverted" },
      ]) {
        const substituted = {
          request: async (
            chain: number,
            method: string,
            params: readonly unknown[],
          ) => {
            const result = await transport.request(chain, method, params);
            return method === "debug_traceTransaction"
              ? { ...(result as Record<string, unknown>), ...mutation }
              : result;
          },
        };
        await expect(inspect(inspector(substituted))).rejects.toMatchObject({
          code: "SMART_HISTORY_INCOMPLETE",
        });
      }
      let traced = false;
      const wrongIndex = {
        request: async (
          chain: number,
          method: string,
          params: readonly unknown[],
        ) => {
          if (method === "debug_traceTransaction") traced = true;
          const result = await transport.request(chain, method, params);
          return method === "eth_getTransactionByHash"
            ? {
                ...(result as Record<string, unknown>),
                transactionIndex: "0x1",
              }
            : result;
        },
      };
      await expect(inspect(inspector(wrongIndex))).rejects.toMatchObject({
        code: "SMART_HISTORY_INCOMPLETE",
      });
      expect(traced).toBe(false);
    });
    it("traces only authority transactions when their canonical block also contains unrelated transactions", async () => {
      const data = encodeFunctionData({
        abi: safe.abi,
        functionName: "execTransaction",
        args: [
          account,
          0n,
          encodeFunctionData({
            abi: ownAbi,
            functionName: "changeThreshold",
            args: [1n],
          }),
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          concatHex([padHex(owner, { size: 32 }), zeroHash, "0x01"]),
        ],
      });
      let authorityHash: Hex, unrelatedHash: Hex;
      await rpc("evm_setAutomine", [false]);
      try {
        authorityHash = await rpc<Hex>("eth_sendTransaction", [
          { from: owner, to: account, data, gas: "0xf42400" },
        ]);
        unrelatedHash = await rpc<Hex>("eth_sendTransaction", [
          { from: otherOwner, to: owner, value: "0x1", gas: "0x5208" },
        ]);
        await rpc("evm_mine");
      } finally {
        await rpc("evm_setAutomine", [true]);
      }
      const authority = await rpc<{ status: Hex; blockHash: Hex }>(
        "eth_getTransactionReceipt",
        [authorityHash!],
      );
      const unrelated = await rpc<{ status: Hex; blockHash: Hex }>(
        "eth_getTransactionReceipt",
        [unrelatedHash!],
      );
      expect(authority.status).toBe("0x1");
      expect(authority.blockHash).toBe(unrelated.blockHash);
      const traced: Hex[] = [];
      const counted = {
        request: async (
          chain: number,
          method: string,
          params: readonly unknown[],
        ) => {
          if (method === "debug_traceTransaction")
            traced.push(params[0] as Hex);
          if (method === "debug_traceBlockByNumber")
            throw new Error("Whole blocks must not be traced");
          return transport.request(chain, method, params);
        },
      };
      expect((await inspect(inspector(counted))).complete).toBe(true);
      expect(traced).toEqual([creationHash, authorityHash!]);
      expect(traced).not.toContain(unrelatedHash!);
      await expect(
        inspect(
          createSafe7579Inspector({
            rpc: counted,
            utility: pin(utility),
            maxHistoryTransactions: 1,
            inspectSessions: createInstalledSessionVerifier({ rpc: counted })
              .inspectAllAt,
          }),
        ),
      ).rejects.toMatchObject({ code: "SMART_HISTORY_LIMIT" });
      await expect(
        inspect(
          createSafe7579Inspector({
            rpc: counted,
            utility: pin(utility),
            maxLogBytes: 1,
            inspectSessions: createInstalledSessionVerifier({ rpc: counted })
              .inspectAllAt,
          }),
        ),
      ).rejects.toMatchObject({ code: "SMART_HISTORY_LIMIT" });
    });
    it("resumes a retained canonical checkpoint after restart and rejects a changed current utility", async () => {
      const checkpointStore = new MemorySafe7579CheckpointStore();
      const create = (rpc = transport) =>
        createSafe7579Inspector({
          rpc,
          utility: pin(utility),
          checkpointStore,
          inspectSessions: createInstalledSessionVerifier({ rpc }).inspectAllAt,
        });
      const before = await inspect(create());
      const noHistory = {
        request: async (
          chain: number,
          method: string,
          params: readonly unknown[],
        ) => {
          if (method === "debug_traceTransaction")
            throw new Error("history must use retained checkpoint");
          return transport.request(chain, method, params);
        },
      };
      expect((await inspect(create(noHistory))).stateHash).toBe(
        before.stateHash,
      );
      await rpc("anvil_setCode", [utility.address, "0x00"]);
      await expect(inspect(create(noHistory))).rejects.toMatchObject({
        code: "SMART_INSPECTION_CODE_MISMATCH",
      });
    });
    it("falls back to an older canonical bucket after a recent chain reorganization", async () => {
      const checkpointStore = new MemorySafe7579CheckpointStore();
      const create = () =>
        createSafe7579Inspector({
          rpc: transport,
          utility: pin(utility),
          checkpointStore,
          inspectSessions: createInstalledSessionVerifier({ rpc: transport })
            .inspectAllAt,
        });
      const before = await inspect(create());
      const branch = await rpc<Hex>("evm_snapshot");
      await rpc("anvil_mine", ["0x80"]);
      await ownerCall(
        account,
        encodeFunctionData({
          abi: ownAbi,
          functionName: "swapOwner",
          args: [sentinel, owner, otherOwner],
        }),
      );
      expect((await inspect(create())).stateHash).not.toBe(before.stateHash);
      expect(await rpc("evm_revert", [branch])).toBe(true);
      await rpc("anvil_mine", ["0x81"]);
      expect((await inspect(create())).stateHash).toBe(before.stateHash);
    });
    it("splits log ranges when the provider enforces a range bound without omitting any blocks", async () => {
      await rpc("anvil_mine", ["0x4"]);
      let limited = 0;
      const restricted = {
        request: async (
          chain: number,
          method: string,
          params: readonly unknown[],
        ) => {
          if (method === "eth_getLogs") {
            const filter = params[0] as { fromBlock: Hex; toBlock: Hex };
            if (BigInt(filter.toBlock) - BigInt(filter.fromBlock) > 1n) {
              limited++;
              throw new Error("provider block range limit");
            }
          }
          return transport.request(chain, method, params);
        },
      };
      expect((await inspect(inspector(restricted))).complete).toBe(true);
      expect(limited).toBeGreaterThan(0);
    });
    it("uses the configured provider range on the first request while retaining complete verification", async () => {
      await rpc("anvil_mine", ["0x4"]);
      let pages = 0;
      const bounded = { request: async (chain: number, method: string, params: readonly unknown[]) => {
        if (method === "eth_getLogs") {
          const filter = params[0] as {fromBlock: Hex; toBlock: Hex};
          expect(BigInt(filter.toBlock) - BigInt(filter.fromBlock)).toBeLessThan(2n);
          pages++;
        }
        return transport.request(chain, method, params);
      }};
      const subject = createSafe7579Inspector({rpc: bounded, utility: pin(utility), maxLogRangeBlocks: 2,
        inspectSessions: createInstalledSessionVerifier({rpc: bounded}).inspectAllAt});
      expect((await inspect(subject)).complete).toBe(true);
      expect(pages).toBeGreaterThan(3);
    });
    it.each([
      { failure: "rpc", code: "SMART_HISTORY_RPC_UNAVAILABLE" },
      { failure: "deadline", code: "SMART_HISTORY_TIMEOUT" },
      { failure: "quota", code: "RPC_RATE_LIMITED" },
    ])("preserves the canonical checkpoint when a history page fails: $failure", async ({ failure, code }) => {
      const checkpointStore = new MemorySafe7579CheckpointStore();
      const checkpointKey = `${manifest.chainId}:${account.toLowerCase()}:${manifest.revision}:${utility.runtimeCodeHash}`;
      await inspect(createSafe7579Inspector({
        rpc: transport,
        utility: pin(utility),
        checkpointStore,
        inspectSessions: createInstalledSessionVerifier({ rpc: transport }).inspectAllAt,
      }));
      const retained = await checkpointStore.get(checkpointKey);
      await rpc("anvil_mine", [toHex(8)]);
      const unavailableBlock = BigInt(retained[0]!.lastBlock) + 3n;
      const failedRanges: [bigint, bigint][] = [];
      const quotaError = new RestError(429, "RPC_RATE_LIMITED", "The RPC quota is exhausted.");
      const failing = {
        request: async (chain: number, method: string, params: readonly unknown[], signal?: AbortSignal) => {
          if (method === "eth_getLogs") {
            const filter = params[0] as { address: string; fromBlock: Hex; toBlock: Hex };
            const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
            if (filter.address.toLowerCase() === account.toLowerCase() && from <= unavailableBlock && to >= unavailableBlock) {
              failedRanges.push([from, to]);
              if (failure === "quota") throw quotaError;
              if (failure === "deadline") await new Promise<never>((_, reject) => {
                const abort = () => reject(signal?.reason ?? new Error("History request aborted."));
                if (signal?.aborted) abort();
                else signal?.addEventListener("abort", abort, { once: true });
              });
              throw new Error("Provider cannot serve this block.");
            }
          }
          return transport.request(chain, method, params);
        },
      };
      const subject = createSafe7579Inspector({
        rpc: failing,
        utility: pin(utility),
        checkpointStore,
        maxLogRangeBlocks: 2,
        timeoutMs: 1000,
        inspectSessions: createInstalledSessionVerifier({ rpc: failing }).inspectAllAt,
      });
      const inspection = inspect(subject);
      if (failure === "quota") await expect(inspection).rejects.toBe(quotaError);
      else await expect(inspection).rejects.toMatchObject({ code });
      expect(failedRanges.length).toBeGreaterThan(0);
      if (failure === "rpc") expect(failedRanges.at(-1)).toEqual([unavailableBlock, unavailableBlock]);
      if (failure === "quota") expect(failedRanges).toHaveLength(1);
      expect(await checkpointStore.get(checkpointKey)).toEqual(retained);
    }, 20000);
    it("stops at the next read when the caller cancels, even through a transport that ignores the signal, and writes no checkpoint", async () => {
      const checkpointStore = new MemorySafe7579CheckpointStore();
      const checkpointKey = `${manifest.chainId}:${account.toLowerCase()}:${manifest.revision}:${utility.runtimeCodeHash}`;
      const controller = new AbortController();
      let afterCancel = 0;
      const deaf = {
        request: async (chain: number, method: string, params: readonly unknown[]) => {
          if (controller.signal.aborted) afterCancel += 1;
          const result = await transport.request(chain, method, params);
          if (method === "eth_getLogs") controller.abort();
          return result;
        },
      };
      const subject = createSafe7579Inspector({
        rpc: deaf,
        utility: pin(utility),
        checkpointStore,
        inspectSessions: createInstalledSessionVerifier({ rpc: deaf }).inspectAllAt,
      });
      await expect(subject.inspect({ account, manifest, snapshot: await snapshot(), signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
      // Reads already in flight when the cancel landed may finish; nothing new starts.
      expect(afterCancel).toBe(0);
      expect(await checkpointStore.get(checkpointKey)).toEqual([]);
    }, 20000);
    it("a cancel landing as the state reads are assembled rejects once, with nothing left unhandled", async () => {
      const controller = new AbortController();
      const leaked: unknown[] = [];
      const onLeak = (reason: unknown) => leaked.push(reason);
      process.on("unhandledRejection", onLeak);
      try {
        const deaf = {
          request: async (chain: number, method: string, params: readonly unknown[]) => {
            const result = await transport.request(chain, method, params);
            // The last history read before the state section: the cancel lands as it resolves.
            if (method === "eth_getBlockByNumber") controller.abort();
            return result;
          },
        };
        const subject = createSafe7579Inspector({
          rpc: deaf,
          utility: pin(utility),
          inspectSessions: createInstalledSessionVerifier({ rpc: deaf }).inspectAllAt,
        });
        await expect(subject.inspect({ account, manifest, snapshot: await snapshot(), signal: controller.signal }))
          .rejects.toMatchObject({ name: "AbortError" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(leaked).toEqual([]);
      } finally {
        process.off("unhandledRejection", onLeak);
      }
    }, 20000);
    it("proves a dormant month's account history with candidate traces and still catches later hidden code changes", async () => {
      // A month of idle time and more elapsed blocks than this inspector's two-active-block
      // budget. Small local block counts keep this test independent of Anvil archive pruning.
      await rpc("anvil_mine", ["0x10", toHex(162000)]);
      const traced: Hex[] = [];
      const counted = {
        request: async (
          chain: number,
          method: string,
          params: readonly unknown[],
        ) => {
          if (method === "debug_traceTransaction")
            traced.push(params[0] as Hex);
          return transport.request(chain, method, params);
        },
      };
      const subject = createSafe7579Inspector({
        rpc: counted,
        utility: pin(utility),
        maxHistoryBlocks: 2,
        inspectSessions: createInstalledSessionVerifier({ rpc: counted })
          .inspectAllAt,
      });
      expect((await inspect(subject)).complete).toBe(true);
      expect(traced).toEqual([creationHash]);
      await ownerCall(
        attackAddress,
        encodeFunctionData({
          abi: attack.abi,
          functionName: "rewriteSingleton",
          args: [safe.address],
        }),
        1,
      );
      await expect(inspect(subject)).rejects.toMatchObject({
        code: "SMART_AUTHORITY_HISTORY_UNSUPPORTED",
      });
    }, 20000);
    it("certifies initialization epochs across actual init, counter consumption and an unobserved policy reset", async () => {
      const time = artifact("TimeFramePolicy"),
        universal = artifact("UniActionPolicy"),
        value = artifact("ValueLimitPolicy"),
        guard = artifact("CenterSessionGuard");
      guard.address = "0x6000000000000000000000000000000000000006";
      for (const a of [time, universal, value, guard])
        await rpc("anvil_setCode", [
          a.address,
          a.deployedRuntimeBytecode ?? a.deployedBytecode,
        ]);
      const guardSource = guard.source as unknown as {
        sha256: string;
        compilerArtifactSha256: string;
      };
      const guardPin: ContractPin = {
        address: guard.address,
        runtimeCodeHash: guard.runtimeCodeHash,
        source: {
          repository: "juicebox-center",
          contentSha256: guardSource.sha256,
          artifactSha256: guardSource.compilerArtifactSha256,
        },
      };
      const bot = privateKeyToAccount(`0x${"33".repeat(32)}`);
      const now = Number((await snapshot()).evidence.timestamp);
      const transferAbi = parseAbi([
        "function transfer(address beneficiary,uint256 amount) returns(bool)",
      ]);
      const transfer = encodeFunctionData({
        abi: transferAbi,
        functionName: "transfer",
        args: [otherOwner, 30n],
      });
      const policy = {
        schemaVersion: 1,
        ownerAccountId: `eip155:31337:${owner.toLowerCase()}`,
        bindingId: zeroHash,
        grantId: "local-epoch-proof",
        sessionKey: bot.address,
        chainId: 31337,
        wallet: account,
        generation: "1",
        nonce: keccak256(toHex("epoch nonce")),
        validAfter: now,
        validUntil: now + 7 * 86400,
        maximumCalls: "2",
        salt: keccak256(toHex("epoch generation")),
        restrictToActions: true,
        signing: { mode: "disabled" },
        crossChainPermits: false,
        claimPolicies: false,
        wildcardFallback: false,
        allocations: [],
        gasBudget: {
          paymaster: value.address,
          paymasterCodeHash: value.runtimeCodeHash,
          paymasterReviewId: "local-code-only",
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
            target: attackAddress,
            selector: transfer.slice(0, 10),
            asset: attackAddress,
            beneficiary: otherOwner,
            perCallLimit: "60",
            totalLimit: "100",
          },
        ],
      };
      const compiled = createLegacySessionCompiler({
        stack: {
          smartSessions: pin(sessions),
          sessionValidator: pin(ownable),
          timeFrame: pin(time),
          universalAction: pin(universal),
          valueLimit: pin(value),
          sessionGuard: guardPin,
        },
      }).compile({
        review: {
          policy,
          policyHash: fingerprint(policy),
          manifestRevision: manifest.revision,
        } as unknown as SessionReview,
        activationEnableNonce: "0",
      });
      const verifier = createInstalledSessionVerifier({
        rpc: transport,
        findCompiled: async () => compiled,
      });
      const subject = createSafe7579Inspector({
        rpc: transport,
        utility: pin(utility),
        inspectSessions: verifier.inspectAllAt,
      });
      const baseline = await inspect(subject);
      expect(baseline.details).toMatchObject({
        sessionAdministration: { epoch: "0" },
      });
      const initializer = encodeFunctionData({
        abi: sessions.abi,
        functionName: "onInstall",
        args: [
          concatHex([
            "0x02",
            encodeAbiParameters(LEGACY_SESSION_PARAMETERS, [
              [compiled.session],
            ]),
          ]),
        ],
      });
      await ownerCall(sessions.address, initializer);
      // Consume the real validator/policy counters through the real Safe owner call. This fixture
      // does not claim EntryPoint sponsorship: the sponsor supplies code identity only.
      const userOpHash = keccak256(toHex("epoch counter use"));
      const packed = {
        sender: account,
        nonce: BigInt(sessions.address) << 96n,
        initCode: "0x",
        callData: encodeSafe7579Execution([
          { target: attackAddress, value: "0", callData: transfer },
        ]),
        accountGasLimits: concatHex([
          toHex(100, { size: 16 }),
          toHex(100, { size: 16 }),
        ]),
        preVerificationGas: 100n,
        gasFees: concatHex([toHex(1, { size: 16 }), toHex(2, { size: 16 })]),
        paymasterAndData: concatHex([
          value.address,
          toHex(100, { size: 16 }),
          toHex(100, { size: 16 }),
          `0x${"00".repeat(78)}`,
        ]),
        signature: concatHex([
          "0x00",
          compiled.permissionId,
          await bot.signMessage({ message: { raw: userOpHash } }),
        ]),
      };
      await ownerCall(
        sessions.address,
        encodeFunctionData({
          abi: sessions.abi,
          functionName: "validateUserOp",
          args: [packed, userOpHash],
        }),
      );
      const spent = await verifier.verify(compiled);
      expect(spent.counters.some((counter) => BigInt(counter.used) > 0n)).toBe(
        true,
      );
      await ownerCall(
        sessions.address,
        encodeFunctionData({
          abi: sessions.abi,
          functionName: "removeSession",
          args: [compiled.permissionId],
        }),
      );
      await ownerCall(sessions.address, initializer);
      const reset = await verifier.verify(compiled);
      expect(
        reset.counters.every((counter) => BigInt(counter.used) === 0n),
      ).toBe(true);
      const after = await inspect(subject);
      expect(after.stateHash).toBe(baseline.stateHash);
      expect(after.details).toMatchObject({
        sessionAdministration: {
          epoch: "3",
          lastInitialization: {
            epoch: "3",
            permissionIds: [compiled.permissionId],
          },
        },
      });
      // The immutable preparation baseline0 admits only initialization1, so this reset cannot be
      // confused with untouched counters on the first activation observation.
      expect(
        BigInt(
          (after.details as { sessionAdministration: { epoch: string } })
            .sessionAdministration.epoch,
        ),
      ).not.toBe(1n);
    });
    it("matches the source-specific SafeOp owner envelope and OwnableValidator EIP-191 verification in the actual EVM", async () => {
      const signer = privateKeyToAccount(`0x${"33".repeat(32)}`);
      const hash = keccak256(toHex("real artifact signing proof"));
      const signature = await signer.signMessage({ message: { raw: hash } });
      const data = encodeFunctionData({
        abi: ownable.abi,
        functionName: "validateSignatureWithData",
        args: [
          hash,
          signature,
          encodeAbiParameters(
            [{ type: "uint256" }, { type: "address[]" }],
            [1n, [signer.address]],
          ),
        ],
      });
      const valid = decodeFunctionResult({
        abi: ownable.abi,
        functionName: "validateSignatureWithData",
        data: await rpc<Hex>("eth_call", [
          { to: ownable.address, data },
          "latest",
        ]),
      });
      expect(valid).toBe(true);
      const operation = {
        sender: account,
        nonce: "0x0" as Hex,
        callData: "0x" as Hex,
        callGasLimit: toHex(100000),
        verificationGasLimit: toHex(100000),
        preVerificationGas: toHex(50000),
        maxFeePerGas: toHex(1000000000),
        maxPriorityFeePerGas: toHex(1),
        signature: "0x" as Hex,
      };
      const payload = safe7579OwnerSigningPayload({
        operation,
        chainId: 31337,
        safe7579: adapter.address,
        entryPoint: entry.address,
        validAfter: "0",
        validUntil: "10000000000",
      });
      const signed = {
        ...operation,
        signature: encodeSafe7579OwnerSignature({
          validAfter: "0",
          validUntil: "10000000000",
          signatures: signature,
        }),
      };
      const opData = encodeFunctionData({
        abi: adapter.abi,
        functionName: "getSafeOp",
        args: [packUserOperation(signed), entry.address],
      });
      const result = decodeFunctionResult({
        abi: adapter.abi,
        functionName: "getSafeOp",
        data: await rpc<Hex>("eth_call", [
          { to: adapter.address, data: opData },
          "latest",
        ]),
      }) as [Hex, bigint, bigint, Hex];
      expect(keccak256(result[0])).toBe(payload.digest);
    });
    // Last: this gap intentionally exceeds the fixture node's retained historical state.
    it("covers a dormant checkpoint's 32,000 blocks in concurrent 500-block pages", async () => {
      const checkpointStore = new MemorySafe7579CheckpointStore();
      const checkpointKey = `${manifest.chainId}:${account.toLowerCase()}:${manifest.revision}:${utility.runtimeCodeHash}`;
      const before = await inspect(createSafe7579Inspector({
        rpc: transport,
        utility: pin(utility),
        checkpointStore,
        inspectSessions: createInstalledSessionVerifier({ rpc: transport }).inspectAllAt,
      }));
      const [retained] = await checkpointStore.get(checkpointKey);
      await rpc("anvil_mine", [toHex(32000)]);
      const streams = [account, adapter.address, entry.address].map(address => address.toLowerCase());
      const ranges = new Map<string, [bigint, bigint][]>();
      const active = new Map<string, number>();
      const peak = new Map<string, number>();
      let totalActive = 0, totalPeak = 0;
      let release!: () => void;
      const firstBatch = new Promise<void>(resolve => { release = resolve; });
      const concurrent = {
        request: async (chain: number, method: string, params: readonly unknown[], signal?: AbortSignal) => {
          if (method !== "eth_getLogs") return transport.request(chain, method, params);
          const filter = params[0] as { address: string; fromBlock: Hex; toBlock: Hex };
          const stream = filter.address.toLowerCase();
          ranges.set(stream, [...(ranges.get(stream) ?? []), [BigInt(filter.fromBlock), BigInt(filter.toBlock)]]);
          active.set(stream, (active.get(stream) ?? 0) + 1);
          peak.set(stream, Math.max(peak.get(stream) ?? 0, active.get(stream)!));
          totalPeak = Math.max(totalPeak, ++totalActive);
          // A serial loop leaves one request per stream waiting until its deadline.
          // Real RPC latency is irrelevant: all twelve first pages must be in flight.
          if (streams.every(address => active.get(address) === 4)) release();
          let abort!: () => void;
          try {
            await Promise.race([
              firstBatch,
              new Promise<never>((_, reject) => {
                abort = () => reject(signal?.reason ?? new Error("History request aborted."));
                if (signal?.aborted) abort();
                else signal?.addEventListener("abort", abort, { once: true });
              }),
            ]);
            return await transport.request(chain, method, params);
          } finally {
            signal?.removeEventListener("abort", abort);
            active.set(stream, active.get(stream)! - 1);
            totalActive--;
          }
        },
      };
      const proof = await inspect(createSafe7579Inspector({
        rpc: concurrent,
        utility: pin(utility),
        checkpointStore,
        maxLogRangeBlocks: 500,
        timeoutMs: 3000,
        inspectSessions: createInstalledSessionVerifier({ rpc: concurrent }).inspectAllAt,
      }));
      expect(proof.complete).toBe(true);
      expect(proof.stateHash).toBe(before.stateHash);
      expect(totalPeak).toBe(12);
      expect(totalActive).toBe(0);
      expect([...ranges.keys()].sort()).toEqual([...streams].sort());
      const expected = Array.from({ length: 64 }, (_, page) => [
        BigInt(retained!.lastBlock) + BigInt(page * 500) + 1n,
        BigInt(retained!.lastBlock) + BigInt((page + 1) * 500),
      ]);
      for (const stream of streams) {
        expect(peak.get(stream)).toBe(4);
        expect(ranges.get(stream)!.sort((a, b) => Number(a[0] - b[0]))).toEqual(expected);
      }
      expect((await checkpointStore.get(checkpointKey))[0]!.lastBlock).toBe(
        String(BigInt(retained!.lastBlock) + 32000n),
      );
    }, 120000);
  },
);
