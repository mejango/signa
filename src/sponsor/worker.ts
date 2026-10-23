import type { DeploymentVerifier } from "../deploymentVerifier.js";
import { callsForChain } from "../intent.js";
import type { Store } from "../store.js";
import {
  laneErrorDetail,
  laneErrorMessage,
  laneEventMessage,
  laneOutcome,
  logSponsorEvent,
  type DeployLane,
  type LaneReport,
  type SponsorEvents,
} from "./chain.js";
import type { SponsorRuntime } from "./policy.js";
import type { SponsorPolicy } from "../rest/sponsorCaps.js";

const DRAIN_LIMIT_MS = 30_000;

export function createSponsorWorker(options: {
  store: Store;
  verifier: DeploymentVerifier;
  lane: DeployLane;
  policy: SponsorPolicy;
  leaseSeconds?: number;
  onEvent?: SponsorEvents;
}): SponsorRuntime & { stop(): Promise<void>; runOnce(): Promise<void> } {
  const { store, verifier, lane, policy, leaseSeconds = 1800, onEvent = logSponsorEvent } = options;
  let running = false;
  let stopped = false;
  let pending = false;
  let active: Promise<void> | null = null;

  async function runClaim(intentId: string, claimed: number[]): Promise<void> {
    const intent = await store.getIntent(intentId);
    if (!intent) return;
    // A claimed row that already carries a bundle was paid for by an earlier
    // attempt; resuming it is the only way not to fund the same work twice.
    let bundleUuid = intent.deploys.find(
      (deploy) => claimed.includes(deploy.chainId) && deploy.bundleUuid,
    )?.bundleUuid;
    // Nothing was paid, so a chain a wallet deployed meanwhile retires the whole claim: the
    // sponsor's salts no longer match that chain's, and the projects would never pair.
    if (!bundleUuid && intent.deployments.some((deployment) => !deployment.forwarded)) {
      for (const chainId of claimed) {
        await store.updateDeploy(intentId, chainId, { status: "failed", error: "mixed sender" });
        onEvent({ event: "failed", intentId, chainId, error: "mixed sender" });
      }
      return;
    }
    // A chain deployed by anyone else is done, whatever the rest of the intent is doing.
    const recorded = new Set(intent.deployments.map((deployment) => deployment.chainId));
    for (const chainId of claimed.filter((chainId) => recorded.has(chainId))) {
      await store.updateDeploy(intentId, chainId, {
        status: "failed",
        error: "chain already deployed",
      });
      onEvent({ event: "failed", intentId, chainId, error: "chain already deployed" });
    }
    const chainIds = claimed.filter((chainId) => !recorded.has(chainId));
    if (chainIds.length === 0) return;
    const done = new Set<number>();
    let deferred = false;
    const fail = async (chainId: number, error: string) => {
      await store.updateDeploy(intentId, chainId, { status: "failed", error });
      onEvent({ event: "failed", intentId, chainId, error });
      done.add(chainId);
    };
    const report: LaneReport = {
      bundle: async (submitted) => {
        // From here the prepayment may leave the key, so the rows are never retired
        // on a transient failure: they wait for the bundle's own outcome.
        bundleUuid = submitted;
        for (const chainId of chainIds) {
          await store.updateDeploy(intentId, chainId, { status: "queued", bundleUuid: submitted });
        }
      },
      paid: (chainId, spentWei) => store.updateDeploy(intentId, chainId, { status: "queued", spentWei }),
      sent: (chainId, transactionHash, bundleUuid) =>
        store.updateDeploy(intentId, chainId, { status: "sent", transactionHash, bundleUuid }),
      confirmed: async (chainId, transactionHash, projectId) => {
        try {
          const call = callsForChain(intent.envelope.deploymentCalls, chainId).launch!;
          await verifier.verify({
            chainId,
            projectId,
            transactionHash,
            deploymentVersion: intent.envelope.deploymentVersion,
            call,
          });
          // The lane wraps every launch in a forward request signed by the sponsor.
          await store.recordDeployment(intentId, {
            chainId,
            projectId,
            transactionHash,
            forwarded: true,
          });
          await store.updateDeploy(intentId, chainId, { status: "confirmed", transactionHash });
          done.add(chainId);
        } catch (error) {
          const message = laneErrorMessage(error);
          await store.updateDeploy(intentId, chainId, {
            status: "failed",
            transactionHash,
            error: message,
          });
          onEvent({ event: "failed", intentId, chainId, error: message });
          done.add(chainId);
        }
      },
      failed: fail,
      deferred: async (error) => {
        deferred = true;
        onEvent({ event: "deferred", intentId, chainIds, error });
      },
    };
    try {
      if (bundleUuid) await lane.resume(intent, chainIds, bundleUuid, report);
      else await lane.deploy(intent, chainIds, report);
    } catch (error) {
      const message = laneErrorMessage(error);
      if (laneOutcome(error, { paid: Boolean(bundleUuid) }) === "terminal") {
        for (const chainId of chainIds) if (!done.has(chainId)) await fail(chainId, message);
      } else {
        // The row keeps its status and its bundle, and says why it is waiting.
        for (const chainId of chainIds) {
          if (!done.has(chainId)) await store.updateDeploy(intentId, chainId, { error: message });
        }
        const detail = laneErrorDetail(error);
        if (detail)
          onEvent({ event: "status_invalid", intentId, ...(bundleUuid ? { bundleUuid } : {}), detail });
        await report.deferred(laneEventMessage(error));
      }
    }
    // A deferral spent nothing, so it must not spend one of the three attempts either.
    if (deferred) return store.releaseClaim(intentId, chainIds);
    for (const chainId of chainIds) {
      if (!done.has(chainId)) await fail(chainId, "not attempted: an earlier chain failed");
    }
  }

  async function runOnce(): Promise<void> {
    const claims = await store.claimQueuedDeploys(leaseSeconds, 5);
    for (const { intentId, chainIds } of claims) {
      // One unreadable intent must not cost the rest of the batch its turn; the
      // lease expires and the rows are claimed again.
      try {
        await runClaim(intentId, chainIds);
      } catch (error) {
        console.error("sponsor claim failed", laneErrorMessage(error));
      }
    }
  }

  async function loop(): Promise<void> {
    running = true;
    try {
      do {
        pending = false;
        await runOnce();
      } while (pending && !stopped);
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (running || stopped) {
      pending = running;
      return;
    }
    active = loop().catch((error) => console.error("sponsor worker failed", laneErrorMessage(error)));
  }

  const timer = setInterval(start, 30_000);
  timer.unref();

  return {
    policy,
    kick: start,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (!active) return;
      let drain: NodeJS.Timeout | undefined;
      await Promise.race([
        active,
        new Promise<void>((resolve) => {
          drain = setTimeout(resolve, DRAIN_LIMIT_MS);
        }),
      ]);
      clearTimeout(drain);
    },
    runOnce,
  };
}
