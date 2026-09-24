import { escapeHtml } from "./html.js";

export function smartWalletSections(referenceOrigin = ""): string {
  const api = `${escapeHtml(referenceOrigin)}/api`;
  return `<details id="smart-setup"><summary>Optional: keep transaction funds in a separate wallet</summary>
<p>Give your transactions a separate wallet, controlled by your signed-in account. Keep funds apart from your personal balance, share approvals with other owners, or approve a bot to act within exact limits on supported networks. API access only needs sign-in; this setup is optional.</p>
<section aria-labelledby="smart-heading"><h2 id="smart-heading">Set up your transaction wallet</h2>
<p>Use the same owners and approval rule on the networks you choose. Review the wallet address on each network before creating it. Balances and network fees stay separate.</p>
<p class="service-links"><a href="${api}/docs/smart-accounts">Wallet setup guide</a></p>
<p id="smart-readiness">Sign in to see the supported networks.</p>
<button id="smart-discover" type="button" hidden>Try again</button>
<fieldset id="smart-fields" disabled>
<details id="smart-create-options" open><summary>Create transaction wallets</summary>
<p>Your signed-in account owns each wallet and pays its creation fee on that network. Choose the networks, review the full setup, then approve creation. Creating wallets gives no bot permission to spend.</p>
<fieldset class="network-selection"><legend>Networks</legend><div id="smart-networks" class="network-choices"><p>Supported networks appear after sign-in.</p></div></fieldset>
<details><summary>Add multiple owners (multisig)</summary><p>By default, your signed-in account is the only owner. Add owners and choose how many must approve a transaction. The same owner list and approval rule apply to every network selected above.</p><label>Owner addresses, one per line<textarea id="smart-owners" rows="3" spellcheck="false"></textarea></label>
<label class="smart-field smart-number-field">Required owner signatures<input id="smart-threshold" type="number" min="1" max="16" value="1"></label></details>
<div class="row"><button id="smart-create-prepare" type="button">Review selected networks</button><button id="smart-create-send" type="button" disabled hidden>Approve wallet creation</button><button id="smart-create-status" type="button" disabled hidden>Check network progress</button></div>
<div id="smart-create-review" class="smart-review" role="region" aria-label="Wallet setup review" hidden></div>
<div id="smart-creation-progress" class="network-progress" role="status" aria-live="polite" hidden></div>
<details class="wallet-technical"><summary>Exact wallet creation details</summary><pre id="smart-creation" tabindex="0" aria-label="Wallet creation details" hidden></pre></details>
</details>
<details id="smart-saved-wallets"><summary>Use a connected wallet</summary>
<p>Choose a network and wallet address from your saved connections.</p>
<ul id="smart-wallet-list" class="wallet-choice-list" aria-label="Connected transaction wallets" hidden></ul>
<button id="smart-bind-list" type="button">Find connected wallets</button>
<details><summary>Find a connection by ID</summary><div class="row"><label>Saved connection ID<input id="smart-binding-id" spellcheck="false" autocomplete="off"></label><button id="smart-bind-load" type="button">Use saved connection</button></div></details>
<details class="wallet-technical"><summary>Exact saved connection details</summary><pre id="smart-bindings" tabindex="0" aria-label="Verified wallet bindings" hidden></pre></details>
</details>
<label class="smart-field">Current network<select id="smart-manifest"><option value="">Sign in first</option></select></label>
<button id="smart-switch" type="button" hidden>Switch to this network</button>
<details id="smart-existing-wallet"><summary>Connect a wallet you already own</summary>
<p>Enter a Safe wallet address on the current network. A Safe can have one owner or several owners who approve together (a multisig). Signa checks its setup and ownership before you approve the connection. Connecting it gives no bot permission to spend.</p>
<label>Wallet address<input id="smart-address" spellcheck="false" autocomplete="off" placeholder="0x…"></label>
<button id="smart-bind-prepare" type="button">Review wallet connection</button>
</details>
<p id="smart-binding-summary" class="wallet-review" hidden></p>
<details id="smart-binding-document" hidden><summary>Connection approval details</summary><pre id="smart-binding-review" tabindex="0" aria-label="Owner binding review" hidden></pre></details>
<details id="smart-binding-multisig" hidden><summary>Additional owner signatures</summary><label>Signatures, JSON array<textarea id="smart-binding-signatures" rows="2" spellcheck="false" placeholder='["0x…"]'></textarea></label>
<p>If more than one signature is required, share the exact public signing document with the other owners and collect their typed wallet signatures (EIP-712). Keep this page open while they sign.</p></details>
<div class="row"><button id="smart-bind-sign" type="button" disabled hidden>Approve and connect wallets</button><button id="smart-bind-submit" type="button" disabled hidden>Connect with collected owner approvals</button></div>
</fieldset></section>
<div id="smart-recovery" class="transaction-review" hidden></div>
<section aria-labelledby="operation-heading"><h2 id="operation-heading">Review and send transactions</h2>
<p>Use the connected wallet on the current network to prepare an action and test it without sending funds (a simulation). Add each prepared action to your review list. You can include actions from several networks before approving and sending them.</p>
<p>Each network has its own fees, approvals and confirmation status. Transactions can finish at different times. A failure on one network does not undo transactions confirmed on another.</p>
<fieldset id="operation-fields" disabled>
<label id="operation-authority-label" class="smart-field" hidden>Who approves<select id="operation-authority" disabled><option value="owner">Fresh owner approval</option><option value="session">Approved bot permission</option></select></label>
<div id="session-key-fields" hidden><label>Local bot key file<input id="session-key-file" type="file" accept="application/json,.json"></label><p id="session-key-status">Load the bot key downloaded during registration. The key stays in this page's memory and is never sent to the service.</p><button id="session-key-clear" type="button">Clear local key</button></div>
<p>Choose an <a href="${api}#write">operation from the API guide</a> and enter its input. The resulting calls are shown before signing.</p>
<details id="operation-session-template" hidden><summary>Fill from bot permissions</summary>
<label>New address for project details<input id="operation-uri" placeholder="ipfs://…" spellcheck="false"></label>
<label>Payment or transfer amount, smallest token units<input id="operation-amount" inputmode="numeric"></label>
<label>Verified token contract ID for an ERC20 transfer<input id="operation-token-contract" spellcheck="false" placeholder="From Juicebox Center's contract catalog"></label>
<button id="operation-template" type="button">Fill current session action</button>
<p>For ERC-20 payments, the owner must separately approve how many tokens the payment contract (terminal) may spend. This limit is an allowance.</p></details>
<label class="smart-field">Operation name<input id="operation-name" value="contract_calls" spellcheck="false"></label><label>Operation input JSON<textarea id="operation-input" rows="7" spellcheck="false" autocomplete="off" placeholder='{"account":"0x…","calls":[…]}'></textarea></label><button id="operation-plan" type="button">Prepare transaction plan</button>
<p>Use one plan step at a time to verify payment or cash-out amounts. Several calls sent together can confirm without proving each financial result.</p>
<details><summary>Choose specific plan steps</summary><p>All planned calls are selected by default.</p><label class="smart-field">Steps to send: 0 for the first, 0,1 for the first two<input id="operation-steps" value="0" inputmode="numeric"></label></details>
<pre id="operation-plan-review" tabindex="0" aria-label="Planned calls review" hidden></pre>
<button id="operation-prepare" type="button" disabled>Prepare and simulate transaction</button>
<pre id="operation-review" tabindex="0" aria-label="Prepared operation and signing document" hidden></pre>
<div class="row"><button id="operation-queue-add" type="button" disabled>Add to transaction review</button></div>
<details id="operation-single-controls"><summary>Send this operation on its own</summary>
<p>Use this flow for a single transaction, including one covered by an approved bot permission.</p>
<button id="operation-sign" type="button" disabled>Sign reviewed operation</button>
<details id="operation-owner-signatures-label" hidden><summary>Additional owner signatures</summary><label>Owner approval signatures (SafeOp), JSON array<textarea id="operation-owner-signatures" rows="2" spellcheck="false" placeholder='["0x…"]'></textarea></label></details>
<div class="row"><button id="operation-submit" type="button" disabled>Verify signatures and submit</button><button id="operation-status" type="button" disabled>Refresh operation status</button></div>
<p id="operation-result" role="status"></p>
</details>
<div class="transaction-review"><h3>Transactions to review</h3>
<p>Add a prepared action from each wallet you want to use. This list uses owner approvals; you review the exact action on every network before signing.</p>
<ul id="operation-queue-review" class="transaction-review-list" aria-label="Transactions by network" hidden></ul>
<div class="row"><button id="operation-queue-sign" type="button" disabled>Approve listed transactions</button><button id="operation-queue-submit" type="button" disabled>Send approved transactions</button><button id="operation-queue-status" type="button" disabled>Check network status</button></div>
</div>
</fieldset></section>
<section id="session-section" aria-labelledby="session-heading" hidden><h2 id="session-heading">Optional bot permissions</h2>
<p>Allow a registered bot to repeat one action for 7 or 30 days. This permission is called a session. Moving funds still needs fresh owner approval unless you approve the exact payment budget below. <a href="${api}/docs/sessions">Bot permission guide</a>.</p>
<fieldset id="session-fields" disabled>
<label>Bot grant ID<input id="session-grant" spellcheck="false" autocomplete="off"></label>
<p>The bot’s API access must include relay and remain valid for the whole session.</p>
<div class="row"><label>Duration<select id="session-days"><option value="7">7 days</option><option value="30">30 days</option></select></label><label>Maximum calls<input id="session-calls" inputmode="numeric" value="7"></label></div>
<label>Allowed action<select id="session-action"><option value="v6-project-uri">Update the address for project details</option><option value="v6-pay">Repeat payment to one V6 project</option><option value="erc20-transfer">Repeat ERC20 transfer to one recipient</option></select></label>
<div class="row"><label>V6 controller or terminal<input id="session-target" spellcheck="false" placeholder="0x…"></label><label>V6 project ID<input id="session-project" inputmode="numeric" value="1"></label></div>
<div id="session-payment" hidden>
<label>Asset address<input id="session-asset" spellcheck="false" placeholder="0x…"></label>
<label>Exact token recipient<input id="session-beneficiary" spellcheck="false" placeholder="0x…"></label>
<div class="row"><label>Maximum per call, smallest token units<input id="session-per-call" inputmode="numeric"></label><label>Total budget in this separate wallet, smallest token units<input id="session-total" inputmode="numeric"></label></div>
<label>Exact minimum project tokens returned per V6 payment<input id="session-min-return" inputmode="numeric" value="0"></label>
<label><input id="session-budget-consent" type="checkbox"> I authorize repeat payments within this exact recipient, chain, asset, time and amount budget.</label>
</div>
<details><summary>Required limits on sponsored network costs</summary><p>Use the sponsor contract (<a href="${api}#glossary-paymaster">paymaster</a>) reviewed by this service. Enter exact integers in gas units and wei, as required by each field. These limits cover the whole session; the wallet cannot pay its own session network costs.</p>
<label>Gas budget JSON<textarea id="session-gas" rows="10" spellcheck="false" autocomplete="off">{
  "paymaster": "",
  "maxGasPerOperation": "1000000",
  "maxFeePerGas": "1000000000",
  "maxPriorityFeePerGas": "100000000",
  "totalGasLimit": "7000000",
  "totalSponsoredCostLimit": "7000000000000000",
  "maxPaymasterDataLength": 1024
}</textarea></label></details>
<button id="session-prepare" type="button">Prepare exact bot permissions</button>
<pre id="session-review" tabindex="0" aria-label="Exact session policy review" hidden></pre>
<div class="row"><button id="session-activate" type="button" disabled>Prepare owner activation</button><button id="session-revoke" type="button" disabled>Prepare owner revocation</button></div>
<div class="row"><label>Session ID<input id="session-id" spellcheck="false" autocomplete="off"></label><button id="session-refresh" type="button">Check session and remaining limits</button></div>
<pre id="session-quota" tabindex="0" aria-label="Observed session quota" hidden></pre>
</fieldset></section></details>
`;
}
