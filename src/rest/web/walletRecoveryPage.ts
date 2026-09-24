import { BRAND_ICON } from '../../branding.js';
import { walletSignupCss } from './walletSignupPage.js';

export function walletRecoveryPage(options: { base?: string } = {}) {
  const base = options.base ?? '/wallet';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><link rel="icon" type="image/svg+xml" href="${base}/assets/favicon.svg?v=signa"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Get back into your account | Signa</title>
<link rel="stylesheet" href="${base}/assets/wallet-recovery.css"><script type="module" src="${base}/assets/wallet-recovery.js"></script></head>
<body><main><a class="brand" id="wallet-back" href="${base || '/'}">${BRAND_ICON} <span class="brand-label">SIGNA</span></a>
<h1>Get back into your account</h1>
<p>Replace a lost passkey with your backup file, your backup password, or the wallet you chose at signup. Your account address stays the same.</p>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true">Checking…</p>
<fieldset id="recovery-method" hidden><legend>Use</legend>
<label class="choice"><input type="radio" name="recovery-method" value="kit" checked>My backup file</label>
<label class="choice"><input type="radio" name="recovery-method" value="password">My backup password</label>
<label class="choice"><input type="radio" name="recovery-method" value="wallet">A wallet I already have</label></fieldset>
<section id="recovery-kit" hidden aria-label="Backup file"><label>Open your backup file<input id="recovery-file" type="file" accept="application/json,.json"></label>
<p id="recovery-kit-status" class="hint">The file stays in this tab. Keep your saved copy.</p></section>
<section id="recovery-password" hidden aria-label="Backup password entry"><label>Backup password<textarea id="recovery-words" rows="3" maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
<p class="hint">It stays in this tab.</p></section>
<form id="recovery-form" hidden><div id="recovery-wallet-box"><label>Account address<input id="recovery-wallet" placeholder="0x…" maxlength="42" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
<p class="hint">The account to get back into. It's in your backup file.</p></div>
<label>New passkey name<input id="passkey-name" maxlength="120" autocomplete="off" required></label>
<button type="submit" id="recovery-begin">Continue</button></form>
<section id="recovery-details" hidden aria-label="Recovery details"><dl><dt>New passkey name</dt><dd id="recovery-name"></dd>
<dt>Account address</dt><dd id="recovery-address"></dd><dt>Backup key</dt><dd id="recovery-owner"></dd>
</dl><details><summary>Passkey details</summary><dl><dt>Previous passkey signer</dt><dd id="recovery-prior"></dd>
<dt>Replacement passkey signer</dt><dd id="recovery-replacement"></dd></dl></details></section>
<section id="recovery-review" hidden aria-label="Replacement review"><h2>Replace the lost passkey</h2>
<p>Approve these two actions on Base:</p><ol><li>Create the replacement passkey signer.</li><li>Replace the previous passkey signer on your account.</li></ol>
<p>The new passkey will control this account. Your backup key stays the same.</p>
<dl><dt>Safe transaction nonce</dt><dd id="recovery-nonce"></dd><dt>Signer factory</dt><dd id="recovery-factory"></dd></dl>
<details><summary>Exact approved calls</summary><pre id="recovery-calls"></pre></details></section>
<section id="recovery-transactions" hidden aria-label="Transactions"><h2>Transactions</h2><p>These references track this recovery.</p><ul id="recovery-hashes"></ul></section>
<div class="actions"><button type="button" id="recovery-next" hidden></button>
<button type="button" id="recovery-check" class="link" hidden>Check again</button>
<button type="button" id="recovery-restart" class="link" hidden>Start again</button>
<button type="button" id="recovery-cancel" class="link" hidden>Cancel prompt</button></div>
<section id="recovery-resume-section" hidden><details><summary>Resume a recovery you started</summary>
<p class="hint">Use the replacement passkey and your backup. The reference is public and cannot approve anything on its own.</p>
<label>Recovery reference<input id="recovery-id" maxlength="36" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
<button type="button" id="recovery-resume" class="link">Resume</button></details></section>
<a id="recovery-signin" href="${base || '/'}" hidden>Signa in</a>
<noscript><p>Enable JavaScript to get back into your account.</p></noscript></main></body></html>`;
}

export function walletRecoveryCss() {
  return walletSignupCss() + '\npre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:inherit;font-size:.8rem}ol,ul{padding-left:1.5rem}li{overflow-wrap:anywhere;line-height:1.6;margin:.75rem 0}#recovery-review,#recovery-resume-section{margin:2rem 0}#recovery-signin{display:inline-block;margin-top:1.5rem;color:inherit}';
}
