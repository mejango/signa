import { BRAND_ICON } from '../../branding.js';
import { walletSignupCss } from './walletSignupPage.js';

/** The page a second device opens from the link the account page showed. */
export function walletDevicePage(options: { base?: string } = {}) {
  const base = options.base ?? '/wallet';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><link rel="icon" type="image/svg+xml" href="${base}/assets/favicon.svg?v=signa"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>Add this device | Signa</title>
<link rel="stylesheet" href="${base}/assets/wallet-device.css"><script type="module" src="${base}/assets/wallet-device.js"></script></head>
<body><main><a class="brand" href="${base || '/'}">${BRAND_ICON} SIGNA</a>
<h1>Add this device</h1>
<p id="device-intro">This device gets its own passkey for your account. The device you started from approves it.</p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true">Checking the link…</p>
<section id="device-details" hidden aria-label="Account"><dl><dt>Account address</dt><dd id="device-address"></dd><dt>Passkey name</dt><dd id="device-name"></dd></dl></section>
<div class="actions"><button type="button" id="device-next" hidden></button>
<button type="button" id="device-cancel" class="link" hidden>Cancel prompt</button></div>
<a id="device-signin" href="${base || '/'}" hidden>Signa in on this device</a>
<noscript><p>Enable JavaScript to add this device.</p></noscript></main></body></html>`;
}
export function walletDeviceCss() { return walletSignupCss(); }
