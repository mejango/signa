import {
  decodeAbiParameters,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  numberToHex,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import type {
  CodeRecord,
  ContractCatalogData,
  ContractRecord,
  DeploymentRecord,
} from "../contracts/types.js";
import {
  RestError,
  type RestBlockEvidence,
  type RestRpc,
} from "../core.js";
import {
  address,
  exactObject,
  integer,
  signature,
} from "./abi.js";
import { cloneImplementation, rpcHex, verifyRuntime } from "./code.js";

export interface ProtocolCatalog {
  readonly data: ContractCatalogData;
  get(id: string): ContractRecord;
  code(id: string): CodeRecord;
}
export interface ResolveInput {
  chainId: number;
  contractId: string;
  address?: string;
  projectId?: string;
  blockNumber?: string;
}
type Snapshot = {
  evidence: RestBlockEvidence;
  tag: { blockHash: Hex; requireCanonical: true };
  signal?: AbortSignal;
  proofs: Map<string, Promise<Verified>>;
};
type RuntimeProof =
  | ReturnType<typeof verifyRuntime>
  | {
      mode: "factory-address-runtime-observed";
      runtimeCodeHash: Hex;
      runtimeByteLength: number;
      templateCodeId: string;
      verificationGap: string;
    };
type Verified = {
  contract: ContractRecord;
  deployment: DeploymentRecord | null;
  abi: Abi;
  abiHash: string;
  address: Address;
  provenance: Record<string, unknown>;
};

const same = isAddressEqual;
const expectedQuantity = (value: unknown, label: string): bigint => {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ||
    value.length > 66
  )
    throw new RestError(
      502,
      "RPC_DATA_INVALID",
      `${label} was not an Ethereum quantity.`,
    );
  return BigInt(value);
};
const hash = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new RestError(
      502,
      "RPC_DATA_INVALID",
      `${label} was not a block hash.`,
    );
  return value.toLowerCase() as Hex;
};
const objectValue = (value: unknown, field: string): unknown =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)[field]
    : undefined;

/** Local provenance proof for Signa session targets against pinned deployment evidence. */
export function createProtocolReadService({
  rpc,
  catalog,
}: {
  rpc: RestRpc;
  catalog: ProtocolCatalog;
}) {
  function contract(id: unknown): ContractRecord {
    if (typeof id !== "string" || id.length > 400)
      throw new RestError(
        400,
        "CONTRACT_ID_INVALID",
        "Use an exact catalog contract ID.",
      );
    const found = catalog.data.contracts.find((item) => item.id === id);
    if (!found)
      throw new RestError(
        404,
        "CONTRACT_NOT_FOUND",
        "The contract ID is absent from the pinned catalog.",
      );
    if (!found.executable || found.category !== "contract")
      throw new RestError(
        422,
        "CONTRACT_NOT_EXECUTABLE",
        "Interfaces, abstract contracts, libraries and scripts are reference entries, not executable destinations.",
      );
    return found;
  }
  function byName(name: string): ContractRecord {
    const matches = catalog.data.contracts.filter(
      (item) =>
        item.name === name &&
        item.category === "contract" &&
        item.executable &&
        item.deployments.some(
          (deployment) => deployment.status === "published",
        ),
    );
    if (matches.length !== 1)
      throw new RestError(
        422,
        "TRUST_ANCHOR_UNAVAILABLE",
        `Exactly one published ${name} contract is required by this provenance adapter.`,
        { matches: matches.map((item) => item.id) },
      );
    return matches[0]!;
  }
  function validateBase(input: ResolveInput) {
    if (
      !Number.isSafeInteger(input.chainId) ||
      !catalog.data.chains.some((chain) => chain.id === input.chainId)
    )
      throw new RestError(
        400,
        "CHAIN_UNSUPPORTED",
        "This chain is absent from the V6 deployment catalog.",
      );
    contract(input.contractId);
    if (input.address !== undefined) address(input.address, "address", true);
    if (
      input.projectId !== undefined &&
      integer(input.projectId, "projectId") === 0n
    )
      throw new RestError(
        400,
        "PROJECT_ID_INVALID",
        "Project ID must be positive.",
      );
    if (input.blockNumber !== undefined)
      integer(input.blockNumber, "blockNumber");
  }
  async function snapshot(
    chainId: number,
    blockNumber?: string,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    const requested =
      blockNumber === undefined
        ? "latest"
        : numberToHex(integer(blockNumber, "blockNumber"));
    const [reported, block] = await Promise.all([
      rpc.request(chainId, "eth_chainId", [], signal),
      rpc.request(chainId, "eth_getBlockByNumber", [requested, false], signal),
    ]);
    if (expectedQuantity(reported, "eth_chainId") !== BigInt(chainId))
      throw new RestError(
        502,
        "RPC_CHAIN_MISMATCH",
        "The configured RPC returned the wrong chain.",
      );
    if (!block || typeof block !== "object")
      throw new RestError(
        404,
        "BLOCK_UNAVAILABLE",
        "The requested mined block is unavailable.",
      );
    const number = expectedQuantity(
      objectValue(block, "number"),
      "block.number",
    );
    if (blockNumber !== undefined && number !== BigInt(blockNumber))
      throw new RestError(
        502,
        "RPC_BLOCK_MISMATCH",
        "The RPC returned a different block number.",
      );
    const blockHash = hash(objectValue(block, "hash"), "block.hash");
    return {
      evidence: {
        chainId,
        blockNumber: String(number),
        blockHash,
        timestamp: String(
          expectedQuantity(objectValue(block, "timestamp"), "block.timestamp"),
        ),
        source: "onchain",
      },
      tag: { blockHash, requireCanonical: true },
      ...(signal ? { signal } : {}),
      proofs: new Map(),
    };
  }
  const codeAt = async (snap: Snapshot, target: Address) =>
    rpcHex(
      await rpc.request(
        snap.evidence.chainId,
        "eth_getCode",
        [target, snap.tag],
        snap.signal,
      ),
      "eth_getCode",
    );
  function deploymentCandidates(record: ContractRecord, chainId: number) {
    return (
      record.deployments.find((item) => item.chainId === chainId)?.instances ??
      []
    );
  }
  function abiFor(record: ContractRecord, abiHash: string): Abi {
    const variant = record.variants.find((item) => item.abiHash === abiHash);
    if (!variant)
      throw new RestError(
        500,
        "CATALOG_ABI_INVALID",
        "The deployment ABI variant is missing.",
      );
    return variant.abi;
  }
  function method(
    abi: Abi,
    name: unknown,
  ): AbiFunction {
    if (typeof name !== "string" || name.length > 4096)
      throw new RestError(
        400,
        "FUNCTION_SIGNATURE_REQUIRED",
        "Use the full canonical ABI function signature.",
      );
    const candidates = abi.filter(
      (item): item is AbiFunction =>
        item.type === "function" && signature(item) === name,
    );
    if (candidates.length !== 1)
      throw new RestError(
        400,
        "FUNCTION_SIGNATURE_UNKNOWN",
        "The exact full function signature is absent or ambiguous in this deployed ABI. Bare names, selectors, events and constructors are not accepted.",
      );
    const fn = candidates[0]!;
    const read = fn.stateMutability === "view" || fn.stateMutability === "pure";
    if (!read)
      throw new RestError(
        405,
        "FUNCTION_MUTABILITY_MISMATCH",
        "Provenance verification requires read-only contract functions.",
      );
    return fn;
  }
  async function call(
    snap: Snapshot,
    target: Verified,
    fullSignature: string,
    args: readonly unknown[],
  ): Promise<readonly unknown[]> {
    const fn = method(target.abi, fullSignature);
    const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
    const result = rpcHex(
      await rpc.request(
        snap.evidence.chainId,
        "eth_call",
        [{ to: target.address, data, gas: "0x1c9c380" }, snap.tag],
        snap.signal,
      ),
      "eth_call",
    );
    try {
      return decodeAbiParameters(fn.outputs, result);
    } catch {
      throw new RestError(
        502,
        "ABI_RESPONSE_INVALID",
        "The verified contract returned data that does not decode against its exact deployment ABI.",
      );
    }
  }
  function runtimeAgainst(
    record: ContractRecord,
    chainId: number,
    code: Hex,
  ): {
    deployment: DeploymentRecord | null;
    abiHash: string;
    runtime: RuntimeProof;
    runtimeVerified: boolean;
    sources?: unknown;
  } {
    const candidates = deploymentCandidates(record, chainId);
    const failures: { code: string; templateCodeId: string }[] = [];
    const attempted = new Set<string>();
    const observed: DeploymentRecord[] = [];
    for (const deployment of candidates) {
      attempted.add(deployment.codeId);
      try {
        return {
          deployment,
          abiHash: deployment.abiHash,
          runtime: verifyRuntime(code, catalog.code(deployment.codeId)),
          runtimeVerified: true,
        };
      } catch (error) {
        if (!(error instanceof RestError) || error.status >= 500) throw error;
        failures.push({ code: error.code, templateCodeId: deployment.codeId });
        if (error.code === "RUNTIME_PROOF_UNAVAILABLE")
          observed.push(deployment);
      }
    }
    // Factories may create implementations whose addresses have no separate published deployment artifact.
    // A source-build ABI is usable here only after its exact corresponding runtime has been verified.
    for (const variant of record.variants)
      for (const codeId of variant.codeIds) {
        if (attempted.has(codeId)) continue;
        attempted.add(codeId);
        try {
          return {
            deployment: null,
            abiHash: variant.abiHash,
            runtime: verifyRuntime(code, catalog.code(codeId)),
            runtimeVerified: true,
            sources: variant.provenance,
          };
        } catch (error) {
          if (!(error instanceof RestError) || error.status >= 500) throw error;
          failures.push({ code: error.code, templateCodeId: codeId });
        }
      }
    // This function is called only after an exact clone embeds the implementation
    // selected by the official factory getter. A missing immutable mask can support
    // that address provenance, never a guess at a source-only ABI or implementation.
    if (observed.length > 0) {
      if (new Set(observed.map((item) => item.abiHash)).size !== 1)
        throw new RestError(
          422,
          "IMPLEMENTATION_ABI_AMBIGUOUS",
          "Factory provenance does not distinguish the published implementation ABI variants.",
        );
      const deployment = observed[0]!;
      return {
        deployment,
        abiHash: deployment.abiHash,
        runtimeVerified: false,
        runtime: {
          mode: "factory-address-runtime-observed",
          runtimeCodeHash: keccak256(code),
          runtimeByteLength: (code.length - 2) / 2,
          templateCodeId: deployment.codeId,
          verificationGap:
            "The exact clone implementation address is selected by the official factory at this block. Its observed runtime hash is recorded, but source-to-runtime equality is unverified because matching compiler immutable references are unavailable.",
        },
      };
    }
    if (attempted.size === 0)
      throw new RestError(
        422,
        "IMPLEMENTATION_TEMPLATE_MISSING",
        "No published or compiled runtime template exists for this factory-selected implementation.",
        { contractId: record.id, chainId },
      );
    throw new RestError(
      422,
      failures.some((item) => item.code === "RUNTIME_PROOF_UNAVAILABLE")
        ? "RUNTIME_PROOF_UNAVAILABLE"
        : "RUNTIME_CODE_MISMATCH",
      "No trusted runtime template verifies this destination.",
      { contractId: record.id, failures, runtimeCodeHash: keccak256(code) },
    );
  }
  async function official(
    snap: Snapshot,
    record: ContractRecord,
    requested?: Address,
  ): Promise<Verified> {
    const candidates = deploymentCandidates(record, snap.evidence.chainId);
    const matches = requested
      ? candidates.filter((item) => same(item.address, requested))
      : candidates.filter((item) => !item.retired);
    if (matches.length === 0)
      throw new RestError(
        422,
        "DEPLOYMENT_MISSING",
        "No matching official deployment exists on this chain.",
        { contractId: record.id, chainId: snap.evidence.chainId },
      );
    const distinct = [
      ...new Set(matches.map((item) => item.address.toLowerCase())),
    ];
    if (distinct.length !== 1)
      throw new RestError(
        400,
        "DEPLOYMENT_AMBIGUOUS",
        "Specify the destination address because this contract has multiple published instances.",
        { addresses: distinct },
      );
    const deployment = matches[0]!;
    const cacheKey = `${record.id}:${deployment.address.toLowerCase()}`;
    let proof = snap.proofs.get(cacheKey);
    if (!proof) {
      proof = (async () => {
        const code = await codeAt(snap, deployment.address);
        if (cloneImplementation(code))
          return dynamic(snap, record, deployment.address, code, deployment);
        let runtime: unknown;
        let runtimeVerified = true;
        try {
          runtime = verifyRuntime(code, catalog.code(deployment.codeId));
        } catch (error) {
          if (
            !(error instanceof RestError) ||
            error.code !== "RUNTIME_PROOF_UNAVAILABLE"
          )
            throw error;
          runtimeVerified = false;
          runtime = {
            mode: "official-address-runtime-observed",
            runtimeCodeHash: keccak256(code),
            runtimeByteLength: (code.length - 2) / 2,
            templateCodeId: deployment.codeId,
            verificationGap:
              "Official deployment address and observed code hash are established. Source-to-runtime equality is unverified because matching compiler immutable references are unavailable.",
          };
        }
        return {
          contract: record,
          deployment,
          abi: abiFor(record, deployment.abiHash),
          abiHash: deployment.abiHash,
          address: deployment.address,
          provenance: {
            kind: "published-deployment",
            contractId: record.id,
            abiHash: deployment.abiHash,
            runtimeVerified,
            runtime,
            publication: deployment,
            manifest: catalog.data.deploymentManifest,
            block: snap.evidence,
          },
        };
      })();
      snap.proofs.set(cacheKey, proof);
    }
    return proof;
  }
  async function anchor(snap: Snapshot, name: string) {
    return official(snap, byName(name));
  }
  async function uintRead(
    snap: Snapshot,
    target: Verified,
    fn: string,
    args: readonly unknown[] = [],
  ): Promise<bigint> {
    const result = (await call(snap, target, fn, args))[0];
    if (typeof result !== "bigint" && typeof result !== "number")
      throw new RestError(
        502,
        "ABI_RESPONSE_INVALID",
        "Expected a protocol integer.",
      );
    return BigInt(result);
  }
  async function addressRead(
    snap: Snapshot,
    target: Verified,
    fn: string,
    args: readonly unknown[] = [],
  ): Promise<Address> {
    return address((await call(snap, target, fn, args))[0], `result of ${fn}`);
  }
  async function dynamic(
    snap: Snapshot,
    record: ContractRecord,
    target: Address,
    code: Hex,
    published: DeploymentRecord | null = null,
  ): Promise<Verified> {
    const clone = cloneImplementation(code);
    if (!clone)
      throw new RestError(
        422,
        "TARGET_UNVERIFIED",
        "Caller-selected addresses require a recognized immutable factory clone and canonical protocol association. Arbitrary contracts and upgradeable proxies are unsupported.",
      );
    const families = record.cloneFamilies.filter(
      (family) => family.standard === clone.standard,
    );
    if (!families.length)
      throw new RestError(
        422,
        "DYNAMIC_FAMILY_UNSUPPORTED",
        "The catalog has no verified factory-clone family for this contract.",
        { contractId: record.id },
      );
    const proofFailures: { factoryContractId: string; code: string }[] = [];
    for (const family of families) {
      try {
        const factory = await official(
          snap,
          contract(family.factoryContractId),
        );
        const implementation = await addressRead(
          snap,
          factory,
          family.implementationGetter,
        );
        if (!same(implementation, clone.implementation))
          throw new RestError(
            422,
            "CLONE_IMPLEMENTATION_MISMATCH",
            "The clone does not target the factory's current immutable implementation.",
          );
        const implementationRecord = contract(family.implementationContractId);
        const implementationCode = await codeAt(snap, implementation);
        if (cloneImplementation(implementationCode))
          throw new RestError(
            422,
            "NESTED_PROXY_UNSUPPORTED",
            "A clone implementation cannot itself be a proxy.",
          );
        const verifiedRuntime = runtimeAgainst(
          implementationRecord,
          snap.evidence.chainId,
          implementationCode,
        );
        const exactAbi = abiFor(implementationRecord, verifiedRuntime.abiHash);
        // Published address provenance selects its ABI; source-only ABIs need runtime equality.
        const resolved: Verified = {
          contract: record,
          deployment: published,
          abi: exactAbi,
          abiHash: verifiedRuntime.abiHash,
          address: target,
          provenance: {},
        };
        let projectId: bigint;
        let association: Record<string, unknown>;
        if (record.name === "JBERC20") {
          projectId = await uintRead(snap, factory, "projectIdOf(address)", [
            target,
          ]);
          if (
            projectId === 0n ||
            !same(
              await addressRead(snap, factory, "tokenOf(uint256)", [projectId]),
              target,
            )
          )
            throw new RestError(
              422,
              "PROJECT_TOKEN_UNVERIFIED",
              "The canonical token registry does not associate this clone with a project.",
            );
          if (
            !same(
              await addressRead(snap, resolved, "tokens()"),
              factory.address,
            )
          )
            throw new RestError(
              422,
              "PROJECT_TOKEN_UNVERIFIED",
              "The clone's token authority is not the canonical factory.",
            );
          association = {
            kind: "project-token",
            projectId: String(projectId),
            registry: factory.provenance,
          };
        } else if (
          record.name === "JB721TiersHook" ||
          record.name === "DefifaHook"
        ) {
          const registry = await anchor(snap, "JBAddressRegistry");
          if (
            !same(
              await addressRead(snap, registry, "deployerOf(address)", [
                target,
              ]),
              factory.address,
            )
          )
            throw new RestError(
              422,
              "NFT_FACTORY_UNVERIFIED",
              "The address registry does not identify the canonical tiers factory as this clone's deployer.",
            );
          projectId = await uintRead(snap, resolved, "projectId()");
          if (projectId === 0n)
            throw new RestError(
              422,
              "PROJECT_ASSOCIATION_MISSING",
              "The tiers clone has no project association.",
            );
          association = {
            kind:
              record.name === "DefifaHook"
                ? "factory-defifa-game-hook"
                : "factory-project-nft",
            projectId: String(projectId),
            registry: registry.provenance,
            attachment:
              "Factory provenance does not imply this hook is currently attached to an active ruleset.",
          };
        } else if (record.name === "JBUniswapV4LPSplitHook") {
          const registry = await anchor(snap, "JBAddressRegistry");
          if (
            !same(
              await addressRead(snap, registry, "deployerOf(address)", [
                target,
              ]),
              factory.address,
            )
          )
            throw new RestError(
              422,
              "LP_FACTORY_UNVERIFIED",
              "The address registry does not identify the canonical LP split hook factory as this clone's deployer.",
            );
          projectId = 0n;
          association = {
            kind: "factory-lp-split-hook",
            registry: registry.provenance,
            attachment:
              "This hook can serve multiple projects. Factory provenance does not establish a project's split attachment; feeProjectId is a fee recipient, not represented project identity.",
          };
        } else if (record.name === "JB721Checkpoints") {
          const hookAddress = await addressRead(snap, resolved, "hook()");
          const tiers = byName("JB721TiersHook");
          const hook = await dynamic(
            snap,
            tiers,
            hookAddress,
            await codeAt(snap, hookAddress),
          );
          if (!same(await addressRead(snap, hook, "checkpoints()"), target))
            throw new RestError(
              422,
              "CHECKPOINTS_HOOK_UNVERIFIED",
              "The verified tiers hook does not identify this checkpoint module.",
            );
          projectId = await uintRead(snap, hook, "projectId()");
          association = {
            kind: "project-nft-checkpoints",
            projectId: String(projectId),
            hook: hook.provenance,
          };
        } else if (
          /^JB(?:Optimism|Base|Arbitrum|CCIP)Sucker$/.test(record.name)
        ) {
          if (
            (await call(snap, factory, "isSucker(address)", [target]))[0] !==
            true
          )
            throw new RestError(
              422,
              "SUCKER_FACTORY_UNVERIFIED",
              "The canonical sucker factory does not recognize this clone.",
            );
          if (
            !same(
              await addressRead(snap, resolved, "deployer()"),
              factory.address,
            )
          )
            throw new RestError(
              422,
              "SUCKER_FACTORY_UNVERIFIED",
              "The sucker's initialized deployer does not match its factory.",
            );
          projectId = await uintRead(snap, resolved, "projectId()");
          const registry = await anchor(snap, "JBSuckerRegistry");
          if (
            (
              await call(snap, registry, "isSuckerOf(uint256,address)", [
                projectId,
                target,
              ])
            )[0] !== true
          )
            throw new RestError(
              422,
              "SUCKER_PROJECT_UNVERIFIED",
              "The canonical sucker registry does not recognize this project association.",
            );
          association = {
            kind: "registered-project-sucker",
            projectId: String(projectId),
            registry: registry.provenance,
          };
        } else if (record.name === "JBProjectPayer") {
          if (
            !same(
              await addressRead(snap, resolved, "DEPLOYER()"),
              factory.address,
            )
          )
            throw new RestError(
              422,
              "PAYER_FACTORY_UNVERIFIED",
              "The project payer implementation does not restrict initialization to the canonical factory.",
            );
          projectId = await uintRead(snap, resolved, "defaultProjectId()");
          const owner = await addressRead(snap, resolved, "owner()");
          if (projectId === 0n && BigInt(owner) === 0n)
            throw new RestError(
              422,
              "PAYER_INITIALIZATION_UNPROVEN",
              "This clone has no observable initialized project or owner. Factory deployment-event evidence is required.",
            );
          association = {
            kind: "factory-initialized-project-payer",
            projectId: String(projectId),
            owner,
            routing:
              "The owner can update the default project; this is observed configuration, not project endorsement.",
          };
        } else
          throw new RestError(
            422,
            "DYNAMIC_ASSOCIATION_UNSUPPORTED",
            "This cataloged clone family has no implemented canonical association proof.",
            { contractId: record.id },
          );
        if (projectId > 0n) {
          const projects = await anchor(snap, "JBProjects");
          association.projectOwner = await addressRead(
            snap,
            projects,
            "ownerOf(uint256)",
            [projectId],
          );
          association.projectsRegistry = projects.provenance;
        }
        resolved.provenance = {
          kind: "verified-factory-clone",
          verificationLevel:
            verifiedRuntime.runtimeVerified &&
            factory.provenance.runtimeVerified === true
              ? "factory-and-implementation-runtime"
              : "factory-address-provenance",
          runtimeVerified:
            verifiedRuntime.runtimeVerified &&
            factory.provenance.runtimeVerified === true,
          ...(!verifiedRuntime.runtimeVerified ||
          factory.provenance.runtimeVerified !== true
            ? {
                verificationGap:
                  "The exact clone, official factory implementation getter and canonical association agree at this block. Source-to-runtime equality is unverified for one or more implementation/factory anchors; inspect their observed hashes and individual proof levels.",
              }
            : {}),
          contractId: record.id,
          abiHash: resolved.abiHash,
          runtimeCodeHash: keccak256(code),
          clone,
          implementation: {
            address: implementation,
            contractId: implementationRecord.id,
            runtimeVerified: verifiedRuntime.runtimeVerified,
            runtime: verifiedRuntime.runtime,
            sourceDeployment: verifiedRuntime.deployment,
            sourceBuild: verifiedRuntime.sources ?? null,
          },
          factory: factory.provenance,
          association,
          publication: published,
          block: snap.evidence,
        };
        return resolved;
      } catch (error) {
        if (!(error instanceof RestError) || error.status >= 500) throw error;
        proofFailures.push({
          factoryContractId: family.factoryContractId,
          code: error.code,
        });
      }
    }
    throw new RestError(
      422,
      "DYNAMIC_PROVENANCE_UNVERIFIED",
      "No canonical factory/project proof verifies this clone.",
      { contractId: record.id, failures: proofFailures },
    );
  }
  async function target(
    snap: Snapshot,
    input: ResolveInput,
  ): Promise<Verified> {
    const record = contract(input.contractId);
    let requested =
      input.address === undefined
        ? undefined
        : address(input.address, "address", true);
    const projectId =
      input.projectId === undefined ? undefined : BigInt(input.projectId);
    let routerRoute: { registry: Address; terminal: Address; gateway: Address | null; router: Address } | undefined;
    if (projectId !== undefined && ["JBRouterTerminal", "JBRouterTerminalGateway"].includes(record.name)) {
      const registry = await anchor(snap, "JBRouterTerminalRegistry");
      const terminal = await addressRead(snap, registry, "terminalOf(uint256)", [projectId]);
      if (BigInt(terminal) === 0n)
        throw new RestError(422, "PROJECT_COMPONENT_MISSING", "This project has no selected router terminal at the observed block.");
      const gatewayRecord = catalog.data.contracts.find((item) => item.name === "JBRouterTerminalGateway" && item.category === "contract");
      const gateway = gatewayRecord && deploymentCandidates(gatewayRecord, snap.evidence.chainId).some((item) => same(item.address, terminal))
        ? await official(snap, gatewayRecord, terminal) : undefined;
      const router = gateway ? await addressRead(snap, gateway, "ROUTER()") : terminal;
      const selected = record.name === "JBRouterTerminalGateway" ? gateway?.address : router;
      if (!selected || (requested && !same(requested, selected)))
        throw new RestError(422, "PROJECT_ROUTER_MISMATCH", "The requested contract is not on this project's registry-selected router path.");
      requested = selected;
      routerRoute = { registry: registry.address, terminal, gateway: gateway?.address ?? null, router };
    }
    if (!requested && projectId !== undefined) {
      if (record.name === "JBERC20")
        requested = await addressRead(
          snap,
          await anchor(snap, "JBTokens"),
          "tokenOf(uint256)",
          [projectId],
        );
      if (record.name === "JBController")
        requested = await addressRead(
          snap,
          await anchor(snap, "JBDirectory"),
          "controllerOf(uint256)",
          [projectId],
        );
      if (record.name === "JB721TiersHook") {
        const directory = await anchor(snap, "JBDirectory");
        const controllerAddress = await addressRead(
          snap,
          directory,
          "controllerOf(uint256)",
          [projectId],
        );
        const controller = await official(
          snap,
          byName("JBController"),
          controllerAddress,
        );
        const [ruleset, metadata] = await call(
          snap,
          controller,
          "currentRulesetOf(uint256)",
          [projectId],
        );
        const dataHook = address(
          objectValue(metadata, "dataHook"),
          "currentRuleset.dataHook",
        );
        const matchingName = catalog.data.contracts.find(
          (item) =>
            ["REVOwner", "JBOmnichainDeployer"].includes(item.name) &&
            deploymentCandidates(item, snap.evidence.chainId).some(
              (deployment) => same(deployment.address, dataHook),
            ),
        )?.name;
        if (matchingName === "REVOwner")
          requested = await addressRead(
            snap,
            await official(snap, byName(matchingName), dataHook),
            "tiered721HookOf(uint256)",
            [projectId],
          );
        else if (matchingName === "JBOmnichainDeployer") {
          const rulesetId = objectValue(ruleset, "id");
          if (typeof rulesetId !== "number" && typeof rulesetId !== "bigint")
            throw new RestError(
              502,
              "ABI_RESPONSE_INVALID",
              "Current ruleset ID is unavailable.",
            );
          requested = await addressRead(
            snap,
            await official(snap, byName(matchingName), dataHook),
            "tiered721HookOf(uint256,uint256)",
            [projectId, BigInt(rulesetId)],
          );
        } else requested = dataHook;
      }
      if (requested && BigInt(requested) === 0n)
        throw new RestError(
          422,
          "PROJECT_COMPONENT_MISSING",
          "This project has no selected contract component at the observed block.",
        );
    }
    const published = requested
      ? deploymentCandidates(record, snap.evidence.chainId).some((item) =>
          same(item.address, requested!),
        )
      : true;
    const resolved = published
      ? await official(snap, record, requested)
      : await dynamic(snap, record, requested!, await codeAt(snap, requested!));
    if (projectId !== undefined) {
      const association = objectValue(resolved.provenance, "association");
      const observedProject = objectValue(association, "projectId");
      if (
        observedProject !== undefined &&
        String(observedProject) !== String(projectId)
      )
        throw new RestError(
          422,
          "PROJECT_ASSOCIATION_MISMATCH",
          "The verified instance belongs to a different project.",
        );
      const directory = await anchor(snap, "JBDirectory");
      if (
        record.name === "JBController" &&
        !same(
          await addressRead(snap, directory, "controllerOf(uint256)", [
            projectId,
          ]),
          resolved.address,
        )
      )
        throw new RestError(
          422,
          "PROJECT_CONTROLLER_MISMATCH",
          "The project's current controller differs from the requested deployment.",
        );
      if (
        ["JBMultiTerminal", "JBRouterTerminalRegistry"].includes(record.name) || routerRoute
      ) {
        const terminals = (
          await call(snap, directory, "terminalsOf(uint256)", [projectId])
        )[0];
        if (
          !Array.isArray(terminals) ||
          !terminals.some(
            (item) =>
              typeof item === "string" &&
              same(item as Address, routerRoute?.registry ?? resolved.address),
          )
        )
          throw new RestError(
            422,
            "PROJECT_TERMINAL_MISMATCH",
            "The requested terminal is not attached to this project in the canonical directory.",
          );
      }
      const projects = await anchor(snap, "JBProjects");
      const projectOwner = await addressRead(
        snap,
        projects,
        "ownerOf(uint256)",
        [projectId],
      );
      let revnet: Record<string, unknown> | undefined;
      if (["REVDeployer", "REVLoans", "REVOwner"].includes(record.name)) {
        const deployer = await anchor(snap, "REVDeployer");
        const configurationHash = (
          await call(snap, deployer, "hashedEncodedConfigurationOf(uint256)", [
            projectId,
          ])
        )[0];
        const revOwner = await anchor(snap, "REVOwner");
        if (
          typeof configurationHash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(configurationHash) ||
          BigInt(configurationHash) === 0n ||
          !same(projectOwner, revOwner.address) ||
          !same(await addressRead(snap, deployer, "OWNER()"), revOwner.address)
        )
          throw new RestError(
            422,
            "REVNET_ASSOCIATION_UNVERIFIED",
            "The project is not a registered revnet owned by the canonical REVOwner.",
          );
        if (
          record.name === "REVLoans" &&
          !same(await addressRead(snap, deployer, "LOANS()"), resolved.address)
        )
          throw new RestError(
            422,
            "REVNET_LOANS_MISMATCH",
            "The canonical revnet deployer selects a different loans contract.",
          );
        revnet = {
          configurationHash,
          deployer: deployer.provenance,
          owner: revOwner.provenance,
        };
      }
      return {
        ...resolved,
        provenance: {
          ...resolved.provenance,
          projectContext: {
            projectId: String(projectId),
            projectOwner,
            controllerAssociationChecked: record.name === "JBController",
            terminalAssociationChecked: [
              "JBMultiTerminal",
              "JBRouterTerminalRegistry",
            ].includes(record.name) || routerRoute !== undefined,
            ...(routerRoute ? { routerRoute } : {}),
            dynamicAssociationChecked: observedProject !== undefined,
            ...(revnet ? { revnet } : {}),
          },
        },
      };
    }
    return resolved;
  }
  async function resolve(input: ResolveInput, signal?: AbortSignal) {
    exactObject(
      input,
      ["chainId", "contractId", "address", "projectId", "blockNumber"],
      "resolve",
    );
    validateBase(input);
    const snap = await snapshot(input.chainId, input.blockNumber, signal);
    const verified = await target(snap, input);
    return {
      chainId: input.chainId,
      contractId: input.contractId,
      address: verified.address,
      abiHash: verified.abiHash,
      provenance: verified.provenance,
      evidence: [snap.evidence],
    };
  }
  return { resolve, provenance: resolve };
}
