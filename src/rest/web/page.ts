import { BRAND_CSS, BRAND_ICON } from "../../branding.js";
import { externalWalletDialogHtml, externalWalletCss } from "./externalWalletPage.js";
import { escapeHtml } from "./html.js";
import { smartWalletSections } from "./smartPage.js";

export function accountsPage(options: { scriptPath?: string; stylePath?: string; faviconPath?: string; audience?: string } = {}): string {
  const referenceOrigin = options.audience ?? "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Accounts | Signa</title><link rel="icon" type="image/svg+xml" href="${escapeHtml(options.faviconPath ?? "/favicon.svg")}"><link rel="stylesheet" href="${escapeHtml(options.stylePath ?? "/assets/accounts.css")}"><script type="module" src="${escapeHtml(options.scriptPath ?? "/assets/accounts.js")}"></script></head>
<body data-audience="${escapeHtml(options.audience ?? "")}"><main>
<header><a class="brand" href="${escapeHtml(referenceOrigin)}/api">${BRAND_ICON} <span class="brand-label">SIGNA</span></a><span>V6 / ACCOUNTS</span></header>
<h1>Your account.<br>Your bots.</h1>
<p class="lede">Sign in, choose what your app can do, and download its API connection. Your account stays in control of transaction approvals.</p>
<nav class="section-nav" aria-label="Account sections"><a href="#wallet-heading">Signa in</a><a href="#bots-heading">API access</a><a href="#smart-heading">Optional transaction wallet</a><a id="session-nav" href="#session-heading" hidden>Bot permissions</a><a href="${escapeHtml(referenceOrigin)}/api">API docs</a></nav>
<p id="status" role="status" aria-live="polite">Sign in to get started.</p>
<section aria-labelledby="wallet-heading"><h2 id="wallet-heading">01 / Sign in</h2>
<p>Use an existing wallet to create and manage API access.</p>
<div class="row"><button id="connect" type="button">Signa in</button><button id="disconnect" type="button" hidden>Sign out</button></div>
<p id="identity">Sign in to create or manage API access.</p>
</section>
<section aria-labelledby="bots-heading"><h2 id="bots-heading">02 / API access</h2>
<p>A bot is a program with its own key. Choose what it can do below. Each permission level includes the earlier ones; your wallet keeps control of signing transactions.</p>
<details class="permission-guide"><summary>Examples for each permission</summary>
<dl>
<dt>Read</dt><dd>Keep a dashboard up to date. Your bot checks project balances, settings and payment activity, then displays the results. It cannot prepare or submit transactions.</dd>
<dt>Read + plan</dt><dd>Prepare a payment for review. Your bot reads a project’s settings, prepares an unsigned payment plan and simulates its calls. You inspect the amount, recipient and simulation result. This connection stops before submission.</dd>
<dt>Read + plan + relay</dt><dd>Complete an approved payment. Your bot prepares and simulates the payment. You review and sign the transaction and approve submission. The same connection sends the signed transaction and tracks its confirmation.</dd>
</dl>
<p>Choose relay from the start for the complete flow: a plan belongs to the connection that prepared it. API access lets your bot prepare and submit requests. Spending permission is separate: on supported networks, you can approve a <a href="#smart-setup">wallet permission</a> once with exact actions, budgets and an expiry. Transactions outside those permissions need fresh owner approval.</p>
</details>
<fieldset id="bot-fields" disabled hidden><div class="row">
<label>Bot label<input id="bot-label" maxlength="120" value="My bot"></label>
<label>Expires in days<input id="bot-days" type="number" min="1" max="365" value="31"></label></div>
<label class="permission-field">API permissions<select id="bot-permissions"><option value="read">Read</option><option value="plan">Read + plan</option><option value="relay">Read + plan + relay</option></select></label>
<p>Choose your permissions, then approve API access in your wallet. Download one connection file containing your local key and account settings. Keep it private.</p>
<div class="row"><button id="generate-bot" type="button">Create API connection</button><button id="register-generated" type="button" hidden disabled>Download connection again</button></div>
<p id="pending-bot"></p>
<div id="connection-next" hidden><h3>Make your first request</h3><pre><code>npm install ${escapeHtml(options.audience ?? "https://juicebox.center")}/api/client/juicebox-center-client-0.1.0.tgz
chmod 600 juicebox-connection.json
npx center account --connection juicebox-connection.json</code></pre><p>Run these commands in the folder containing your connection file. <a href="${escapeHtml(referenceOrigin)}/api/docs/quickstart">Continue with JavaScript or TypeScript →</a></p></div>
<details><summary>Bring your own bot key</summary><p>Download a public proof request. Use the command-line tool (CLI) with your local key, then paste the registration JSON it creates. Keep the private key file on your machine.</p>
<button id="proof-request" type="button">Download proof request</button>
<label>Public registration JSON<textarea id="registration-json" rows="7" spellcheck="false" autocomplete="off" placeholder='{"format":"juicebox-center-bot-registration-v1",…}'></textarea></label>
<button id="review-proof" type="button">Review registration</button><pre id="proof-preview" hidden></pre><button id="register-proof" type="button" hidden>Sign and register this bot</button></details>
</fieldset>
<div id="bot-management" hidden><h3>Registered bots</h3><ul id="bot-list" class="bot-list"><li>Sign in to view your connections.</li></ul><div class="row"><button id="refresh-bots" type="button" disabled>Refresh bots</button></div></div>
</section>
${smartWalletSections(referenceOrigin)}
<footer>Private keys stay in your wallet or this page. Signatures approve exact API requests and reviewed blockchain actions.</footer>
</main>${externalWalletDialogHtml()}</body></html>`;
}
export function accountsCss(): string {
  return `${BRAND_CSS}${externalWalletCss}:root{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;color:#172119;background:#f4f4ed;font-size:15px;line-height:1.55;color-scheme:light}*{box-sizing:border-box;border-radius:0!important}body{margin:0}main{max-width:960px;margin:auto;padding:30px 24px 60px}header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid;padding-bottom:20px;font-size:12px;letter-spacing:.06em}a{color:inherit}.section-nav,.service-links{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:13px}.section-nav{margin:20px 0}.section-nav a,.service-links a{display:inline-flex;align-items:center;min-height:44px}h2{scroll-margin-top:20px}h1{font-size:clamp(42px,8vw,76px);font-weight:500;line-height:1.06;letter-spacing:-.05em;margin:50px 0 24px}.lede{max-width:630px;font-size:18px;margin-bottom:48px}section{border-top:1px solid #929a8f;padding:25px 0}h2{font-size:14px;letter-spacing:.06em;margin:0 0 22px}h3{font-size:14px;margin:0}p{max-width:760px}label{display:block;margin:0 0 16px;flex:1;min-width:160px}input:not([type=checkbox]),select,textarea{display:block;width:100%;font:inherit;padding:11px;border:1px solid #929a8f;background:#fff;color:inherit;margin-top:6px}textarea{resize:vertical}button{font:inherit;padding:11px 15px;border:1px solid #172119;background:#172119;color:#fff;cursor:pointer;min-height:46px}button:hover:not(:disabled){background:#334c37}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,pre:focus-visible{outline:3px solid #82a5ff;outline-offset:3px}fieldset{border:0;padding:0;margin:0;min-width:0}.row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin:12px 0}.row label{margin-bottom:0}.scopes{display:flex;flex-wrap:wrap;gap:20px;margin:20px 0}.scopes label{min-width:0;flex:0 1 auto;margin:0}.scopes input{accent-color:#172119;width:17px;height:17px;vertical-align:middle}details{border:1px solid #929a8f;margin:24px 0;padding:18px}summary{cursor:pointer}details[open]>summary{margin-bottom:18px}details>:last-child{margin-bottom:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e9ece2;padding:16px;font:inherit;font-size:13px;max-height:32rem;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.wallet-review{overflow-wrap:anywhere}#identity,#pending-bot{overflow-wrap:anywhere;font-size:13px}.bot-list{list-style:none;padding:0}.bot-list li{padding:16px 0;border-bottom:1px solid #b7bdb2;overflow-wrap:anywhere}.bot-list p{margin:4px 0;font-size:13px}.bot-list button{margin-top:10px}#status{border:1px solid;background:#e6eedb;padding:14px;max-width:none;overflow-wrap:anywhere}#status[data-error=true]{background:#ffe5db}footer{font-size:12px;margin-top:28px;color:#54624f}[hidden]{display:none!important}
select{appearance:none;min-height:46px;padding-right:42px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 16 16'%3E%3Cpath d='m3 6 5 5 5-5' fill='none' stroke='%23172119' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;background-size:14px}
.permission-field{width:min(100%,19rem)}
.permission-guide dl{margin:0}.permission-guide dt{font-weight:bold;margin-top:18px}.permission-guide dd{margin:6px 0 0;max-width:760px}
#smart-setup .smart-field{width:min(100%,22rem);min-width:0}#smart-setup .smart-number-field{width:min(100%,14rem)}
#smart-setup .network-selection{margin:18px 0}#smart-setup .network-selection legend{padding:0;font-size:14px;font-weight:bold}
#smart-setup .network-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:8px;margin:12px 0}
#smart-setup .network-choice{display:flex;align-items:center;gap:10px;min-width:0;margin:0;padding:10px 12px;border:1px solid #929a8f;overflow-wrap:anywhere;cursor:pointer}
#smart-setup .network-choice input[type=checkbox]{flex:0 0 auto;width:18px;height:18px;margin:0;accent-color:#172119}
#smart-setup .network-progress{margin:18px 0}#smart-setup .network-progress>ul{list-style:none;padding:0;margin:0}
#smart-setup .network-progress-item{padding:14px 0;border-bottom:1px solid #b7bdb2;overflow-wrap:anywhere}#smart-setup .network-progress-item p{margin:6px 0}
#smart-setup .smart-review{margin:18px 0;padding:14px;border:1px solid #929a8f;overflow-wrap:anywhere}#smart-setup .smart-review:empty{display:none}
#smart-setup .wallet-choice-list,#smart-setup .transaction-review-list{list-style:none;padding:0;margin:16px 0}
#smart-setup .wallet-choice-list li{margin:8px 0}#smart-setup .wallet-choice{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;background:#fff;color:inherit;border:1px solid #929a8f;text-align:left;white-space:normal;overflow-wrap:anywhere}
#smart-setup .wallet-choice:hover:not(:disabled),#smart-setup .wallet-choice[aria-pressed=true]{background:#e6eedb;border-color:#172119}
#smart-setup .transaction-review{margin-top:28px;padding-top:20px;border-top:1px solid #929a8f}#smart-setup .transaction-review-list p{margin:6px 0}#smart-setup .transaction-review-list button{margin-top:10px}
#smart-setup .wallet-technical:has(>pre[hidden]){display:none}
#smart-recovery h4{font-size:14px;margin:0}#smart-recovery .recovery-notice{padding:12px;border:1px solid #a42828;background:#ffe5db}
@media(forced-colors:active){select{appearance:auto;background-image:none}}
@media(max-width:560px){main{padding:20px 16px 40px}header{font-size:10px}h1{margin-top:36px}.row{align-items:stretch}.row>button{flex:1 1 160px}.row>label{flex-basis:100%}details{padding:13px}.lede{font-size:16px}}`;
}
