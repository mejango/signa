import { describe, expect, test, vi } from "vitest";
import { MemoryStore } from "../support/memoryStore.js";
import { createSponsorWorker } from "../../src/sponsor/worker.js";
import type { DeployLane, SponsorEvent } from "../../src/sponsor/chain.js";
import { DeploymentVerificationError } from "../../src/deploymentVerifier.js";
import { RestError } from "../../src/rest/core.js";
import { LaneError } from "../../src/sponsor/chain.js";
import { readSponsorPolicy } from "../../src/rest/sponsorCaps.js";
import type { NewIntent, StorageLimits } from "../../src/store.js";

const HASH = `0x${"12".repeat(32)}` as const;
const BUNDLE = "bundle-1";
const limits: StorageLimits = { maxIntents: 100, maxBytes: 1_000_000 };
const policy = readSponsorPolicy({});

function newIntent(overrides: { chainIds: number[] }): NewIntent {
  return {
    name: "Public goods garden",
    description: null,
    tagline: null,
    tags: [],
    logoUri: null,
    owner: null,
    contentHash: `0x${"aa".repeat(32)}`,
    envelope: {
      format: "juicebox.money/v1",
      deploymentVersion: "6",
      chainIds: overrides.chainIds,
      deploymentCalls: overrides.chainIds.map((chainId) => ({
        chainId,
        to: "0x3333333333333333333333333333333333333333",
        data: "0x12345678",
      })),
      jb: { name: "Public goods garden", chains: overrides.chainIds },
    },
    publisher: "0x1111111111111111111111111111111111111111",
    signature: `0x${"bb".repeat(65)}`,
    submittedBy: "browser:x",
    jbBytes: 128,
  };
}

describe("sponsor worker", () => {
  test("worker claims a queued intent, runs the lane, verifies and records", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.sent(84532, HASH, BUNDLE);
        await report.confirmed(84532, HASH, "9");
      }),
    };
    const verifier = { verify: vi.fn(async () => ({ forwarded: true })) };
    const worker = createSponsorWorker({ store, verifier, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 84532, projectId: "9", transactionHash: HASH }),
    );
    const after = await store.getIntent(intent.id);
    expect(after?.status).toBe("deployed");
    expect(after?.deploys[0]).toMatchObject({
      status: "confirmed",
      transactionHash: HASH,
      bundleUuid: BUNDLE,
    });
  });

  test("worker marks remaining chains failed when the lane stops early", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.failed(84532, "boom");
      }),
    };
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
    });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["failed", "boom"],
      ["failed", "not attempted: an earlier chain failed"],
    ]);
  });

  test("worker marks a sent-but-unconfirmed chain failed with a coded message when the lane throws", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.sent(84532, HASH, BUNDLE);
        throw new Error("bundle submission failed");
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["failed", "Error: lane error"],
      ["failed", "Error: lane error"],
    ]);
  });

  test("worker records a verifier rejection as a failed row", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.confirmed(84532, HASH, "9");
      }),
    };
    const verifier = {
      verify: vi.fn(async () => {
        throw new DeploymentVerificationError("bad");
      }),
    };
    const worker = createSponsorWorker({ store, verifier, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.status).toBe("undeployed");
    expect(after?.deploys[0]).toMatchObject({ status: "failed", error: "bad" });
    expect(after?.deployments).toEqual([]);
  });

  test("worker persists the bundle for every claimed chain as the lane reports it", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.bundle(BUNDLE);
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => d.bundleUuid)).toEqual([BUNDLE, BUNDLE]);
  });

  test("worker resumes a re-claimed intent that already carries a bundle instead of deploying again", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    for (const chainId of [84532, 421614]) {
      await store.updateDeploy(intent.id, chainId, { status: "queued", bundleUuid: BUNDLE });
    }
    const lane: DeployLane = {
      deploy: vi.fn(async () => {}),
      resume: vi.fn(async (_i, chainIds, bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, bundleUuid);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(lane.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: intent.id }),
      [84532, 421614],
      BUNDLE,
      expect.anything(),
    );
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => d.status)).toEqual(["confirmed", "confirmed"]);
  });

  test("the prepayment stays on the budget when every chain then reverts", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, chainIds, report) => {
        await report.bundle(BUNDLE);
        await report.paid(chainIds[0]!, 700n);
        for (const chainId of chainIds) {
          await report.failed(chainId, "the relayed deployment reverted");
        }
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => d.status)).toEqual(["failed", "failed"]);
    // 700 spent on the prepayment, and the two reservations a paid bundle cannot release.
    expect(await store.sponsoredWeiSince(new Date(Date.now() - 60_000))).toBe(720n);
  });

  test("a resumed bundle does not charge the budget a second payment", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    for (const chainId of [84532, 421614]) {
      await store.updateDeploy(intent.id, chainId, { status: "queued", bundleUuid: BUNDLE });
    }
    await store.updateDeploy(intent.id, 84532, { status: "queued", spentWei: 700n });
    const lane: DeployLane = {
      deploy: vi.fn(async () => {}),
      resume: vi.fn(async (_i, chainIds, _bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, BUNDLE);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
    };
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
    });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(await store.sponsoredWeiSince(new Date(Date.now() - 60_000))).toBe(700n);
  });

  test("a deferred lane leaves every claimed chain queued", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.deferred("sponsor balance too low");
      }),
    };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["queued", null],
      ["queued", null],
    ]);
    expect(events).toEqual([
      {
        event: "deferred",
        intentId: intent.id,
        chainIds: [84532, 421614],
        error: "sponsor balance too low",
      },
    ]);
    // A deferral spends nothing, the attempt included, but the rows wait out the release backoff first.
    expect(
      (store.intents[0]!.deploys as unknown as { attempts: number }[]).map((d) => d.attempts),
    ).toEqual([0, 0]);
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([]);
    for (const deploy of store.intents[0]!.deploys as unknown as { leaseUntil: number | null }[]) deploy.leaseUntil = Date.now() - 1;
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([
      { intentId: intent.id, chainIds: [84532, 421614] },
    ]);
  });

  test("a bundle in flight resumes the chains that are not recorded yet", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    for (const chainId of [84532, 421614]) {
      await store.updateDeploy(intent.id, chainId, { status: "sent", transactionHash: HASH, bundleUuid: BUNDLE });
    }
    // The first chain of the bundle was recorded before the process died.
    await store.recordDeployment(intent.id, {
      chainId: 84532,
      projectId: "7",
      transactionHash: HASH,
      forwarded: true,
    });
    const lane: DeployLane = {
      deploy: vi.fn(async () => {}),
      resume: vi.fn(async (_i, chainIds, bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, bundleUuid);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
    };
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
    });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(lane.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: intent.id }),
      [421614],
      BUNDLE,
      expect.anything(),
    );
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.chainId, d.status, d.error])).toEqual([
      [84532, "failed", "chain already deployed"],
      [421614, "confirmed", null],
    ]);
    expect(after?.deployments.map((d) => [d.chainId, d.projectId])).toEqual([
      [84532, "7"],
      [421614, "9"],
    ]);
  });

  test("a chain's own deployment retires that row and leaves the others claimable", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    await store.recordDeployment(intent.id, {
      chainId: 84532,
      projectId: "9",
      transactionHash: HASH,
      forwarded: true,
    });
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, chainIds, report) => {
        expect(chainIds).toEqual([421614]);
        await report.sent(421614, HASH, BUNDLE);
        await report.confirmed(421614, HASH, "11");
      }),
    };
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
    });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).toHaveBeenCalledTimes(1);
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((row) => [row.chainId, row.status, row.error])).toEqual([
      [84532, "failed", "chain already deployed"],
      [421614, "confirmed", null],
    ]);
    // The lane signs every launch as a forward request, so what it records is forwarded.
    expect(after?.deployments.map((row) => [row.chainId, row.forwarded])).toEqual([
      [84532, true],
      [421614, true],
    ]);
  });

  test("a wallet-sent deployment retires the whole claim without spending", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    await store.recordDeployment(intent.id, {
      chainId: 84532,
      projectId: "9",
      transactionHash: HASH,
      forwarded: false,
    });
    const lane: DeployLane = { deploy: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(lane.resume).not.toHaveBeenCalled();
    expect((await store.getIntent(intent.id))?.deploys.map((row) => [row.status, row.error])).toEqual([
      ["failed", "mixed sender"],
      ["failed", "mixed sender"],
    ]);
    expect(events).toEqual([
      { event: "failed", intentId: intent.id, chainId: 84532, error: "mixed sender" },
      { event: "failed", intentId: intent.id, chainId: 421614, error: "mixed sender" },
    ]);
  });

  test("a deployment on the only claimed chain spends nothing", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    await store.recordDeployment(intent.id, {
      chainId: 84532,
      projectId: "9",
      transactionHash: HASH,
      forwarded: true,
    });
    const lane: DeployLane = { deploy: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).not.toHaveBeenCalled();
    expect(lane.resume).not.toHaveBeenCalled();
    expect((await store.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "chain already deployed",
    });
  });

  test("one unreadable intent does not cost the rest of the batch its turn", async () => {
    const store = new MemoryStore();
    const first = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    const second = await store.createIntent(
      { ...newIntent({ chainIds: [421614] }), contentHash: `0x${"cc".repeat(32)}` },
      limits,
    );
    await store.queueDeploys(first.intent.id, [84532], "browser:x", 10n);
    await store.queueDeploys(second.intent.id, [421614], "browser:x", 10n);
    const read = store.getIntent.bind(store);
    let unreadable = true;
    store.getIntent = async (id: string) => {
      if (unreadable) {
        unreadable = false;
        throw new Error("the intent could not be read");
      }
      return read(id);
    };
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, chainIds, report) => {
        for (const chainId of chainIds) await report.failed(chainId, "boom");
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(lane.deploy).toHaveBeenCalledTimes(1);
  });

  test("stop() waits for the pass in flight, then resolves", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, chainIds, report) => {
        await gate;
        for (const chainId of chainIds) await report.failed(chainId, "boom");
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    worker.kick();
    let drained = false;
    const stopping = worker.stop().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release();
    await stopping;
    expect(drained).toBe(true);
    expect((await store.getIntent(intent.id))?.deploys[0]?.status).toBe("failed");
  });

  test("worker exposes the policy and stop() clears the interval without pending work", async () => {
    const store = new MemoryStore();
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane: { deploy: vi.fn(async () => {}), resume: vi.fn(async () => {}) },
      policy,
    });
    expect(worker.policy).toBe(policy);
    await worker.runOnce();
    await worker.stop();
  });
  test("a retryable failure before any bundle leaves every row queued with the reason", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async () => {
        throw new RestError(502, "SPONSORSHIP_RPC_UNAVAILABLE", "The configured RPC could not simulate.");
      }),
    };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    await worker.stop();
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["queued", "SPONSORSHIP_RPC_UNAVAILABLE"],
      ["queued", "SPONSORSHIP_RPC_UNAVAILABLE"],
    ]);
    expect(events).toEqual([
      {
        event: "deferred",
        intentId: intent.id,
        chainIds: [84532, 421614],
        error: "SPONSORSHIP_RPC_UNAVAILABLE",
      },
    ]);
    expect(
      (store.intents[0]!.deploys as unknown as { attempts: number }[]).map((d) => d.attempts),
    ).toEqual([0, 0]);
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([]);
  });

  test("an unfunded sponsor defers, and the event names the chain and the shortfall", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async () => {
        throw new LaneError(
          "sponsor holds less than the creation fee on chain 84532 by 500 wei",
          "SPONSOR_UNFUNDED",
        );
      }),
    };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    await worker.stop();
    expect((await store.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "queued",
      error: "SPONSOR_UNFUNDED",
    });
    expect(events).toEqual([
      {
        event: "deferred",
        intentId: intent.id,
        chainIds: [84532],
        error: "sponsor holds less than the creation fee on chain 84532 by 500 wei",
      },
    ]);
  });

  test("a status parse failure after the bundle keeps the rows and resumes the bundle", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async (_i, chainIds, bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, bundleUuid);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.bundle(BUNDLE);
        await report.paid(84532, 700n);
        throw new RestError(
          502,
          "RELAYR_INVALID_STATUS",
          "Provider status changed the stored transaction binding.",
          'Provider status changed the stored transaction binding. {"bundle_uuid":"b"}',
        );
      }),
    };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    const waiting = await store.getIntent(intent.id);
    expect(waiting?.deploys.map((d) => [d.status, d.bundleUuid, d.error])).toEqual([
      ["queued", BUNDLE, "RELAYR_INVALID_STATUS"],
      ["queued", BUNDLE, "RELAYR_INVALID_STATUS"],
    ]);
    expect(events).toEqual([
      {
        event: "status_invalid",
        intentId: intent.id,
        bundleUuid: BUNDLE,
        detail: 'Provider status changed the stored transaction binding. {"bundle_uuid":"b"}',
      },
      {
        event: "deferred",
        intentId: intent.id,
        chainIds: [84532, 421614],
        error: "RELAYR_INVALID_STATUS",
      },
    ]);

    for (const deploy of store.intents[0]!.deploys as unknown as { leaseUntil: number | null }[])
      deploy.leaseUntil = Date.now() - 1;
    await worker.runOnce();
    await worker.stop();
    expect(lane.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: intent.id }),
      [84532, 421614],
      BUNDLE,
      expect.anything(),
    );
    const after = await store.getIntent(intent.id);
    expect(after?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["confirmed", null],
      ["confirmed", null],
    ]);
  });

  test("a bundle relayr has not executed yet keeps its rows, and the next claim resumes it", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async (_i, chainIds, bundleUuid, report) => {
        for (const chainId of chainIds) {
          await report.sent(chainId, HASH, bundleUuid);
          await report.confirmed(chainId, HASH, "9");
        }
      }),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.bundle(BUNDLE);
        await report.paid(84532, 700n);
        throw new LaneError("relayr did not execute the bundle in time", "RELAYR_TIMEOUT");
      }),
    };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    expect((await store.getIntent(intent.id))?.deploys.map((d) => [d.status, d.bundleUuid, d.error])).toEqual([
      ["queued", BUNDLE, "RELAYR_TIMEOUT"],
      ["queued", BUNDLE, "RELAYR_TIMEOUT"],
    ]);
    expect(events).toEqual([
      {
        event: "deferred",
        intentId: intent.id,
        chainIds: [84532, 421614],
        error: "relayr did not execute the bundle in time",
      },
    ]);

    for (const deploy of store.intents[0]!.deploys as unknown as { leaseUntil: number | null }[])
      deploy.leaseUntil = Date.now() - 1;
    await worker.runOnce();
    await worker.stop();
    expect(lane.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: intent.id }),
      [84532, 421614],
      BUNDLE,
      expect.anything(),
    );
    expect((await store.getIntent(intent.id))?.deploys.map((d) => d.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);
  });

  test("a row that waited a day without a bundle is retired and its reservation released", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    await store.updateDeploy(intent.id, 84532, { error: "SPONSOR_UNFUNDED" });
    const deploy = store.intents[0]!.deploys[0] as unknown as { createdAt: string };
    deploy.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([]);
    expect((await store.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "retries exhausted",
    });
    expect((store.intents[0]!.deploys[0] as unknown as { reservedWei: bigint }).reservedWei).toBe(0n);
  });

  test("an unfunded prepayment leaves the code on the rows, and a day of it retires them", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532, 421614] }), limits);
    await store.queueDeploys(intent.id, [84532, 421614], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async () => {
        throw new LaneError("sponsor holds less than the prepayment on chain 8453 by 500 wei", "SPONSOR_UNFUNDED");
      }),
    };
    const events: SponsorEvent[] = [];
    const worker = createSponsorWorker({
      store,
      verifier: { verify: vi.fn(async () => ({ forwarded: true })) },
      lane,
      policy,
      onEvent: (event) => events.push(event),
    });
    await worker.runOnce();
    await worker.stop();
    expect((await store.getIntent(intent.id))?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["queued", "SPONSOR_UNFUNDED"],
      ["queued", "SPONSOR_UNFUNDED"],
    ]);
    expect(events).toEqual([
      {
        event: "deferred",
        intentId: intent.id,
        chainIds: [84532, 421614],
        error: "sponsor holds less than the prepayment on chain 8453 by 500 wei",
      },
    ]);

    // The code is the evidence the lane reached the rows, so the day-old sweep ends the wait.
    for (const deploy of store.intents[0]!.deploys as unknown as {
      createdAt: string;
      leaseUntil: number | null;
    }[]) {
      deploy.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
      deploy.leaseUntil = null;
    }
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([]);
    expect((await store.getIntent(intent.id))?.deploys.map((d) => [d.status, d.error])).toEqual([
      ["failed", "retries exhausted"],
      ["failed", "retries exhausted"],
    ]);
    expect(
      (store.intents[0]!.deploys as unknown as { reservedWei: bigint }[]).map((d) => d.reservedWei),
    ).toEqual([0n, 0n]);
  });

  test("a row queued for a day that was never attempted is still claimed", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const deploy = store.intents[0]!.deploys[0] as unknown as { createdAt: string };
    deploy.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([{ intentId: intent.id, chainIds: [84532] }]);
    expect((await store.getIntent(intent.id))?.deploys[0]).toMatchObject({ status: "queued" });
  });

  test("a definitive failure after the bundle still retires every claimed row", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.bundle(BUNDLE);
        throw new DeploymentVerificationError("the Create event is missing");
      }),
    };
    const worker = createSponsorWorker({ store, verifier: { verify: vi.fn(async () => ({ forwarded: true })) }, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect((await store.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "the Create event is missing",
    });
  });

  test("a bundle unresolved for a day is retired by the next claim, reservation kept", async () => {
    const store = new MemoryStore();
    const { intent } = await store.createIntent(newIntent({ chainIds: [84532] }), limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    await store.updateDeploy(intent.id, 84532, { status: "sent", transactionHash: HASH, bundleUuid: BUNDLE });
    const deploy = store.intents[0]!.deploys[0] as unknown as { createdAt: string };
    deploy.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    expect(await store.claimQueuedDeploys(30, 5)).toEqual([]);
    expect((await store.getIntent(intent.id))?.deploys[0]).toMatchObject({
      status: "failed",
      error: "bundle unresolved",
    });
    // The prepayment may have left the key, so the reservation keeps counting.
    expect((store.intents[0]!.deploys[0] as unknown as { reservedWei: bigint }).reservedWei).toBe(10n);
  });

  test("worker verifies the launch call, not the setup call before it", async () => {
    const store = new MemoryStore();
    const value = newIntent({ chainIds: [84532] });
    value.envelope.deploymentCalls = [
      { chainId: 84532, to: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", data: "0xaaaaaaaa" },
      { chainId: 84532, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
    ];
    const { intent } = await store.createIntent(value, limits);
    await store.queueDeploys(intent.id, [84532], "browser:x", 10n);
    const lane: DeployLane = {
      resume: vi.fn(async () => {}),
      deploy: vi.fn(async (_i, _c, report) => {
        await report.sent(84532, HASH, BUNDLE);
        await report.confirmed(84532, HASH, "9");
      }),
    };
    const verifier = { verify: vi.fn(async () => ({ forwarded: true })) };
    const worker = createSponsorWorker({ store, verifier, lane, policy });
    await worker.runOnce();
    await worker.stop();
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        call: { chainId: 84532, to: "0x3333333333333333333333333333333333333333", data: "0x12345678" },
      }),
    );
  });
});
