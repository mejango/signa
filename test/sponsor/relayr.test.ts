import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getContractCatalog } from "../../src/rest/contracts/catalog.js";
import type { SponsorshipChain } from "../../src/rest/sponsorship/chain.js";
import {
  FORWARDER_ABI,
  FORWARD_REQUEST_TYPES,
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
} from "../../src/rest/sponsorship/constants.js";
import { RELAYR_PAYMENT_EVENT } from "../../src/rest/sponsorship/paymentContract.js";
import type { RelayrProvider } from "../../src/rest/sponsorship/provider.js";
import type { PreparedForwardRequest, RelayrEntry } from "../../src/rest/sponsorship/types.js";
import type { RestCall } from "../../src/rest/core.js";
import {
  CREATE_TOPIC,
  PROJECTS_ABI,
  type LaneReport,
  type SponsorEvent,
} from "../../src/sponsor/chain.js";
import {
  SAFE_ABI,
  SAFE_FACTORY,
  SAFE_FALLBACK,
  SAFE_SINGLETON,
} from "../../src/safe.js";
import { readSponsorPolicy, reservationWei } from "../../src/rest/sponsorCaps.js";
import { createRelayrLane, rankPayments } from "../../src/sponsor/relayr.js";
import type { Intent } from "../../src/types.js";
import { SAFE_FACTORY_RUNTIME } from "../fixtures/safe-factory.js";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const PROJECTS = "0x2222222222222222222222222222222222222222" as Address;
const FORWARDER = "0x3333333333333333333333333333333333333333" as Address;
const TARGET = "0x4444444444444444444444444444444444444444" as Address;
const BUNDLE = "a0a555ff-4444-4111-aaaa-333333333333";
const TX_UUIDS = ["b0", "c0", "d0", "e0", "f0", "a1", "b1", "c1"].map(
  (prefix) => `${prefix}a555ff-4444-4111-aaaa-333333333333`,
);
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const PROXY_CREATION_CODE = "0x6080604052348015600f57600080fd5b50" as Hex;
const SETUP_GAS = 260_000n;
/** A receipt the node refuses to answer for, so the lane never observes it. */
const UNREADABLE = Symbol("unreadable receipt");
const NOW = 1_700_000_000_000;
const PAYMENT_DEADLINE = BigInt(NOW / 1000 + 3600);
const PAYMENT_AMOUNT = 1_000_000_000_000_000n;
const CREATION_FEE = 100_000_000_000_000n;
const BLOCK = 4_000_000n;
const BLOCK_HASH = `0x${"55".repeat(32)}` as Hex;
const GAS_USED = 21_000n;
const GAS_PRICE = 2_000_000_000n;
const PAYMENT_HASH = `0x${"ee".repeat(32)}` as Hex;
const policy = readSponsorPolicy({});
const catalog = await getContractCatalog();

const rpcUrl = (chainId: number) => `https://rpc.test/${chainId}`;
const deployHash = (chainId: number) =>
  `0x${chainId.toString(16).padStart(8, "0")}${"77".repeat(28)}` as Hex;
const setupHash = (chainId: number, index: number) =>
  `0x${chainId.toString(16).padStart(8, "0")}${index.toString(16).padStart(2, "0")}${"88".repeat(27)}` as Hex;

function safeCall(saltNonce: bigint): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "createProxyWithNonce",
    args: [
      SAFE_SINGLETON,
      encodeFunctionData({
        abi: SAFE_ABI,
        functionName: "setup",
        args: [[OWNER], 1n, zeroAddress, "0x", SAFE_FALLBACK, zeroAddress, 0n, zeroAddress],
      }),
      saltNonce,
    ],
  });
}

function intent(chainIds: number[], setupPerChain = 0): Intent {
  return {
    id: "intent-1",
    status: "undeployed",
    contentHash: `0x${"aa".repeat(32)}`,
    name: "Public goods garden",
    description: null,
    tagline: null,
    tags: [],
    logoUri: null,
    owner: null,
    publisher: signer.address,
    signature: `0x${"bb".repeat(65)}`,
    createdAt: "2026-09-21T00:00:00.000Z",
    deployments: [],
    deploys: [],
    envelope: {
      format: "juicebox.money/v1",
      deploymentVersion: "6",
      chainIds,
      deploymentCalls: chainIds.flatMap((chainId, index) => [
        ...Array.from({ length: setupPerChain }, (_, position) => ({
          chainId,
          to: SAFE_FACTORY,
          data: safeCall(BigInt(position + 1)),
        })),
        { chainId, to: TARGET, data: `0x1234567${index}` as Hex },
      ]),
      jb: { name: "Public goods garden" },
    },
  };
}

function fakeChain() {
  const prepare = vi.fn(
    async (
      _catalog: unknown,
      call: RestCall,
      account: Address,
      stepIndex: number,
      deadline: number,
    ): Promise<PreparedForwardRequest> => ({
      stepIndex,
      chainId: call.chainId,
      forwarder: FORWARDER,
      forwarderCodeHash: `0x${"11".repeat(32)}`,
      targetCodeHash: `0x${"22".repeat(32)}`,
      domain: { name: "Juicebox", version: "1", chainId: call.chainId, verifyingContract: FORWARDER },
      message: {
        from: account,
        to: call.to,
        value: call.value,
        gas: "300000",
        nonce: String(stepIndex),
        deadline: String(deadline),
        data: call.data,
      },
      evidence: {
        chainId: call.chainId,
        blockNumber: BLOCK.toString(),
        blockHash: BLOCK_HASH,
        timestamp: String(NOW / 1000),
        source: "onchain",
      },
    }),
  );
  const signed = vi.fn(
    async (
      request: PreparedForwardRequest,
      signature: Hex,
      preceding: RelayrEntry[] = [],
    ): Promise<RelayrEntry> => {
      const recovered = await recoverTypedDataAddress({
        domain: request.domain,
        types: FORWARD_REQUEST_TYPES,
        primaryType: "ForwardRequest",
        message: {
          from: request.message.from,
          to: request.message.to,
          value: BigInt(request.message.value),
          gas: BigInt(request.message.gas),
          nonce: BigInt(request.message.nonce),
          deadline: Number(request.message.deadline),
          data: request.message.data,
        },
        signature,
      });
      if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error("the forward request was not signed by the sponsor key");
      }
      const { nonce: _nonce, ...execution } = request.message;
      return {
        chain: request.chainId,
        target: request.forwarder,
        // The forwarder call the sender broadcasts, as the production chain encodes it.
        data: encodeFunctionData({
          abi: FORWARDER_ABI,
          functionName: "execute",
          args: [
            {
              ...execution,
              value: BigInt(execution.value),
              gas: BigInt(execution.gas),
              deadline: Number(execution.deadline),
              signature,
            },
          ],
        }),
        value: request.message.value,
        virtual_nonce: preceding.length,
      };
    },
  );
  return { prepare, signed, chain: { prepare, signed } as unknown as SponsorshipChain };
}

function paymentCalldata(): Hex {
  const args = encodeAbiParameters(
    [{ type: "bytes16" }, { type: "uint256" }],
    [`0x${BUNDLE.replaceAll("-", "")}`, PAYMENT_DEADLINE],
  );
  return `0x103903a7${args.slice(2)}`;
}

function fakeProvider(options: {
  chainIds: number[];
  paymentChainId: number;
  paymentChainIds?: number[];
  hashAfter: number;
  entryHash: (entry: RelayrEntry, index: number) => Hex;
  amount: bigint;
  setupPerChain: number;
  submittedForResume?: boolean;
  extraLaunch?: number;
  reversedStatus?: boolean;
  reversedQuoteIds?: boolean;
}) {
  const forwarded = (chain: number, virtualNonce = 0): RelayrEntry => ({
    chain,
    target: FORWARDER,
    data: "0x",
    value: "0",
    virtual_nonce: virtualNonce,
  });
  // A paid bundle echoes what was submitted: each chain's Safe creations, then its launch.
  let submitted: RelayrEntry[] = options.submittedForResume
    ? options.chainIds.flatMap((chain) => [
        ...Array.from({ length: options.setupPerChain }, (_, position) => ({
          chain,
          target: SAFE_FACTORY,
          data: safeCall(BigInt(position + 1)),
          value: "0",
          virtual_nonce: position,
        })),
        forwarded(chain, options.setupPerChain),
        ...(options.extraLaunch === chain ? [forwarded(chain, options.setupPerChain + 1)] : []),
      ])
    : options.chainIds.map((chain) => forwarded(chain));
  let polls = 0;
  const create = vi.fn(async (entries: RelayrEntry[]) => {
    submitted = entries;
    // The identifiers come back as a set; their order is not the submitted order.
    const ids = TX_UUIDS.slice(0, entries.length);
    return {
      bundle_uuid: BUNDLE,
      tx_uuids: options.reversedQuoteIds ? [...ids].reverse() : ids,
      payment_info: (options.paymentChainIds ?? [options.paymentChainId]).map((chain) => ({
        chain,
        target: RELAYR_PAYMENT_ADDRESS,
        token: RELAYR_NATIVE_TOKEN,
        amount: options.amount.toString(),
        calldata: paymentCalldata(),
        payment_deadline: PAYMENT_DEADLINE.toString(),
      })),
    };
  });
  const status = vi.fn(async () => {
    polls += 1;
    const ready = polls >= options.hashAfter;
    const transactions = submitted.map((entry, index) => ({
      tx_uuid: TX_UUIDS[index]!,
      request: { ...entry },
      status: ready
        ? { state: "Included", data: { hash: options.entryHash(entry, index) } }
        : { state: "Pending", data: {} },
    }));
    // The execution service does not promise submission order back.
    return {
      bundle_uuid: BUNDLE,
      transactions: options.reversedStatus ? transactions.reverse() : transactions,
    };
  });
  return {
    create,
    status,
    provider: { create, status } as unknown as RelayrProvider,
    polls: () => polls,
  };
}

function receiptLog(address: Address, topics: Hex[], data: Hex, transactionHash: Hex, index: number) {
  return {
    address,
    topics,
    data,
    blockHash: BLOCK_HASH,
    blockNumber: toHex(BLOCK - 1n),
    logIndex: toHex(index),
    transactionHash,
    transactionIndex: "0x0",
    removed: false,
  };
}

function receipt(transactionHash: Hex, to: Address, logs: unknown[], status: "0x1" | "0x0" = "0x1") {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: toHex(BLOCK - 1n),
    contractAddress: null,
    cumulativeGasUsed: toHex(GAS_USED),
    effectiveGasPrice: toHex(GAS_PRICE),
    from: signer.address,
    gasUsed: toHex(GAS_USED),
    logs,
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    to,
    transactionHash,
    transactionIndex: "0x0",
    type: "0x2",
  };
}

function paymentReceipt(amount: bigint, reverted = false) {
  if (reverted) return receipt(PAYMENT_HASH, RELAYR_PAYMENT_ADDRESS as Address, [], "0x0");
  const data =
    `0x${amount.toString(16).padStart(64, "0")}${PAYMENT_DEADLINE.toString(16).padStart(64, "0")}` as Hex;
  return receipt(
    PAYMENT_HASH,
    RELAYR_PAYMENT_ADDRESS as Address,
    [
      receiptLog(
        RELAYR_PAYMENT_ADDRESS as Address,
        [RELAYR_PAYMENT_EVENT, `0x${BUNDLE.replaceAll("-", "").padEnd(64, "0")}`],
        data,
        PAYMENT_HASH,
        0,
      ),
    ],
  );
}

function deployReceipt(transactionHash: Hex, projectId: string, reverted = false) {
  if (reverted) return receipt(transactionHash, FORWARDER, [], "0x0");
  return receipt(transactionHash, FORWARDER, [
    receiptLog(
      PROJECTS,
      [CREATE_TOPIC, toHex(BigInt(projectId), { size: 32 }), pad(signer.address, { size: 32 })],
      "0x",
      transactionHash,
      0,
    ),
  ]);
}

function block() {
  return {
    baseFeePerGas: toHex(1_000_000_000n),
    difficulty: "0x0",
    extraData: "0x",
    gasLimit: toHex(30_000_000n),
    gasUsed: "0x0",
    hash: BLOCK_HASH,
    logsBloom: `0x${"00".repeat(256)}`,
    miner: `0x${"00".repeat(20)}`,
    mixHash: `0x${"00".repeat(32)}`,
    nonce: "0x0000000000000000",
    number: toHex(BLOCK),
    parentHash: `0x${"66".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    sha3Uncles: `0x${"00".repeat(32)}`,
    size: "0x0",
    stateRoot: `0x${"00".repeat(32)}`,
    timestamp: toHex(BigInt(NOW / 1000)),
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: `0x${"00".repeat(32)}`,
    uncles: [],
  };
}

function installRpc(
  receipts: Map<string, unknown>,
  events: string[],
  balance: bigint | ((chainId: number) => bigint),
  creationFee: bigint,
  code: (address: Address) => Hex,
  setupGas: bigint,
  holdSetupReceipt: (hash: string) => Promise<void>,
) {
  const prepayments: TransactionSerializedEIP1559[] = [];
  const simulated: { from: Address; data: Hex }[] = [];
  const feeCall = encodeFunctionData({ abi: PROJECTS_ABI, functionName: "creationFee" });
  const creationCodeCall = encodeFunctionData({ abi: SAFE_ABI, functionName: "proxyCreationCode" });
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const result = await (async (): Promise<unknown> => {
      switch (method) {
        case "eth_call": {
          const call = params[0] as { to: Address; data: Hex; from?: Address };
          if (call.to === SAFE_FACTORY) {
            if (call.data === creationCodeCall) {
              return encodeAbiParameters([{ type: "bytes" }], [PROXY_CREATION_CODE]);
            }
            simulated.push({ from: call.from!, data: call.data });
            return pad(OWNER, { size: 32 });
          }
          if (call.to !== PROJECTS || call.data !== feeCall) {
            throw new Error(`unexpected eth_call to ${call.to}`);
          }
          return toHex(creationFee, { size: 32 });
        }
        case "eth_getCode":
          return code(params[0] as Address);
        case "eth_estimateGas":
          return toHex(setupGas);
        case "eth_blockNumber":
          return toHex(BLOCK);
        case "eth_getBlockByNumber":
          return block();
        case "eth_maxPriorityFeePerGas":
          return toHex(1_000_000n);
        case "eth_getTransactionCount":
          return "0x7";
        case "eth_getBalance":
          return toHex(typeof balance === "function" ? balance(Number(String(_url).split("/").pop())) : balance);
        case "eth_sendRawTransaction":
          events.push("prepayment");
          prepayments.push(params[0] as TransactionSerializedEIP1559);
          return PAYMENT_HASH;
        case "eth_getTransactionReceipt": {
          const hash = String(params[0]).toLowerCase();
          await holdSetupReceipt(hash);
          const stored = receipts.get(hash);
          if (stored === UNREADABLE) throw new Error("the receipt could not be read");
          return stored ?? null;
        }
        default:
          throw new Error(`unexpected RPC method ${method}`);
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return { prepayments, simulated };
}

/** Answers a Safe creation receipt only once `atOnce` of them are waiting together, so a
 * lane that observes them one after another never gets past the first. */
function receiptGate(setupHashes: ReadonlySet<string>, atOnce?: number) {
  if (!atOnce) return async () => {};
  const waiting = new Set<string>();
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async (hash: string) => {
    if (!setupHashes.has(hash)) return;
    waiting.add(hash);
    if (waiting.size >= atOnce) open();
    await opened;
  };
}

function harness(options: {
  chainIds: number[];
  paymentChainId: number;
  paymentChainIds?: number[];
  hashAfter: number;
  projectIds: string[];
  amount?: bigint;
  revertedChains?: number[];
  revertedPayment?: boolean;
  balance?: bigint | ((chainId: number) => bigint);
  creationFee?: bigint;
  setupPerChain?: number;
  setupGas?: bigint;
  code?: (address: Address) => Hex;
  submittedForResume?: boolean;
  extraLaunch?: number;
  revertedSetups?: boolean;
  missingSetupReceipts?: boolean;
  /** Hold every Safe creation receipt until this many of them are asked for at once. */
  setupReceiptsAtOnce?: number;
  reversedStatus?: boolean;
  reversedQuoteIds?: boolean;
}) {
  const amount = options.amount ?? PAYMENT_AMOUNT;
  const setupPerChain = options.setupPerChain ?? 0;
  const hashes = new Map(options.chainIds.map((chainId) => [chainId, deployHash(chainId)]));
  const receipts = new Map<string, unknown>([
    [PAYMENT_HASH, paymentReceipt(amount, options.revertedPayment)],
  ]);
  options.chainIds.forEach((chainId, index) =>
    receipts.set(
      hashes.get(chainId)!,
      deployReceipt(
        hashes.get(chainId)!,
        options.projectIds[index]!,
        options.revertedChains?.includes(chainId),
      ),
    ),
  );
  // A Safe creation lands in its own transaction, which carries no Create event.
  const setupHashes = new Set<string>();
  for (const chainId of options.chainIds) {
    for (let index = 0; index < TX_UUIDS.length; index += 1) {
      const hash = setupHash(chainId, index);
      setupHashes.add(hash.toLowerCase());
      receipts.set(
        hash,
        options.missingSetupReceipts
          ? UNREADABLE
          : receipt(hash, SAFE_FACTORY, [], options.revertedSetups ? "0x0" : "0x1"),
      );
    }
  }
  const holdSetupReceipt = receiptGate(setupHashes, options.setupReceiptsAtOnce);
  const entryHash = (entry: RelayrEntry, index: number) =>
    entry.target === SAFE_FACTORY ? setupHash(entry.chain, index) : deployHash(entry.chain);
  const events: string[] = [];
  const code =
    options.code ?? ((address: Address) => (address === SAFE_FACTORY ? SAFE_FACTORY_RUNTIME : "0x"));
  const { prepayments, simulated } = installRpc(
    receipts,
    events,
    options.balance ?? 10n ** 18n,
    options.creationFee ?? CREATION_FEE,
    code,
    options.setupGas ?? SETUP_GAS,
    holdSetupReceipt,
  );
  const chain = fakeChain();
  const chainFactory = vi.fn(() => chain.chain);
  const provider = fakeProvider({
    chainIds: options.chainIds,
    paymentChainId: options.paymentChainId,
    ...(options.paymentChainIds ? { paymentChainIds: options.paymentChainIds } : {}),
    hashAfter: options.hashAfter,
    entryHash,
    amount,
    setupPerChain,
    ...(options.submittedForResume ? { submittedForResume: true } : {}),
    ...(options.extraLaunch === undefined ? {} : { extraLaunch: options.extraLaunch }),
    ...(options.reversedStatus ? { reversedStatus: true } : {}),
    ...(options.reversedQuoteIds ? { reversedQuoteIds: true } : {}),
  });
  const report = {
    bundle: vi.fn(async () => {
      events.push("bundle");
    }),
    paid: vi.fn(async () => {
      events.push("paid");
    }),
    sent: vi.fn(async () => {}),
    confirmed: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
    deferred: vi.fn(async () => {}),
  } satisfies LaneReport;
  const waits: number[] = [];
  let clock = NOW;
  const laneEvents: SponsorEvent[] = [];
  const lane = createRelayrLane({
    onEvent: (event) => laneEvents.push(event),
    chain: chainFactory,
    catalog,
    provider: provider.provider,
    rpcUrls: new Map(options.chainIds.map((chainId) => [chainId, rpcUrl(chainId)])),
    signer,
    policy,
    projectsAddress: PROJECTS,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  return {
    amount, chain, chainFactory, events, hashes, lane, laneEvents, prepayments, provider, report,
    simulated, waits,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayr sponsorship lane", () => {
  test("signs forward requests with the sponsor key, prepays, polls and reports on mainnets", async () => {
    const chainIds = [8453, 10];
    const { amount, chain, events, hashes, lane, laneEvents, prepayments, provider, report, waits } =
      harness({
        chainIds,
        // The lane polls once to bind the bundle's identifiers, then twice to settle it.
        hashAfter: 3,
        paymentChainId: 8453,
        projectIds: ["12", "3"],
      });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(report.failed).not.toHaveBeenCalled();
    expect(events).toEqual(["bundle", "prepayment", "paid"]);
    expect(report.bundle).toHaveBeenCalledWith(BUNDLE);
    expect(waits).toEqual([5_000]);
    expect(chain.prepare).toHaveBeenCalledTimes(2);
    expect(chain.signed).toHaveBeenCalledTimes(2);
    expect(chain.prepare.mock.calls[0]![1]).toMatchObject({
      chainId: 8453,
      to: TARGET,
      value: CREATION_FEE.toString(),
      label: "intent-deploy",
      dependsOn: [],
    });
    expect(chain.prepare.mock.calls[0]![2]).toBe(signer.address);
    expect(provider.create.mock.calls[0]![0].map((entry) => entry.chain)).toEqual(chainIds);
    expect(provider.polls()).toBe(3);

    expect(prepayments).toHaveLength(1);
    const prepayment = parseTransaction(prepayments[0]!);
    expect(prepayment).toMatchObject({
      chainId: 8453,
      to: RELAYR_PAYMENT_ADDRESS,
      value: amount,
      gas: 150_000n,
      nonce: 7,
      maxFeePerGas: policy.maximumFeePerGas,
      maxPriorityFeePerGas: 1_000_000n,
    });
    await expect(recoverTransactionAddress({ serializedTransaction: prepayments[0]! })).resolves.toBe(
      signer.address,
    );

    expect(report.sent).toHaveBeenCalledWith(8453, hashes.get(8453), BUNDLE);
    expect(report.sent).toHaveBeenCalledWith(10, hashes.get(10), BUNDLE);
    expect(report.paid).toHaveBeenCalledWith(8453, GAS_USED * GAS_PRICE + amount);
    expect(report.confirmed).toHaveBeenCalledWith(8453, hashes.get(8453), "12");
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3");
    expect(laneEvents).toEqual([
      { event: "bundle", intentId: "intent-1", bundleUuid: BUNDLE, chainIds, paymentChainId: 8453, offeredPaymentChainIds: [8453] },
      {
        event: "payment",
        intentId: "intent-1",
        chainId: 8453,
        transactionHash: PAYMENT_HASH,
        wei: (GAS_USED * GAS_PRICE + amount).toString(),
      },
      { event: "sent", intentId: "intent-1", chainId: 8453, transactionHash: hashes.get(8453) },
      { event: "sent", intentId: "intent-1", chainId: 10, transactionHash: hashes.get(10) },
      { event: "confirmed", intentId: "intent-1", chainId: 8453, projectId: "12" },
      { event: "confirmed", intentId: "intent-1", chainId: 10, projectId: "3" },
    ]);
  });

  test("uses the testnet payment family for testnet deployments", async () => {
    const chainIds = [84532, 11155420];
    const { amount, hashes, lane, prepayments, report } = harness({
      chainIds,
      paymentChainId: 84532,
      hashAfter: 1,
      projectIds: ["8", "9"],
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(report.failed).not.toHaveBeenCalled();
    expect(prepayments).toHaveLength(1);
    expect(parseTransaction(prepayments[0]!)).toMatchObject({ chainId: 84532, value: amount });
    expect(report.sent).toHaveBeenCalledWith(84532, hashes.get(84532), BUNDLE);
    expect(report.paid).toHaveBeenCalledWith(84532, GAS_USED * GAS_PRICE + amount);
    expect(report.confirmed).toHaveBeenCalledWith(84532, hashes.get(84532), "8");
    expect(report.confirmed).toHaveBeenCalledWith(11155420, hashes.get(11155420), "9");
  });

  test("fails only the chain whose relayed deployment reverted", async () => {
    const chainIds = [8453, 10];
    const { amount, hashes, lane, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      revertedChains: [8453],
    });


    await lane.deploy(intent(chainIds), chainIds, report);

    expect(report.sent).toHaveBeenCalledTimes(2);
    expect(report.failed).toHaveBeenCalledTimes(1);
    expect(report.failed).toHaveBeenCalledWith(8453, "the relayed deployment reverted");
    expect(report.confirmed).toHaveBeenCalledTimes(1);
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3");
    // The prepayment is charged when it settles, not to whichever chain survives.
    expect(report.paid).toHaveBeenCalledWith(8453, GAS_USED * GAS_PRICE + amount);
  });

  test("resume follows an already paid bundle without paying again", async () => {
    const chainIds = [8453, 10];
    const { hashes, lane, prepayments, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
    });

    await lane.resume(intent(chainIds), chainIds, BUNDLE, report);

    expect(provider.create).not.toHaveBeenCalled();
    expect(prepayments).toHaveLength(0);
    expect(report.failed).not.toHaveBeenCalled();
    expect(report.paid).not.toHaveBeenCalled();
    expect(report.sent).toHaveBeenCalledWith(8453, hashes.get(8453), BUNDLE);
    expect(report.confirmed).toHaveBeenCalledWith(8453, hashes.get(8453), "12");
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3");
  });

  test("binds identifiers the service returns out of submitted order to the calls they name", async () => {
    const chainIds = [8453, 10];
    const { hashes, lane, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      setupPerChain: 1,
      reversedQuoteIds: true,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    expect(report.failed).not.toHaveBeenCalled();
    expect(report.sent).toHaveBeenCalledWith(8453, hashes.get(8453), BUNDLE);
    expect(report.sent).toHaveBeenCalledWith(10, hashes.get(10), BUNDLE);
    expect(report.confirmed).toHaveBeenCalledWith(8453, hashes.get(8453), "12");
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3");
  });

  test("raises a timeout, retiring nothing, when relayr has not executed the bundle yet", async () => {
    const chainIds = [8453, 10];
    const { lane, provider, report, waits } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: Number.POSITIVE_INFINITY,
      projectIds: ["12", "3"],
    });

    // The bundle was paid for, so the poll limit ends this pass, not the bundle.
    await expect(lane.resume(intent(chainIds), chainIds, BUNDLE, report)).rejects.toMatchObject({
      code: "RELAYR_TIMEOUT",
      message: "relayr did not execute the bundle in time",
    });

    expect(waits).toHaveLength(181);
    expect(provider.status).toHaveBeenCalledTimes(181);
    expect(report.sent).not.toHaveBeenCalled();
    expect(report.confirmed).not.toHaveBeenCalled();
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("fails every chain when the prepayment reverts", async () => {
    const chainIds = [8453, 10];
    const { lane, prepayments, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      revertedPayment: true,
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(prepayments).toHaveLength(1);
    expect(report.sent).not.toHaveBeenCalled();
    expect(report.failed).toHaveBeenCalledWith(8453, "the prepayment reverted");
    expect(report.failed).toHaveBeenCalledWith(10, "the prepayment reverted");
  });

  test("raises the quote refusal to the worker and sends nothing", async () => {
    const chainIds = [8453, 10];
    const { lane, prepayments, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      amount: reservationWei(policy, chainIds.length) + 1n,
    });

    // The worker classifies the failure and owns what happens to the rows.
    await expect(lane.deploy(intent(chainIds), chainIds, report)).rejects.toMatchObject({
      code: "RELAYR_FUNDING_LIMIT",
    });

    expect(prepayments).toHaveLength(0);
    expect(report.sent).not.toHaveBeenCalled();
    expect(report.confirmed).not.toHaveBeenCalled();
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("refuses to simulate a chain where the sponsor cannot cover the creation fee", async () => {
    const chainIds = [8453, 10];
    const { chain, lane, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      balance: (chainId) => (chainId === 10 ? CREATION_FEE - 1n : 10n ** 18n),
    });

    await expect(lane.deploy(intent(chainIds), chainIds, report)).rejects.toMatchObject({
      code: "SPONSOR_UNFUNDED",
      message: "sponsor holds less than the creation fee on chain 10 by 1 wei",
    });

    // The funded chain was prepared; the simulation the empty chain would reject never ran.
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
    expect(report.failed).not.toHaveBeenCalled();
    expect(report.deferred).not.toHaveBeenCalled();
  });

  test("prepares every chain whose balance covers the creation fee exactly", async () => {
    const chainIds = [8453, 10];
    const { chain, lane, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      balance: (chainId) => (chainId === 10 ? CREATION_FEE : 10n ** 18n),
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(chain.prepare).toHaveBeenCalledTimes(2);
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("leaves every chain queued when the sponsor cannot cover the prepayment", async () => {
    const chainIds = [8453, 10];
    const { lane, laneEvents, prepayments, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      balance: PAYMENT_AMOUNT,
    });

    // Nothing was submitted, so the rows wait with the code and the worker says why.
    await expect(lane.deploy(intent(chainIds), chainIds, report)).rejects.toMatchObject({
      code: "SPONSOR_UNFUNDED",
      message: expect.stringMatching(/^sponsor holds less than the prepayment on chain 8453 by \d+ wei$/),
    });

    expect(prepayments).toHaveLength(0);
    expect(report.bundle).not.toHaveBeenCalled();
    expect(report.failed).not.toHaveBeenCalled();
    expect(report.deferred).not.toHaveBeenCalled();
    expect(laneEvents).toEqual([]);
  });

  test("puts each chain's Safe creation in the bundle before its launch", async () => {
    const chainIds = [8453, 10];
    const { chain, lane, provider, report, simulated } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      setupPerChain: 1,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    const entries = provider.create.mock.calls[0]![0];
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.chain)).toEqual([8453, 8453, 10, 10]);
    expect(entries[0]).toEqual({
      chain: 8453,
      target: SAFE_FACTORY,
      data: safeCall(1n),
      value: "0",
      virtual_nonce: 0,
    });
    // Every entry is numbered, so each chain's creation is sent before its launch.
    expect(entries.map((entry) => entry.virtual_nonce)).toEqual([0, 1, 0, 1]);
    // The forward request is untouched: the launch is signed with no preceding entries,
    // and only the bundle position it carries is set.
    expect(chain.signed.mock.calls.map((call) => call.length)).toEqual([2, 2]);
    const launch = await chain.signed.mock.results[0]!.value;
    expect(launch).toMatchObject({ target: FORWARDER, virtual_nonce: 0 });
    expect(entries[1]).toEqual({ ...launch, virtual_nonce: 1 });
    // The creation is simulated from the sponsor, and only the launch is forwarded.
    expect(simulated).toEqual([
      { from: signer.address, data: safeCall(1n) },
      { from: signer.address, data: safeCall(1n) },
    ]);
    expect(chain.prepare).toHaveBeenCalledTimes(2);
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("fails every chain when a Safe creation needs more gas than the sponsor cap", async () => {
    const chainIds = [8453];
    const { lane, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
      setupGas: policy.maximumGas + 1n,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    expect(provider.create).not.toHaveBeenCalled();
    expect(report.failed).toHaveBeenCalledWith(8453, "setup gas above the sponsor cap");
  });

  test("refuses to pay a factory whose runtime is not canonical", async () => {
    const chainIds = [8453];
    const { lane, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
      code: () => "0x6001",
    });

    await expect(lane.deploy(intent(chainIds, 1), chainIds, report)).rejects.toMatchObject({
      code: "SAFE_FACTORY_UNAVAILABLE",
    });
    expect(provider.create).not.toHaveBeenCalled();
  });

  test("reports sent and confirmed on the launch hash while a chain also creates a Safe", async () => {
    const chainIds = [8453, 10];
    const { hashes, lane, laneEvents, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      setupPerChain: 1,
      reversedStatus: true,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    expect(report.sent).toHaveBeenCalledTimes(2);
    expect(report.sent).toHaveBeenCalledWith(8453, hashes.get(8453), BUNDLE);
    expect(report.sent).toHaveBeenCalledWith(10, hashes.get(10), BUNDLE);
    expect(report.confirmed).toHaveBeenCalledWith(8453, hashes.get(8453), "12");
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3");
    expect(laneEvents.filter((event) => event.event === "sent")).toHaveLength(2);
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("resume reads the launch hash of a bundle that also created Safes", async () => {
    const chainIds = [8453, 10];
    const { hashes, lane, prepayments, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      setupPerChain: 2,
      submittedForResume: true,
      reversedStatus: true,
    });

    await lane.resume(intent(chainIds, 2), chainIds, BUNDLE, report);

    expect(provider.create).not.toHaveBeenCalled();
    expect(prepayments).toHaveLength(0);
    expect(report.sent).toHaveBeenCalledTimes(2);
    expect(report.sent).toHaveBeenCalledWith(8453, hashes.get(8453), BUNDLE);
    expect(report.confirmed).toHaveBeenCalledWith(10, hashes.get(10), "3");
  });

  test("resume refuses a bundle that carries two launches for one chain", async () => {
    const chainIds = [8453];
    const { lane, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
      submittedForResume: true,
      extraLaunch: 8453,
    });

    await expect(lane.resume(intent(chainIds, 1), chainIds, BUNDLE, report)).rejects.toMatchObject({
      code: "RELAYR_INVALID_STATUS",
    });
    expect(report.confirmed).not.toHaveBeenCalled();
  });

  test("skips the Safe a chain already has and keeps the launch", async () => {
    const chainIds = [8453];
    const { lane, laneEvents, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
      // Every address but the factory answers with code, so the predicted Safe exists.
      code: () => SAFE_FACTORY_RUNTIME,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    const entries = provider.create.mock.calls[0]![0];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ target: FORWARDER, virtual_nonce: 0 });
    expect(laneEvents).toContainEqual(
      expect.objectContaining({ event: "setup_skipped", chainId: 8453, index: 0 }),
    );
    expect(report.confirmed).toHaveBeenCalledTimes(1);
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("logs a reverted Safe creation and still confirms the chain", async () => {
    const chainIds = [8453];
    const { hashes, lane, laneEvents, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
      revertedSetups: true,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    expect(laneEvents).toContainEqual({
      event: "setup_reverted",
      intentId: "intent-1",
      chainId: 8453,
      index: 0,
      transactionHash: setupHash(8453, 0),
    });
    expect(report.failed).not.toHaveBeenCalled();
    expect(report.confirmed).toHaveBeenCalledWith(8453, hashes.get(8453), "12");
  });

  test("observes every Safe creation receipt at the same time", async () => {
    const chainIds = [8453, 10];
    const { lane, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 2,
      projectIds: ["12", "3"],
      setupPerChain: 1,
      setupReceiptsAtOnce: 2,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    expect(report.confirmed).toHaveBeenCalledTimes(2);
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("logs a Safe creation whose receipt never arrives without failing the chain", async () => {
    const chainIds = [8453];
    const { hashes, lane, laneEvents, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
      missingSetupReceipts: true,
    });

    await lane.deploy(intent(chainIds, 1), chainIds, report);

    expect(laneEvents).toContainEqual(
      expect.objectContaining({ event: "setup_unobserved", chainId: 8453, index: 0 }),
    );
    expect(report.confirmed).toHaveBeenCalledWith(8453, hashes.get(8453), "12");
    expect(report.failed).not.toHaveBeenCalled();
  });

  test("fails every chain when the creation fee is above the sponsor ceiling", async () => {
    const chainIds = [8453, 10];
    const { lane, provider, report } = harness({
      chainIds,
      paymentChainId: 8453,
      hashAfter: 1,
      projectIds: ["12", "3"],
      creationFee: CREATION_FEE + 1n,
    });

    await lane.deploy(intent(chainIds), chainIds, report);

    expect(provider.create).not.toHaveBeenCalled();
    expect(report.failed).toHaveBeenCalledWith(8453, "creation fee above the sponsor ceiling");
    expect(report.failed).toHaveBeenCalledWith(10, "creation fee above the sponsor ceiling");
  });

  test("signs a forward request for a chain nobody pays Center to deploy", async () => {
    const { chain, lane, laneEvents, provider, report } = harness({
      chainIds: [1],
      paymentChainId: 1,
      hashAfter: 1,
      projectIds: ["12"],
    });

    const request = await lane.relay(intent([1]), 1);

    expect(request).toMatchObject({
      chainId: 1,
      to: FORWARDER,
      value: CREATION_FEE.toString(),
      gas: "404761",
      deadline: NOW / 1000 + 1800,
      setup: [],
    });
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(chain.prepare.mock.calls[0]![1]).toMatchObject({
      chainId: 1,
      to: TARGET,
      value: CREATION_FEE.toString(),
      label: "intent-relay",
      dependsOn: [],
    });
    expect(chain.prepare.mock.calls[0]![2]).toBe(signer.address);
    expect(chain.prepare.mock.calls[0]![3]).toBe(0);
    expect(chain.signed).toHaveBeenCalledTimes(1);
    expect(chain.signed.mock.calls[0]![2]).toBeUndefined();
    // Nothing is bundled, paid for or reported: the visitor sends the transaction.
    expect(provider.create).not.toHaveBeenCalled();
    expect(report.bundle).not.toHaveBeenCalled();
    expect(report.sent).not.toHaveBeenCalled();
    expect(laneEvents).toEqual([
      { event: "relay", intentId: "intent-1", chainId: 1, deadline: NOW / 1000 + 1800 },
    ]);
  });

  test("signs the prepared request and hands back the forwarder call that executes it", async () => {
    const { chain, lane } = harness({
      chainIds: [1],
      paymentChainId: 1,
      hashAfter: 1,
      projectIds: ["12"],
    });
    const signTypedData = vi.spyOn(signer, "signTypedData");

    const request = await lane.relay(intent([1]), 1);

    const prepared: PreparedForwardRequest = await chain.prepare.mock.results[0]!.value;
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData.mock.calls[0]![0]).toEqual({
      domain: prepared.domain,
      types: FORWARD_REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: {
        from: prepared.message.from,
        to: prepared.message.to,
        value: BigInt(prepared.message.value),
        gas: BigInt(prepared.message.gas),
        nonce: BigInt(prepared.message.nonce),
        deadline: Number(prepared.message.deadline),
        data: prepared.message.data,
      },
    });
    const signature = await signTypedData.mock.results[0]!.value;
    const executed = decodeFunctionData({ abi: FORWARDER_ABI, data: request.data as Hex });
    expect(executed.functionName).toBe("execute");
    expect(executed.args[0]).toEqual({
      from: prepared.message.from,
      to: prepared.message.to,
      value: BigInt(prepared.message.value),
      gas: BigInt(prepared.message.gas),
      deadline: Number(prepared.message.deadline),
      data: prepared.message.data,
      signature,
    });
    signTypedData.mockRestore();
  });

  test("returns the Safe creations of a relayed chain as plain calls, without the ones that exist", async () => {
    const { lane } = harness({
      chainIds: [1],
      paymentChainId: 1,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
    });

    await expect(lane.relay(intent([1], 1), 1)).resolves.toMatchObject({
      to: FORWARDER,
      setup: [{ to: SAFE_FACTORY, data: safeCall(1n), value: "0" }],
    });

    const existing = harness({
      chainIds: [1],
      paymentChainId: 1,
      hashAfter: 1,
      projectIds: ["12"],
      setupPerChain: 1,
      // Every address answers with the factory runtime, so the predicted Safe already exists.
      code: () => SAFE_FACTORY_RUNTIME,
    });
    await expect(existing.lane.relay(intent([1], 1), 1)).resolves.toMatchObject({ setup: [] });
  });

  test("refuses to prepare a relay the sponsor cannot simulate", async () => {
    const unfunded = harness({
      chainIds: [1],
      paymentChainId: 1,
      hashAfter: 1,
      projectIds: ["12"],
      balance: () => CREATION_FEE - 1n,
    });
    await expect(unfunded.lane.relay(intent([1]), 1)).rejects.toMatchObject({
      code: "SPONSOR_UNFUNDED",
      message: "sponsor holds less than the creation fee on chain 1 by 1 wei",
    });
    expect(unfunded.chain.prepare).not.toHaveBeenCalled();

    const unconfigured = harness({
      chainIds: [1],
      paymentChainId: 1,
      hashAfter: 1,
      projectIds: ["12"],
    });
    await expect(unconfigured.lane.relay(intent([1, 10]), 10)).rejects.toMatchObject({
      code: "CHAIN_UNCONFIGURED",
    });
  });
});

describe("payment chain choice", () => {
  test("pays on a rollup when Relayr also offers the L1 testnet", async () => {
    const chainIds = [84532, 11155420];
    const { chain, lane, laneEvents, prepayments, report } = harness({
      chainIds,
      paymentChainId: 11155111,
      paymentChainIds: [11155111, 84532],
      hashAfter: 1,
      projectIds: ["4", "5"],
    });
    await lane.deploy(intent(chainIds), chainIds, report);
    expect(chain.prepare).toHaveBeenCalledTimes(2);
    expect(prepayments).toHaveLength(1);
    expect(parseTransaction(prepayments[0]!).chainId).toBe(84532);
    const bundle = laneEvents.find((event) => event.event === "bundle");
    expect(bundle).toMatchObject({ paymentChainId: 84532, offeredPaymentChainIds: [11155111, 84532] });
  });

  test("rankPayments lists configured rollups before the L1 option", () => {
    const rpcUrls = new Map([[11155111, "http://l1"], [84532, "http://base"], [11155420, "http://op"]]);
    expect(rankPayments([{ chainId: 11155111 }, { chainId: 84532 }], rpcUrls).map((o) => o.chainId)).toEqual([84532, 11155111]);
    expect(rankPayments([{ chainId: 11155111 }], rpcUrls).map((o) => o.chainId)).toEqual([11155111]);
    expect(rankPayments([{ chainId: 421614 }], rpcUrls)).toEqual([]);
    expect(rankPayments([{ chainId: 1 }, { chainId: 10 }], new Map([[1, "http://eth"], [10, "http://op"]])).map((o) => o.chainId)).toEqual([10, 1]);
  });

  test("skips an offered rollup where the key is empty and pays from the funded one", async () => {
    const chainIds = [84532, 11155420];
    const { lane, laneEvents, prepayments, report } = harness({
      chainIds,
      paymentChainId: 11155111,
      paymentChainIds: [11155111, 421614, 84532],
      hashAfter: 1,
      projectIds: ["4", "5"],
      balance: (chainId) => (chainId === 421614 ? 0n : 10n ** 18n),
    });
    await lane.deploy(intent(chainIds), chainIds, report);
    expect(report.deferred).not.toHaveBeenCalled();
    expect(prepayments).toHaveLength(1);
    expect(parseTransaction(prepayments[0]!).chainId).toBe(84532);
    expect(laneEvents.find((event) => event.event === "bundle")).toMatchObject({ paymentChainId: 84532 });
  });

  test("every deploy gets its own sponsorship chain", async () => {
    const chainIds = [8453];
    const { chainFactory, lane, report } = harness({ chainIds, paymentChainId: 8453, hashAfter: 1, projectIds: ["9"] });
    await lane.deploy(intent(chainIds), chainIds, report);
    await lane.deploy(intent(chainIds), chainIds, report);
    expect(chainFactory).toHaveBeenCalledTimes(2);
  });
});
