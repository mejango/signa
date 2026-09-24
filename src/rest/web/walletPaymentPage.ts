import { BRAND_ICON } from '../../branding.js';
/** Dedicated owner approval surface. Values are populated with textContent, never HTML. */
export function walletPaymentPage(base = '/wallet'): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><link rel="icon" type="image/svg+xml" href="${base}/assets/favicon.svg?v=signa"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Review payment | Signa</title>
<link rel="stylesheet" href="${base}/assets/wallet.css"><link rel="stylesheet" href="${base}/assets/wallet-payment.css">
<script type="module" src="${base}/assets/wallet-payment.js"></script></head>
<body><main><a class="brand" href="${base || '/'}">${BRAND_ICON} SIGNA</a><h1>Review payment</h1>
<p id="payment-status" role="status" aria-live="polite" aria-atomic="true" data-state="loading">Checking this payment…</p>
<section id="payment-review" aria-label="Payment details" hidden>
<p id="payment-amount" class="amount"></p>
<details class="quiet"><summary>Details</summary><dl>
<dt>Juicebox project</dt><dd id="payment-project"></dd><dt>Network</dt><dd>Base</dd>
<dt>Requested by</dt><dd id="payment-app"></dd><dt>From your account</dt><dd id="payment-account"></dd>
<dt>Beneficiary</dt><dd id="payment-beneficiary"></dd><dt>Minimum project tokens (base units)</dt><dd id="payment-minimum"></dd>
<dt>Memo</dt><dd id="payment-memo" class="exact-text"></dd><dt>Execution fee ceiling</dt><dd id="payment-fee"></dd>
<dt>USDC contract</dt><dd id="payment-token"></dd><dt>Juicebox terminal</dt><dd id="payment-terminal"></dd>
<dt>Metadata</dt><dd id="payment-metadata"></dd><dt>Operation</dt><dd id="payment-operation"></dd>
<dt>Approval expires</dt><dd id="payment-expiry"></dd></dl></details></section>
<div class="actions"><button id="payment-approve" type="button" hidden>Approve payment</button>
<button id="payment-cancel" type="button" class="link" hidden>Decline</button>
<button id="payment-prompt-cancel" type="button" class="secondary" hidden>Cancel passkey prompt</button>
<button id="payment-retry" type="button" class="secondary" hidden>Check payment again</button>
<a id="payment-return" class="action-link" hidden>Return to app</a></div>
<noscript><p>Enable JavaScript to review and approve this payment.</p></noscript></main></body></html>`;
}

export function walletPaymentCss(): string {
  return `#payment-status{min-height:3rem;margin:1.75rem 0;color:#53614f}
#payment-status[data-state=error],#payment-status[data-state=unknown],#payment-status[data-state=expired]{color:#9c3028}
.amount{font-size:clamp(1.8rem,7vw,2.5rem);font-weight:700;margin:1.5rem 0}.exact-text{white-space:pre-wrap}
details{margin:1.5rem 0}summary{cursor:pointer;text-decoration:underline;line-height:1.5}details dl{margin-top:1rem}
details.quiet>summary{list-style:none;display:inline-block;color:#53614f;font-size:.9rem;text-underline-offset:.15em}details.quiet>summary::-webkit-details-marker{display:none}details.quiet>summary:hover{color:#172019}
details.quiet>summary::after{content:"";display:inline-block;width:.35em;height:.35em;margin:0 0 .1em .55em;border:solid currentColor;border-width:0 1px 1px 0;transform:rotate(-45deg);transition:transform .15s}details.quiet[open]>summary::after{transform:rotate(45deg);margin-bottom:.2em}
#payment-status:empty{display:none}
/* Framed inside the app's page: the app's gutter is 2.7rem and the frame sits 1.6rem into it, so 1.1rem here
 * (less the border) lines this text up with the app's; no brand or page margins. */
html.framed main{margin:0 auto;padding:1.25rem calc(1.6rem - 1px) 1.5rem}html.framed .brand{display:none}html.framed h1{margin-top:.5rem}html.framed #payment-status{margin:1rem 0}
.actions button.link{margin:0}
.action-link{display:inline-flex;align-items:center;min-height:3rem;padding:.75rem 1rem;border:1px solid #172019;color:inherit;max-width:100%;overflow-wrap:anywhere}
@media(max-width:400px){.action-link{justify-content:center;width:100%}}`;
}
