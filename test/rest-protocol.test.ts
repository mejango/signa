import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  zeroHash,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import {
  createProtocolReadService,
  type ProtocolCatalog,
} from "../src/rest/protocol/index.js";
import { argumentsFor, signature } from "../src/rest/protocol/abi.js";
import {
  cloneImplementation,
  verifyRuntime,
} from "../src/rest/protocol/code.js";
import type {
  CodeRecord,
  ContractRecord,
  DeploymentRecord,
} from "../src/rest/contracts/types.js";
import type { RestRpc } from "../src/rest/core.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";

const owner = "0x1111111111111111111111111111111111111111" as const;
const destination = "0x2222222222222222222222222222222222222222" as const;
const other = "0x3333333333333333333333333333333333333333" as const;
const factoryAddress = "0x4444444444444444444444444444444444444444" as const;
const projectsAddress = "0x5555555555555555555555555555555555555555" as const;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const runtime = "0x600160005260206000f3" as const;
const modified = "0x600260005260206000f3" as const;
const genericAbi = parseAbi([
  "function answer(uint8 kind) view returns (uint256 total, int24 tick)",
  "function change(uint256 amount) nonpayable",
  "function change(address beneficiary) nonpayable",
  "function fund((address recipient, uint256 amount)[] splits, int24 tick, bytes32 salt) payable",
]);
function code(id = "code", bytes: Hex = runtime): CodeRecord {
  return {
    id,
    hashEncoding: "lowercase-hex-text",
    runtimeTemplate: bytes,
    runtimeTemplateSha256: "fixture",
    runtimeTemplateKeccak256: keccak256(bytes),
    runtimeTemplateByteLength: (bytes.length - 2) / 2,
    creationSha256: "fixture",
    immutableReferences: [],
    linkReferences: [],
    compilerEvidence: {
      artifactPath: "fixture",
      artifactSha256: "fixture",
      compilerVersion: "0.8.28",
      metadataSha256: "fixture",
    },
  };
}
function record(
  name = "JBExample",
  target: Address = destination,
  abi: Abi = genericAbi,
  codeId = "code",
): ContractRecord {
  const id = `core:src/${name}.sol:${name}`;
  const deployment: DeploymentRecord = {
    alias: name,
    retired: false,
    address: target,
    chainId: 1,
    abiHash: name,
    codeId,
    artifactPath: "fixture",
    artifactSha256: "fixture",
    sourceRef: "fixture",
    solcInputHash: "fixture",
    compilerInputIdentitySha256: "fixture",
    constructorArguments: [],
    receipt: {
      transactionHash: zeroHash,
      blockNumber: "1",
      blockHash: zeroHash,
    },
    instanceKind: "unclassified",
  };
  return {
    id,
    packageId: "core",
    sourcePath: `src/${name}.sol`,
    name,
    category: "contract",
    executable: true,
    abi,
    abiHash: name,
    methods: [],
    variants: [
      {
        abiHash: name,
        abi,
        codeIds: [codeId],
        methods: [],
        provenance: [],
        usage: "published",
      },
    ],
    deployments: [{ chainId: 1, status: "published", instances: [deployment] }],
    cloneFamilies: [],
  };
}
function fixture(
  options: {
    records?: ContractRecord[];
    codes?: CodeRecord[];
    actualCode?: (target: Address) => Hex;
    onCall?: (
      target: Address,
      fn: string,
      args: readonly unknown[],
    ) => readonly unknown[];
    chain?: string;
  } = {},
) {
  const records = options.records ?? [record()];
  const codes = options.codes ?? [code()];
  const catalog: ProtocolCatalog = {
    data: {
      schemaVersion: 1,
      protocolVersion: 6,
      chains: [{ id: 1, name: "Ethereum", testnet: false }],
      packages: [],
      deploymentManifest: {
        repository: "fixture",
        commit: "fixture",
        treeDigest: "fixture",
      },
      generation: { sourceManifestHash: "fixture", contentHash: "fixture" },
      exclusions: [],
      contracts: records,
      codes,
    },
    get: (id) => records.find((item) => item.id === id)!,
    code: (id) => codes.find((item) => item.id === id)!,
  };
  const request = vi.fn(
    async (_chainId: number, method: string, params: readonly unknown[]) => {
      if (method === "eth_chainId") return options.chain ?? "0x1";
      if (method === "eth_getBlockByNumber")
        return {
          number: params[0] === "latest" ? "0x10" : params[0],
          hash: blockHash,
          timestamp: "0x1234",
        };
      if (method === "eth_getCode")
        return options.actualCode?.(params[0] as Address) ?? runtime;
      if (method === "eth_call") {
        const tx = params[0] as { to: Address; data: Hex };
        const fullAbi = records.flatMap((item) => item.abi);
        const decoded = decodeFunctionData({ abi: fullAbi, data: tx.data });
        const fn = fullAbi.find(
          (entry): entry is AbiFunction =>
            entry.type === "function" && entry.name === decoded.functionName,
        )!;
        const result = options.onCall?.(
          tx.to,
          decoded.functionName,
          decoded.args ?? [],
        ) ?? [900719925474099300000n, -17];
        return encodeAbiParameters(fn.outputs, result);
      }
      throw new Error(`Unexpected RPC method ${method}`);
    },
  );
  return {
    catalog,
    request,
    service: createProtocolReadService({
      rpc: { request } as RestRpc,
      catalog,
    }),
    record: records[0]!,
  };
}

describe("REST protocol ABI boundaries", () => {
  const fn = genericAbi.find(
    (item) => item.type === "function" && item.name === "fund",
  )! as AbiFunction;
  it("preserves signed integers and full-width tuple-array amounts without number coercion", () => {
    expect(signature(fn)).toBe("fund((address,uint256)[],int24,bytes32)");
    expect(
      argumentsFor(fn, [
        [
          {
            recipient: owner,
            amount:
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
          },
        ],
        "-8388608",
        zeroHash,
      ]),
    ).toEqual([[[owner, (1n << 256n) - 1n]], -8388608n, zeroHash]);
  });
  it("rejects rounded JSON numbers, malformed tuples, extra keys and integer overflow", () => {
    for (const amount of [
      1,
      1e30,
      "1e18",
      "01",
      "-0",
      "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    ])
      expect(() =>
        argumentsFor(fn, [[{ recipient: owner, amount }], "0", zeroHash]),
      ).toThrow();
    expect(() =>
      argumentsFor(fn, [
        [{ recipient: owner, amount: "1", ignored: true }],
        "0",
        zeroHash,
      ]),
    ).toThrow(/exactly|extra/);
    expect(() =>
      argumentsFor(fn, [[[owner, "1"]], "8388608", zeroHash]),
    ).toThrow(/int24/);
    expect(() => argumentsFor(fn, [[[owner, "1"]], "0", "0xab"])).toThrow(
      /length/,
    );
  });
});

describe("Signa protocol target proofs", () => {
  it("retains historical addresses without making default destination resolution ambiguous", async () => {
    const current = record();
    const previous = { ...current.deployments[0]!.instances[0]!, address: other, alias: "JBExample_deprecated", retired: true };
    const records = [{ ...current, deployments: [{ chainId: 1, status: "published" as const, instances: [previous, ...current.deployments[0]!.instances] }] }];
    const { service } = fixture({ records });
    expect((await service.resolve({ chainId: 1, contractId: current.id })).address).toBe(destination);
    expect((await service.resolve({ chainId: 1, contractId: current.id, address: other })).provenance).toMatchObject({ publication: { retired: true } });
  });

  it.each([true, false])("resolves the project's registry-selected router with gateway=%s", async (useGateway) => {
    const registry = record("JBRouterTerminalRegistry", factoryAddress, parseAbi(["function terminalOf(uint256) view returns (address)"]));
    const gateway = record("JBRouterTerminalGateway", other, parseAbi(["function ROUTER() view returns (address)"]));
    const router = record("JBRouterTerminal", destination);
    const retired = { ...router.deployments[0]!.instances[0]!, retired: !useGateway };
    const selectedRouter = { ...router, deployments: [{ chainId: 1, status: "published" as const, instances: [retired] }] };
    const directory = record("JBDirectory", owner, parseAbi(["function terminalsOf(uint256) view returns (address[])"]));
    const projects = record("JBProjects", projectsAddress, parseAbi(["function ownerOf(uint256) view returns (address)"]));
    let registryAttached = true;
    const { service, request } = fixture({
      records: [registry, gateway, selectedRouter, directory, projects],
      onCall: (_target, fn) => fn === "terminalOf" ? [useGateway ? other : destination]
        : fn === "ROUTER" ? [destination] : fn === "terminalsOf" ? [registryAttached ? [factoryAddress] : []] : [owner],
    });
    const result = await service.resolve({ chainId: 1, contractId: router.id, projectId: "2" });
    expect(result.address).toBe(destination);
    expect(result.provenance).toMatchObject({ projectContext: {
      terminalAssociationChecked: true,
      routerRoute: { registry: factoryAddress, terminal: useGateway ? other : destination, gateway: useGateway ? other : null, router: destination },
    } });
    if (useGateway) {
      expect((await service.resolve({ chainId: 1, contractId: gateway.id, projectId: "2" })).address).toBe(other);
      await expect(service.resolve({ chainId: 1, contractId: router.id, projectId: "2", address: other })).rejects.toMatchObject({ code: "PROJECT_ROUTER_MISMATCH" });
    } else {
      await expect(service.resolve({ chainId: 1, contractId: gateway.id, projectId: "2" })).rejects.toMatchObject({ code: "PROJECT_ROUTER_MISMATCH" });
    }
    for (const [, method, params] of request.mock.calls)
      if (method === "eth_getCode" || method === "eth_call") expect(params[1]).toEqual({ blockHash, requireCanonical: true });
    registryAttached = false;
    await expect(service.resolve({ chainId: 1, contractId: router.id, projectId: "2" })).rejects.toMatchObject({ code: "PROJECT_TERMINAL_MISMATCH" });
  });

  it("pins target code verification to the requested canonical block", async () => {
    const { service, request, record } = fixture();
    const result = await service.resolve({
      chainId: 1,
      contractId: record.id,
      blockNumber: "15",
    });
    expect(result.evidence[0]).toMatchObject({ blockHash, blockNumber: "15" });
    expect(result.provenance).toMatchObject({
      kind: "published-deployment",
      runtimeVerified: true,
      runtime: { runtimeCodeHash: keccak256(runtime) },
    });
    for (const [, method, params] of request.mock.calls)
      if (method === "eth_getCode" || method === "eth_call")
        expect(params[1]).toEqual({ blockHash, requireCanonical: true });
    expect(
      request.mock.calls.some(
        ([, method]) => method.includes("send") || method.includes("sign"),
      ),
    ).toBe(false);
  });
  it("rejects wrong chains, absent code, known mismatching runtime and arbitrary lookalike targets", async () => {
    const wrong = fixture({ chain: "0xa" });
    await expect(
      wrong.service.resolve({ chainId: 1, contractId: wrong.record.id }),
    ).rejects.toMatchObject({ code: "RPC_CHAIN_MISMATCH" });
    for (const actualCode of [() => "0x" as Hex, () => modified]) {
      const test = fixture({ actualCode });
      await expect(
        test.service.resolve({ chainId: 1, contractId: test.record.id }),
      ).rejects.toBeDefined();
    }
    const test = fixture();
    await expect(
      test.service.resolve({
        chainId: 1,
        contractId: test.record.id,
        address: other,
      }),
    ).rejects.toMatchObject({ code: "TARGET_UNVERIFIED" });
    await expect(
      test.service.resolve({
        chainId: 1,
        contractId: test.record.id,
        abi: genericAbi,
      } as never),
    ).rejects.toMatchObject({ code: "ABI_ARGUMENT_INVALID" });
  });
  it("does not downgrade failed EIP-1898 reads to latest", async () => {
    const test = fixture();
    test.request.mockImplementationOnce(async () => "0x1");
    test.request.mockImplementationOnce(async () => ({
      number: "0x10",
      hash: blockHash,
      timestamp: "0x1234",
    }));
    test.request.mockImplementationOnce(async () => {
      throw new Error("canonical block unavailable");
    });
    await expect(
      test.service.resolve({ chainId: 1, contractId: test.record.id }),
    ).rejects.toThrow("canonical block unavailable");
    expect(test.request).toHaveBeenCalledTimes(3);
  });
  it("distinguishes address provenance from unavailable source-to-runtime equality", async () => {
    const template = {
      ...code(),
      immutableReferences: null,
      compilerEvidence: null,
    };
    const test = fixture({ codes: [template], actualCode: () => modified });
    const result = await test.service.resolve({
      chainId: 1,
      contractId: test.record.id,
    });
    expect(result.provenance).toMatchObject({
      runtimeVerified: false,
      runtime: {
        mode: "official-address-runtime-observed",
        runtimeCodeHash: keccak256(modified),
        verificationGap: expect.any(String),
      },
    });
  });
});

describe("REST protocol runtime and factory proofs", () => {
  it("selects the published LP hook ABI instead of incompatible newer source methods", async () => {
    const catalog = await getContractCatalog();
    const hook = catalog.data.contracts.find(
      (item) =>
        item.name === "JBUniswapV4LPSplitHook" && item.category === "contract",
    )!;
    const deployment = hook.deployments.find((item) => item.chainId === 1)!
      .instances[0]!;
    const test = fixture({
      records: [hook],
      codes: [...catalog.data.codes],
      actualCode: () => catalog.code(deployment.codeId).runtimeTemplate,
    });
    const result = await test.service.resolve({
      chainId: 1,
      contractId: hook.id,
      address: deployment.address,
    });
    expect(result.abiHash).toBe(deployment.abiHash);
    expect(result.address).toBe(deployment.address);
    expect(result.provenance).toMatchObject({
      kind: "published-deployment",
      publication: { abiHash: deployment.abiHash },
    });
  });
  it("uses only authoritative immutable spans and rejects edits outside them", () => {
    const template = {
      ...code(),
      immutableReferences: [{ start: 1, length: 1 }],
    };
    expect(verifyRuntime(modified, template)).toMatchObject({
      mode: "compiler-template-with-observed-immutables",
      immutableValues: [{ start: 1, length: 1, value: "0x02" }],
    });
    expect(() => verifyRuntime("0x600260005260216000f3", template)).toThrow(
      /outside/,
    );
    expect(() =>
      verifyRuntime(modified, { ...template, immutableReferences: null }),
    ).toThrow(/unavailable/);
    expect(cloneImplementation("0x6000")).toBeNull();
  });
  function tokenFixture(
    registered = true,
    missingMask = false,
    implementationOverride?: Hex,
  ) {
    const tokenAbi = parseAbi([
      "function tokens() view returns (address)",
      "function balanceOf(address account) view returns (uint256)",
    ]);
    const factoryAbi = parseAbi([
      "function TOKEN() view returns (address)",
      "function projectIdOf(address token) view returns (uint256)",
      "function tokenOf(uint256 projectId) view returns (address)",
    ]);
    const projectsAbi = parseAbi([
      "function ownerOf(uint256 tokenId) view returns (address)",
    ]);
    const token = record("JBERC20", destination, tokenAbi, "token-code");
    const factory = record("JBTokens", factoryAddress, factoryAbi);
    const projects = record("JBProjects", projectsAddress, projectsAbi);
    token.cloneFamilies = [
      {
        standard: "erc-1167",
        implementationContractId: token.id,
        factoryContractId: factory.id,
        implementationGetter: "TOKEN()",
        sourcePath: "src/JBTokens.sol",
        sourceRef: "fixture",
      },
    ];
    const clone =
      `0x363d3d373d3d3d363d73${destination.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
    return fixture({
      records: [token, factory, projects],
      codes: [
        code(),
        {
          ...code("token-code"),
          ...(missingMask
            ? { immutableReferences: null, compilerEvidence: null }
            : {}),
        },
      ],
      actualCode: (target) =>
        target === other
          ? clone
          : target === destination
            ? (implementationOverride ?? (missingMask ? modified : runtime))
            : runtime,
      onCall: (_target, fn) => {
        if (fn === "TOKEN") return [destination];
        if (fn === "projectIdOf") return [registered ? 7n : 0n];
        if (fn === "tokenOf") return [other];
        if (fn === "tokens") return [factoryAddress];
        if (fn === "ownerOf") return [owner];
        if (fn === "balanceOf") return [12345678901234567890n];
        throw new Error(`Unexpected ${fn}`);
      },
    });
  }
  it("verifies token clone implementation and both directions of canonical project association", async () => {
    const test = tokenFixture();
    const result = await test.service.resolve({
      chainId: 1,
      contractId: test.record.id,
      address: other,
    });
    expect(result.provenance).toMatchObject({
      kind: "verified-factory-clone",
      runtimeVerified: true,
      association: {
        kind: "project-token",
        projectId: "7",
        projectOwner: owner,
      },
      implementation: { address: destination },
    });
  });
  it("labels an official factory-selected implementation with missing masks as address provenance only", async () => {
    const test = tokenFixture(true, true);
    const result = await test.service.resolve({
      chainId: 1,
      contractId: test.record.id,
      address: other,
    });
    expect(result.provenance).toMatchObject({
      kind: "verified-factory-clone",
      runtimeVerified: false,
      verificationLevel: "factory-address-provenance",
      verificationGap: expect.any(String),
      implementation: {
        runtimeVerified: false,
        runtime: {
          mode: "factory-address-runtime-observed",
          runtimeCodeHash: keccak256(modified),
        },
      },
      factory: {
        runtimeVerified: true,
        runtime: { runtimeCodeHash: keccak256(runtime) },
      },
      association: { projectId: "7" },
    });
    const unregistered = tokenFixture(false, true);
    await expect(
      unregistered.service.resolve({
        chainId: 1,
        contractId: unregistered.record.id,
        address: other,
      }),
    ).rejects.toMatchObject({ code: "DYNAMIC_PROVENANCE_UNVERIFIED" });
  });
  it("never weakens a positively mismatching implementation with known compiler references", async () => {
    const test = tokenFixture(true, false, modified);
    await expect(
      test.service.resolve({
        chainId: 1,
        contractId: test.record.id,
        address: other,
      }),
    ).rejects.toMatchObject({
      code: "DYNAMIC_PROVENANCE_UNVERIFIED",
      details: {
        failures: [
          {
            factoryContractId: expect.any(String),
            code: "RUNTIME_CODE_MISMATCH",
          },
        ],
      },
    });
  });
  it("rejects byte-identical clones missing canonical registration", async () => {
    const test = tokenFixture(false);
    await expect(
      test.service.resolve({
        chainId: 1,
        contractId: test.record.id,
        address: other,
      }),
    ).rejects.toMatchObject({
      code: "DYNAMIC_PROVENANCE_UNVERIFIED",
      details: {
        failures: [
          {
            factoryContractId: expect.any(String),
            code: "PROJECT_TOKEN_UNVERIFIED",
          },
        ],
      },
    });
  });
});
