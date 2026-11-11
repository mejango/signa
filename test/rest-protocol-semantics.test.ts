import { beforeAll, describe, expect, it, vi } from "vitest";
import * as operationEvidence from "@bananapus/nana-sdk-core/v6/operation-evidence";
import type {
  V6OperationDraft,
  V6OperationReceipt as OperationReceipt,
} from "@bananapus/nana-sdk-core/v6/operation-evidence";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  zeroHash,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import {
  getContractCatalog,
  type ContractCatalog,
} from "../src/rest/contracts/catalog.js";
import { createProtocolSemanticVerifier } from "../src/rest/protocol/semantics.js";
import type {
  StoredPlan,
  StoredReceipt,
} from "../src/rest/transactions/types.js";
import type { RestCall, RestPlanDraft, RestRpc } from "../src/rest/core.js";
vi.mock("@bananapus/nana-sdk-core/v6/operation-evidence", { spy: true });

type PlanDraft = Omit<RestPlanDraft, "calls" | "project"> & {
  project?: NonNullable<V6OperationDraft["project"]>;
  calls: (RestCall & V6OperationDraft["calls"][number])[];
};

const account = "0x1111111111111111111111111111111111111111" as const;
const token = "0x2222222222222222222222222222222222222222" as const;
const transactionHash = `0x${"ab".repeat(32)}` as Hex;
const blockHash = `0x${"cd".repeat(32)}` as Hex;
const rpc: RestRpc = {
  request: vi.fn(async () => {
    throw new Error("Semantic evidence must not perform RPC");
  }),
};
const verifier = createProtocolSemanticVerifier();
let catalog: ContractCatalog;
beforeAll(async () => {
  catalog = await getContractCatalog();
});
const contract = (name: string) =>
  catalog.data.contracts.find(
    (item) => item.name === name && item.category === "contract",
  )!;
const deployed = (name: string) =>
  contract(name).deployments.find((item) => item.chainId === 1)!.instances[0]!
    .address;
function draft(
  functionName = "pay",
  args: readonly unknown[] = [7n, token, 100n, account, 5n, "", "0x"],
): PlanDraft {
  return {
    operation: functionName,
    account,
    project: { chainId: 1, projectId: "7", version: 6 },
    calls: [
      {
        chainId: 1,
        to: deployed("JBMultiTerminal"),
        data: encodeFunctionData({
          abi: contract("JBMultiTerminal").abi,
          functionName,
          args,
        }),
        value: "0",
        label: functionName,
        dependsOn: [],
        decoded: {
          functionName,
          args: args.map((arg) =>
            typeof arg === "bigint" ? String(arg) : arg,
          ),
        },
      },
    ],
    evidence: [
      {
        chainId: 1,
        blockNumber: "99",
        blockHash: zeroHash,
        timestamp: "1",
        source: "onchain",
      },
    ],
    summary: {},
    warnings: [],
  };
}
function stored(draft: PlanDraft): StoredPlan {
  return {
    id: "fixture",
    actor: { accountId: "fixture", principalId: "fixture" },
    commitment: zeroHash,
    createdAt: 1,
    expiresAt: 10000,
    revision: 0,
    steps: [{ index: 0, state: "confirmed" }],
    draft: {
      ...draft,
      evidence: draft.evidence.map((item) => ({ ...item, source: "onchain" })),
    },
  };
}
function log(
  name: string,
  eventName: string,
  args: Record<string, unknown>,
  logIndex = 0,
): OperationReceipt["logs"][number] {
  const event = contract(name).abi.find(
    (entry): entry is AbiEvent =>
      entry.type === "event" && entry.name === eventName,
  )!;
  return {
    address: deployed(name),
    data: encodeAbiParameters(
      event.inputs.filter((input) => !input.indexed),
      event.inputs
        .filter((input) => !input.indexed)
        .map((input) => args[input.name!]),
    ),
    topics: encodeEventTopics({
      abi: [event],
      eventName,
      args,
    }) as OperationReceipt["logs"][number]["topics"],
    logIndex,
    transactionIndex: 0,
    removed: false,
    transactionHash,
    blockHash,
    blockNumber: 100n,
  };
}
function receipt(logs: OperationReceipt["logs"]): StoredReceipt {
  return {
    transactionHash,
    blockHash,
    blockNumber: "100",
    status: "success",
    confirmations: 2,
    canonical: true,
    observedAt: 1,
    logs: logs.map((entry) => ({
      ...entry,
      blockNumber: "0x64",
      logIndex: `0x${entry.logIndex!.toString(16)}`,
      transactionIndex: "0x0",
    })),
  };
}
function payLog(overrides: Record<string, unknown> = {}) {
  return log("JBMultiTerminal", "Pay", {
    rulesetId: 1n,
    rulesetCycleNumber: 1n,
    projectId: 7n,
    payer: account,
    beneficiary: account,
    amount: 100n,
    newlyIssuedTokenCount: 10n,
    memo: "",
    metadata: "0x",
    caller: account,
    ...overrides,
  });
}
async function compare(plan: PlanDraft, logs: OperationReceipt["logs"]) {
  const direct = operationEvidence.verifyV6OperationEvidence(plan, 0, {
    transactionHash,
    blockHash,
    blockNumber: 100n,
    status: "success",
    logs,
  });
  const result = await verifier.verify(stored(plan), 0, receipt(logs), rpc);
  expect(result.status).toBe(direct.verified ? "verified" : "unknown");
  expect(result.details).toMatchObject({
    events: direct.events,
    ...(direct.reason ? { reason: direct.reason } : {}),
  });
  return result;
}
describe("REST modeled semantic evidence", () => {
  it("reuses the SDK payment proof and rejects a mismatched project identity", async () => {
    expect((await compare(draft(), [payLog()])).status).toBe("verified");
    expect((await compare(draft(), [payLog({ projectId: 8n })])).status).toBe(
      "unknown",
    );
  });
  it("preserves partial payout failure despite a successful outer receipt", async () => {
    const result = await compare(
      draft("sendPayoutsOf", [7n, token, 100n, 1n, 1n]),
      [
        log("JBMultiTerminal", "SendPayouts", {
          rulesetId: 1n,
          rulesetCycleNumber: 1n,
          projectId: 7n,
          projectOwner: account,
          amount: 100n,
          amountPaidOut: 100n,
          fee: 0n,
          netLeftoverPayoutAmount: 0n,
          caller: account,
        }),
        log(
          "JBMultiTerminal",
          "PayoutTransferReverted",
          {
            projectId: 7n,
            addr: account,
            token,
            amount: 100n,
            fee: 0n,
            reason: "0x",
            caller: account,
          },
          1,
        ),
      ],
    );
    expect(result.status).toBe("unknown");
    expect(result.details).toMatchObject({
      reason: expect.stringContaining("partial completion"),
    });
  });
  it("preserves failed buyback sell semantics", async () => {
    const result = await compare(
      draft("cashOutTokensOf", [account, 7n, 100n, token, 0n, account, "0x"]),
      [
        log("JBMultiTerminal", "CashOutTokens", {
          rulesetId: 1n,
          rulesetCycleNumber: 1n,
          projectId: 7n,
          holder: account,
          beneficiary: account,
          cashOutCount: 100n,
          cashOutTaxRate: 0n,
          reclaimAmount: 0n,
          metadata: "0x",
          caller: account,
        }),
        log(
          "JBBuybackHook",
          "SellSwapReverted",
          {
            projectId: 7n,
            holder: account,
            amount: 100n,
            caller: deployed("JBMultiTerminal"),
          },
          1,
        ),
      ],
    );
    expect(result.status).toBe("unknown");
    expect(result.details).toMatchObject({
      reason: expect.stringContaining("project tokens were returned"),
    });
  });
  it("keeps generic calls unmodeled and rejects incomplete, duplicate or noncanonical evidence", async () => {
    const plan = stored(draft());
    const observed = receipt([payLog()]);
    expect(
      (
        await verifier.verify(
          {
            ...plan,
            draft: { ...plan.draft, operation: "protocol-contract-calls" },
          },
          0,
          observed,
          rpc,
        )
      ).status,
    ).toBe("unmodeled");
    expect(
      (
        await verifier.verify(
          plan,
          0,
          { ...observed, logsStored: false, logs: [] },
          rpc,
        )
      ).status,
    ).toBe("unknown");
    expect(
      (await verifier.verify(plan, 0, { ...observed, canonical: false }, rpc))
        .status,
    ).toBe("unknown");
    expect(
      (
        await verifier.verify(
          plan,
          0,
          { ...observed, logs: [...observed.logs, ...observed.logs] },
          rpc,
        )
      ).status,
    ).toBe("unknown");
    expect(
      (await verifier.verify(plan, 0, { ...observed, status: "reverted" }, rpc))
        .status,
    ).toBe("failed");
    expect(rpc.request).not.toHaveBeenCalled();
  });
  it("downgrades oversized proof output to a bounded evidence commitment", async () => {
    const proof = vi.mocked(operationEvidence.verifyV6OperationEvidence).mockReturnValueOnce({
      verified: true,
      events: [{ emitter: account, event: "Fixture", logIndex: 0, args: { payload: "a".repeat(9000) } }],
    });
    const huge = createProtocolSemanticVerifier();
    const result = await huge.verify(
      stored(draft()),
      0,
      receipt([payLog()]),
      rpc,
    );
    expect(result).toMatchObject({
      status: "unknown",
      details: {
        evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        eventCount: 1,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);
    proof.mockRestore();
  });
});
