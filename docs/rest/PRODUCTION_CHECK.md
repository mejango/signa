# Verify a real sponsored transaction

Use the existing [account page](https://api.signa.center/accounts), a wallet you control, and fresh owner approval. No bot or recurring session is needed. Complete the check separately on Ethereum (`1`), Optimism (`10`), Base (`8453`) and Arbitrum (`42161`); success on one chain does not establish the others.

## Connect and bind

1. Connect the owner wallet and load its Signa account. Select the chain to check.
2. Bind a supported deployed smart wallet, or use **Create a smart wallet**. Creation requires an owner-signed transaction and owner-paid network gas. Wait for its receipt before binding.
3. Inspect and sign the binding. If the wallet has multiple owners, collect the actual owner threshold. API authentication and binding signatures do not approve any transaction.

## Prepare the smallest V6 check

From the repository root, build once and supply the **bound smart-wallet address**, not its owner EOA:

```sh
npm run build
node scripts/rest/production-check.mjs 8453 YOUR_SMART_WALLET_ADDRESS > /tmp/center-check.json
```

The command uses Center's public read RPC and Signa's pinned V6 catalog/runtime verifier. Center prepares the unsigned draft, and Signa's adapter checks its calls against the requested input. It requires a deployed wallet and a canonical read showing that `JBPermissions.permissionsOf(wallet,wallet,0)` is already zero. It then prepares `setPermissionsFor(wallet,{operator:wallet,projectId:0,permissionIds:[]})` with zero native value. The call keeps that empty bitmap empty and emits `OperatorPermissionsSet`. It grants no authority, transfers no tokens and needs no project to be invented. Project scope `0` is the protocol's wildcard scope; the empty permission list grants nothing in that scope.

A nonzero bitmap or unavailable canonical read stops preparation. Run the command shortly before review, and do not change these permissions concurrently. If you already have an intended V6 action to validate, prepare that action instead and review its actual effects and spending.

In **Prepare a V6 action**, select the `contract_calls` operation and paste the contents of `/tmp/center-check.json` into its operation input. Prepare the smart-wallet plan. Keep **Fresh owner approval** and step `0`. Check the displayed chain, wallet, verified `JBPermissions` destination, empty permission IDs and zero native value.

## Review, submit and confirm

1. Prepare and simulate the operation. Review its sponsor, gas ceilings and expiration.
2. Sign the exact reviewed operation in the owner wallet, collecting any additional owner threshold signatures. Then explicitly submit once. The account page also requests signed API authentication where required.
3. Refresh the existing operation until its state is `confirmed`. Record its ID, UserOperation hash, outer transaction hash, canonical block and plan ID. A submission timeout means inspect that same operation; do not create a replacement transaction automatically.
4. Verify the original plan reaches `transactions_confirmed`, the operation's own inner execution succeeded, and the V6 receipt contains the expected `OperatorPermissionsSet` for this wallet as operator, account and caller, with project scope `0`, empty permission IDs and packed value `0`. A successful outer bundler transaction by itself is insufficient. Re-run the read-only command to confirm the bitmap remains zero.

Keep one record per chain with those identifiers and the checked source commit. Four completed records establish a real wallet-to-V6 execution through the hosted sponsor and receipt path. They do not establish payment/cash-out amounts, token allowances, bridge settlement, or recurring delegation; validate those outcomes when exercising their corresponding journeys. Sponsorship quotes and execution consume provider quota. The check sends no native value, but wallet creation, if needed, still costs owner gas.

An agent can perform public reads, verify configuration, and generate these unsigned inputs. The owner must connect and approve wallet creation, binding and the exact operation. Never supply an owner private key to Signa or to an agent to complete this check.
