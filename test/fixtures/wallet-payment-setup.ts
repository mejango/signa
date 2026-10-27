// Modeled server-owned V6 plan/UserOperation records admitted by real PostgreSQL stores.
// This fixture never dispatches, simulates an EVM, or claims canonical payment effects.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { encodeFunctionData, erc20Abi, parseAbi, toHex, type Address } from "viem";
import type { RestActor } from "../../src/rest/core.js";
import type { SmartAccountBinding, SmartAccountManifest } from "../../src/rest/smartAccounts/types.js";
import { encodeSafe7579Execution } from "../../src/rest/smartAccounts/accountExecution.js";
import { safe7579PasskeyOwnerSigningPayload } from "../../src/rest/smartAccounts/passkeySignatures.js";
import { digest } from "../../src/rest/sponsorship/validation.js";
import { PostgresTransactionStore } from "../../src/rest/transactions/postgres.js";
import type { StoredPlan } from "../../src/rest/transactions/types.js";
import { PostgresUserOperationStore } from "../../src/rest/userOperations/postgres.js";
import type { UserOperationRecord } from "../../src/rest/userOperations/store.js";
import { getUserOperationHash, normalizeUserOperation, userOperationMaximumCost } from "../../src/rest/userOperations/codec.js";
import { recognizeWalletV6UsdcPayment } from "../../src/rest/userOperations/semantics.js";
import type { CenterWalletPaymentInput } from "../../src/rest/client/walletPayments.js";
import { enrollmentManifest } from "./wallet-enrollment-crypto.js";

export const walletPaymentFixtureToken: Address = "0x1111111111111111111111111111111111111111";
export const walletPaymentFixtureTerminal: Address = "0x4444444444444444444444444444444444444444";
const beneficiary: Address = "0x2222222222222222222222222222222222222222";
const entryPoint: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const artifact = JSON.parse(readFileSync(new URL("../../src/rest/smartAccounts/stack/artifacts/EntryPoint.json", import.meta.url), "utf8"));
export const walletPaymentFixtureManifest: SmartAccountManifest = { ...enrollmentManifest,
  entryPoint: { version: "0.7", address: entryPoint, runtimeCodeHash: artifact.runtimeCodeHash,
    source: { repository: artifact.source.repo, commit: artifact.source.commit, artifactSha256: artifact.source.artifactSha256 } } };
const payAbi = parseAbi(["function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)"]);

export async function prepareWalletPaymentFixtureOperation(pool: Pool, actor: RestActor, binding: SmartAccountBinding,
  lifetimeMs = 120_000, nonce = 1n, balanceWei = 10n ** 18n) {
  const now = Number((await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now")).rows[0].now);
  const id = randomUUID(), token = walletPaymentFixtureToken, terminal = walletPaymentFixtureTerminal;
  const calls: StoredPlan["draft"]["calls"] = [
    { chainId: 8453, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [terminal, 1_000_000n] }),
      value: "0", label: "Modeled USDC allowance", dependsOn: [], decoded: {} },
    { chainId: 8453, to: terminal, data: encodeFunctionData({ abi: payAbi, functionName: "pay",
      args: [1n, token, 1_000_000n, beneficiary, 0n, "DB boundary fixture", "0x"] }),
      value: "0", label: "Modeled direct V6 payment", dependsOn: [0], decoded: {} },
  ];
  const project = { chainId: 8453, projectId: "1", version: 6 as const };
  const plan: StoredPlan = { id, actor, commitment: digest(`pending:${id}`), createdAt: now, expiresAt: now + lifetimeMs, revision: 0,
    smartAccount: { bindingId: binding.id, stateHash: binding.state.stateHash, chainId: 8453,
      address: binding.wallet.address, manifestRevision: binding.state.manifestRevision },
    draft: { operation: "pay", account: binding.wallet.address, project, evidence: [binding.state.evidence], warnings: [], calls,
      summary: { operation: "pay", project, account: binding.wallet.address, terminal, terminalPath: [terminal], routerGateway: null,
        route: "multi-terminal", payment: { token, amount: "1000000", unit: "token-base-units" }, beneficiary,
        minimumBeneficiaryTokenCount: "0", metadata: "0x" } }, steps: calls.map((_, index) => ({ index, state: "waiting" })) };
  plan.commitment = digest({ actor: plan.actor, draft: plan.draft, expiresAt: plan.expiresAt, smartAccount: plan.smartAccount });
  await new PostgresTransactionStore(pool).create(plan, { key: `plan:${id}`, operation: "prepare", requestHash: digest(id) }, now);
  const operation = normalizeUserOperation({ sender: binding.wallet.address, nonce: toHex(nonce),
    callData: encodeSafe7579Execution(calls.map(call => ({ target: call.to, value: call.value, callData: call.data }))),
    callGasLimit: "0x186a0", verificationGasLimit: "0xf4240", preVerificationGas: "0xc350",
    maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", signature: "0x" });
  const record: UserOperationRecord = { id: randomUUID(), actor, planId: id, planCommitment: plan.commitment,
    stepIndexes: [0, 1], chainId: 8453, entryPoint, sender: operation.sender, operation,
    operationHash: getUserOperationHash(operation, entryPoint, 8453), preparationKey: `prepare:${id}`,
    inputHash: digest(`input:${id}`), commitment: digest(`pending-operation:${id}`), accountBindingId: binding.id,
    accountStateHash: binding.state.stateHash, gasPolicyId: "fixture-gas", providerId: "fixture-provider",
    createdAt: now, expiresAt: now + lifetimeMs - 1, revision: 0, state: "prepared",
    // The cap left this operation for the account to pay, and its balance covers the gas.
    gas: { payer: "account", chainId: 8453, maximumWei: userOperationMaximumCost(operation).toString(), reason: "account-cap",
      balanceWei: balanceWei.toString(), funded: balanceWei >= userOperationMaximumCost(operation) } };
  record.commitment = digest({ planId: record.planId, planCommitment: record.planCommitment, operation,
    operationHash: record.operationHash, accountBindingId: record.accountBindingId, accountStateHash: record.accountStateHash,
    gasPolicyId: record.gasPolicyId, providerId: record.providerId, createdAt: record.createdAt, expiresAt: record.expiresAt });
  await new PostgresUserOperationStore(pool).create(record, now);
  const { actor: _planActor, ...clientPlan } = plan;
  const { actor: _actor, sender: _sender, preparationKey: _key, inputHash: _input, ...clientOperation } = record;
  const payment = recognizeWalletV6UsdcPayment(plan, record.stepIndexes, { chainId: 8453, token, directV6Terminal: terminal });
  if (!payment) throw new Error("Modeled payment fixture classification failed");
  const { stepIndexes: _steps, approvalStepIndexes: _approvals, paymentStepIndex: _payment, resetAllowance: _reset, ...expected } = payment;
  const clientInput: CenterWalletPaymentInput = { plan: clientPlan, operation: { ...clientOperation, signing: {
    ...safe7579PasskeyOwnerSigningPayload({ operation, chainId: 8453, entryPoint, safe7579: walletPaymentFixtureManifest.safe7579.address,
      validAfter: String(Math.floor(record.createdAt / 1000)), validUntil: String(Math.floor(record.expiresAt / 1000)) }), ownerProfile: "center-passkey-v1" } },
    expectedPayment: { ...expected, maximumNetworkFee: userOperationMaximumCost(operation).toString() } };
  return { plan, record, clientInput };
}
