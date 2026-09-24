import { BRAND_ICON } from '../../branding.js';
import { walletCss } from './walletPage.js';
export function walletSignupPage(options: { base?: string } = {}) {
  const base = options.base ?? '/wallet';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="wallet-base" content="${base}"><link rel="icon" type="image/svg+xml" href="${base}/assets/favicon.svg?v=signa"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Your account | Signa</title>
<link rel="stylesheet" href="${base}/assets/wallet-signup.css"><script type="module" src="${base}/assets/wallet-signup.js"></script></head>
<body><main><a class="brand" id="wallet-back" href="${base || '/'}">${BRAND_ICON} SIGNA</a>
<h1>Your account</h1>
<p id="wallet-status" role="status" aria-live="polite" aria-atomic="true">Checking your signup…</p>
<form id="signup-form" hidden><label>Passkey name<input id="passkey-name" maxlength="120" autocomplete="off" required></label>
<fieldset id="recovery-method"><legend>If you lose this passkey, get back in with</legend>
<label class="choice"><input type="radio" name="recovery-method" value="kit" checked>A backup password made for you</label>
<label class="choice"><input type="radio" name="recovery-method" value="wallet">A wallet you already have</label></fieldset>
<button type="submit" id="signup-begin">Signa up</button></form>
<section id="signup-details" hidden aria-label="Account details"><dl><dt>Account address</dt><dd id="signup-address"></dd>
<dt>Passkey name</dt><dd id="signup-name"></dd>
<dt id="signup-recovery-label">Recovery</dt><dd><span id="signup-recovery"></span>
<div class="secret" id="recovery-secret" hidden><input id="recovery-phrase" type="password" readonly aria-label="Backup password" autocomplete="off">
<button type="button" id="recovery-show" class="quiet">Show</button><button type="button" id="recovery-copy" class="quiet">Copy</button></div></dd></dl></section>
<section id="recovery-kit" hidden aria-label="Backup password">
<p id="recovery-warning" hidden>Anyone with this backup password can control your account. A lost backup password can't be recovered.</p>
<p id="recovery-kit-note">The backup file holds this password and your account address. Save it before creating your account, somewhere private you'll remember, or share it with someone you trust with your money.</p>
<div class="actions"><button type="button" id="recovery-download" class="secondary">Save backup file</button><button type="button" id="recovery-share" class="secondary" hidden>Share</button></div>
<div id="recovery-restore-box" hidden><p class="hint">Open your saved backup file or restore its password to continue. If you did not save either, <a href="#" id="recovery-restart-link">start over</a>.</p>
<details id="recovery-verify"><summary>Open your saved backup file</summary><label>Backup file<input id="recovery-file" type="file" accept="application/json,.json"></label></details>
<details><summary>Restore the backup password</summary><label>Saved backup password<textarea id="recovery-words" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
<button type="button" id="recovery-restore">Restore backup password</button></details></div></section>
<div class="actions"><button type="button" id="signup-next" hidden></button>
<button type="button" id="signup-check" hidden>Check signup</button>
<button type="button" id="signup-cancel" class="link" hidden>Cancel prompt</button></div>
<button type="button" id="signup-restart" class="quiet" hidden>Start over</button>
<div id="signup-links"><a href="#" id="signup-resume" hidden>Signa in</a><a id="signup-fullscreen" target="_top" rel="noopener" title="Fullscreen" hidden>Fullscreen</a></div>
<dialog id="signup-explain"><form method="dialog"><h2 id="explain-title"></h2><p id="explain-text"></p>
<div class="actions"><button value="continue" id="explain-continue">Continue</button><button value="cancel" class="quiet">Cancel</button></div></form></dialog>
<noscript><p>Enable JavaScript to create or resume your account.</p></noscript></main></body></html>`;
}
export function walletSignupCss() { return walletCss() + '\nlabel{display:grid;gap:.6rem;margin:1rem 0}input,textarea{box-sizing:border-box;font:inherit;min-height:3rem;width:100%;border:1px solid #172019;border-radius:0;background:white;color:inherit;padding:.75rem}fieldset{margin:1.5rem 0;padding:1rem;border:1px solid #172019;min-width:0}.choice{display:flex;align-items:center}.choice input{width:1.25rem;min-height:1.25rem;margin:0}.secret{display:flex;align-items:center;gap:1rem;margin:.25rem 0 0}.secret input{flex:1;min-width:0;letter-spacing:.08em;min-height:auto;padding:0;border:0;background:none;cursor:default;font-size:1.1rem}.secret input:focus{outline:none}.secret .quiet{margin:0;flex:none}#recovery-kit{margin:1.5rem 0 2rem}details{margin:1.25rem 0}summary{cursor:pointer;color:#53614f}#signup-details{margin-top:2rem}#wallet-status{margin:1.25rem 0}#wallet-status:empty{display:none;margin:0}#signup-form>label{margin-top:0}#recovery-method{border:0;padding:0;margin:.5rem 0 1.5rem}#recovery-method legend{padding:0;margin-bottom:.75rem}#recovery-method .choice{margin:.5rem 0}#signup-form label{margin-top:.5rem}dialog{border:1px solid var(--wallet-line);border-radius:var(--wallet-radius);background:var(--wallet-bg);color:inherit;padding:1.5rem;max-width:26rem;margin:auto;font:inherit}#signup-links{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;margin-top:1.75rem}#signup-links a{color:var(--wallet-muted);font-size:.9rem;text-underline-offset:.15em}#signup-links a:hover{color:var(--wallet-fg)}html.framed #signup-links{margin-top:1rem}dialog::backdrop{background:rgba(23,32,25,.45)}dialog h2{margin:0 0 .75rem;font-size:1.1rem}dialog p{margin:0 0 1.25rem}dialog .actions{margin:0;display:flex;align-items:flex-end;justify-content:space-between;gap:1.25rem}main>.actions{margin-top:1.5rem}main>.actions:not(:has(> :not([hidden]))){display:none}dialog .quiet{margin:0;line-height:1}.quiet{background:none;border:0;padding:0;margin-top:2.5rem;font:inherit;font-size:.85rem;color:#53614f;text-decoration:underline;cursor:pointer}.quiet:hover:not(:disabled){background:none;color:#172019}.quiet:disabled{opacity:.5}.hint{color:#53614f}.hint a{color:inherit}.hint{margin:0 0 1.25rem}#recovery-hint:empty{display:none}input[type=file]{overflow:hidden}'; }
