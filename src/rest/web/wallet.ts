import { nativePasskeyError } from './walletPasskeyError.js';
import { base } from './walletBase.js';
import { qrSvg } from "./qr.js";
import { checkedRedirect, framed, listenForTheme } from "./walletFramed.js";
/** No credentials, assertions, CSRF values or handoff codes are persisted by this page. */
type Json = Record<string, unknown>;
type Configuration = { issuer: string; audience: string; rpId: string };
type Session = { accountId: string; loginId: string; walletAddress: string; chainId: number; expiresAtMs: number; passkeyName: string | null };
type Intent = { id: string; callbackUri: string; state: string; expiresAtMs: number };
type Completion = { loginId: string; assertion: { credentialId: string; userHandle: string | null;
  authenticatorData: string; clientDataJSON: string; signature: string } };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("wallet-status"), account = element("wallet-account"), address = element("wallet-address"), passkey = element("wallet-passkey"), passkeyLabel = element("wallet-passkey-label");
// The account on more chains: a list, an "Add more" text button, a chain picker, one quote and one passkey approval.
type NetworksView = { networks: { chainId: number; name: string; state: string; txHash: string | null }[];
  offered: { chainId: number; name: string; family: string; centerPays: boolean }[]; pending: { id: string; state: string; chainIds: number[] }[] };
const networksList = element("wallet-networks"), networksAdd = element<HTMLButtonElement>("wallet-networks-add"), networksForm = element<HTMLFormElement>("wallet-networks-form");
let networksView: NetworksView | null = null, networksQuote: { bundleId: string; challenge: string } | null = null, networksTimer: ReturnType<typeof setInterval> | null = null, networksOpen = false, networksPolls = 0;
const destination = element("wallet-destination");
// Adding a device: begin here, show the other device its link, approve with this passkey once it has proved its own.
type DeviceView = { id: string; phase: string; passkeyName: string | null; deviceSigner: string | null; expiresAtMs: number; transactionHashes: string[] };
const deviceAdd = element<HTMLButtonElement>("wallet-device-add"), devicePanel = element("wallet-device"), deviceApprove = element<HTMLButtonElement>("wallet-device-approve");
let device: { view: DeviceView; link: string } | null = null, deviceTimer: ReturnType<typeof setInterval> | null = null;
const signIn = element<HTMLButtonElement>("wallet-signin"), retry = element<HTMLButtonElement>("wallet-retry");
const deviceSignInLabel = /iPhone/.test(navigator.userAgent) ? "Face ID"
  : /Macintosh|iPad/.test(navigator.userAgent) ? "Touch ID"
  : /Windows/.test(navigator.userAgent) ? "Windows Hello"
  : "your device";
const deviceSignInPrompt = `Use ${deviceSignInLabel} to sign in.`;
signIn.textContent = "Signa in";
const cancel = element<HTMLButtonElement>("wallet-cancel"), signOut = element<HTMLButtonElement>("wallet-logout");
let configuration: Configuration, intent: Intent | null = null, session: Session | null = null, framerOrigin: string | null = null;
let sessionKnown = false, busy = false, csrf = "", pending: Completion | null = null;
let completionAttempted = false;
let paymentReviewId: string | null = null;
let nativePrompt: AbortController | null = null, retryAction: (() => Promise<void>) | null = null;
let nextRetry: () => Promise<void> = load;
// Framed inside an admitted app's page, this page signs in without a Center session or cookie: the
// intent admits it, the launch signature kept on the row is the browser-launch claim, and one
// passkey assertion naming the app as its top origin both signs in and approves the grant. Only an
// app the operator admits can frame this page at all (frame-ancestors), so the sign-in button asks
// just that the frame be large enough and the button be scrolled into view; Intersection Observer
// v2's occlusion verdict is not consulted here, because browsers report every element inside a
// top-layer <dialog> — where the app's sign-in modal puts the frame — as not visible. The bar is
// lower than the payment review's on purpose: an admitted app that overlaid this button would gain
// only a grant to itself, behind the browser's own passkey prompt; a review moves funds.
const openAsPage = document.getElementById("wallet-open") as HTMLAnchorElement | null;
let signInVisible = !framed;
if (framed) {
  try {
    const observer = new IntersectionObserver(entries => { const entry = entries[entries.length - 1]; if (!entry) return;
      signInVisible = entry.isIntersecting; render(); }, { threshold: 0.9 });
    observer.observe(signIn);
  } catch { signInVisible = true; }
}
const frameTooSmall = () => framed && window.innerWidth < 300;

class InvalidResponse extends Error {}
class HttpFailure extends Error { constructor(readonly status: number, readonly code?: string, readonly appOrigin?: string) { super("Wallet request failed"); } }
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidResponse();
  return value as Json;
}
function string(value: unknown, maximum = 2048): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new InvalidResponse();
  return value;
}
function future(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= Date.now()) throw new InvalidResponse();
  return value;
}
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decode(value: unknown): Uint8Array<ArrayBuffer> {
  const encoded = string(value, 4096);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new InvalidResponse();
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)); }
  catch { throw new InvalidResponse(); }
  if (encode(bytes.buffer) !== encoded) throw new InvalidResponse();
  return bytes;
}
function token(value: unknown): string {
  if (decode(value).length !== 32) throw new InvalidResponse();
  return value as string;
}
function setStatus(state: string, message: string) { status.dataset.state = state; status.textContent = message; }
function render() {
  signIn.hidden = !sessionKnown || !!session || !!pending || !!retryAction;
  signIn.disabled = busy || frameTooSmall() || !signInVisible;
  if (openAsPage) openAsPage.hidden = !framed || !intent;
  retry.hidden = !retryAction || busy;
  retry.textContent = retryAction === load || retryAction === readSession ? "Check account" : "Retry";
  // A page that is leaving for an app shows nothing it has not shown yet.
  const leaving = !!intent && busy;
  signOut.hidden = !session || leaving; signOut.disabled = busy;
  cancel.hidden = !nativePrompt;
  account.hidden = !session || leaving; address.textContent = session?.walletAddress ?? "";
  // Signed in, the page is the account; the ways in belong to the signed-out page only.
  // The signed-out links belong to a page that knows there is no session, not to a check in progress or a failed one.
  const links = document.getElementById("wallet-links"); if (links) links.hidden = !!session || !sessionKnown;
  renderNetworks(); renderDevice();
  passkey.textContent = session?.passkeyName ?? ""; passkey.hidden = passkeyLabel.hidden = !session?.passkeyName;
}
async function request(path: string, body?: unknown, csrfToken?: string, timeoutMs = 10_000): Promise<Json> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: {
        "content-type": "application/json", "x-center-wallet-request": "1", ...(csrfToken ? { "x-center-wallet-csrf": csrfToken } : {}),
      } }) });
    if (!response.ok) {
      let code: string | undefined, appOrigin: string | undefined;
      if (path === `${base}/authorize/issue` && response.status === 403) {
        const body = await response.json().catch(() => null);
        if (body?.error?.code === 'WALLET_HANDOFF_UNCLAIMED') code = 'WALLET_HANDOFF_UNCLAIMED';
      } else if (path.startsWith(`${base}/authorize/`) && response.status === 410) {
        // The app's request timed out; its public origin lets this page point back to it.
        const body = await response.json().catch(() => null), origin = body?.app?.origin;
        if (body?.error?.code === 'WALLET_HANDOFF_EXPIRED') { code = 'WALLET_HANDOFF_EXPIRED'; if (typeof origin === 'string' && /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(origin)) appOrigin = origin; }
      } else if (response.status >= 400 && response.status < 500) {
        const body = await response.json().catch(() => null);
        if (typeof body?.error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.error.code)) code = body.error.code;
      }
      throw new HttpFailure(response.status, code, appOrigin);
    }
    return record(await response.json());
  } finally { clearTimeout(timer); }
}
/** Retries a 503 while the wallet's authority is being checked. Reads stop after three quick
 * attempts; an action the user is waiting on (`attempts`, `delayMs`) may wait for a hosted
 * authority refresh, which takes tens of seconds after the account has been idle. */
async function readyRequest(path: string, body?: unknown, csrfToken?: string, timeoutMs?: number, attempts = 3, delayMs?: number): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(path, body, csrfToken, timeoutMs); }
    catch (error) {
      if (!(error instanceof HttpFailure) || error.status !== 503 || attempt === attempts - 1) throw error;
      setStatus("checking", "Checking current wallet access. This may take a moment…");
      await new Promise(resolve => setTimeout(resolve, delayMs ?? (attempt + 1) * 400));
    }
  }
}
function acceptSession(value: Json, required = false) {
  if (value.session === null && !required) { session = null; csrf = ""; sessionKnown = true; return; }
  const current = record(value.session), walletAddress = string(current.walletAddress, 42);
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress) || current.chainId !== 8453
    || string(current.accountId).toLowerCase() !== `eip155:8453:${walletAddress.toLowerCase()}`) throw new InvalidResponse();
  const nextCsrf = token(value.csrfToken), expiresAtMs = future(current.expiresAtMs);
  const passkeyName = current.passkeyName === null || current.passkeyName === undefined ? null : string(current.passkeyName, 120);
  session = { accountId: current.accountId as string, loginId: string(current.loginId, 36), walletAddress, chainId: 8453, expiresAtMs, passkeyName };
  csrf = nextCsrf; sessionKnown = true;
  // A page about to leave for an app or a payment review does not need the networks list.
  if (!intent && !paymentReviewId) void refreshNetworks().catch(() => { /* The list stays at Base until the next load. */ });
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true; retryAction = null; render();
  try { await action(); }
  catch (error) {
    if (error instanceof HttpFailure && error.code === 'WALLET_HANDOFF_EXPIRED') {
      const host = error.appOrigin ? new URL(error.appOrigin).host : "the app";
      setStatus("error", `Your sign-in from ${host} timed out. Go back to ${host} and connect again.`);
      if (error.appOrigin) { const link = document.createElement("a"); link.href = new URL("/", error.appOrigin).href; link.textContent = `Open ${host}`; status.append(" ", link); }
      sessionKnown = false;
    } else if (error instanceof HttpFailure && error.code === 'WALLET_HANDOFF_UNCLAIMED') {
      setStatus('error', 'This connection belongs to another tab or has expired. Return to the app and connect again.');
    } else if (error instanceof DOMException && nativePrompt) {
      const feedback = nativePasskeyError(error, nativePrompt.signal.aborted);
      setStatus(feedback.state, feedback.message);
    } else if (error instanceof InvalidResponse) {
      setStatus("error", "This wallet request could not be verified. Return to the app and start again.");
      // An unverified result never makes a previously unknown session safe to replace.
    } else if (error instanceof HttpFailure && error.code === 'WALLET_LOGIN_UNKNOWN_PASSKEY') {
      pending = null; csrf = ""; completionAttempted = false;
      setStatus("ready", "That passkey isn't linked to an account here. It may be left over from a signup that didn't finish. Try another passkey, or sign up.");
    } else if (error instanceof HttpFailure && [400, 401, 403, 404, 410].includes(error.status)) {
      if (pending) {
        pending = null; csrf = ""; completionAttempted = false;
        setStatus("ready", "This sign-in expired or could not be authorized. Try your passkey again.");
      } else {
        retryAction = framed ? load : readSession;
        setStatus("retry", "Account access changed or the request expired. Check your account again.");
      }
    } else {
      retryAction = nextRetry;
      setStatus("retry", pending
        ? "Sign-in confirmation is unavailable. Retry to check the same sign-in without using your passkey again."
        : "Wallet access is temporarily unavailable. Retry to check again.");
    }
  } finally { nativePrompt = null; busy = false; render(); }
}
async function load() {
  nextRetry = load; setStatus("loading", "Checking your account…");
  const query = new URL(location.href);
  if (query.hash || [...query.searchParams.keys()].some(key => !["intent", "payment"].includes(key)) || query.searchParams.size > 1) throw new InvalidResponse();
  paymentReviewId = query.searchParams.get("payment");
  if (paymentReviewId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(paymentReviewId)) throw new InvalidResponse();
  const intentId = query.searchParams.has("intent") ? token(query.searchParams.get("intent")) : null;
  // The reads this page opens with do not depend on one another: they go out together and are checked in order.
  const configRead = request(`${base}/config`);
  const authorization = intentId ? request(`${base}/authorize/${intentId}`) : null;
  ahead = readyRequest(`${base}/session`, undefined, undefined, 100_000);
  for (const read of [authorization, ahead]) read?.catch(() => undefined);
  const config = await configRead;
  if (config.version !== "center-wallet-v1" || config.issuer !== location.origin) throw new InvalidResponse();
  const create = document.getElementById("wallet-create") as HTMLAnchorElement | null;
  if (create) { create.href = `${base}/create` + query.search; create.hidden = false; }
  const recover = document.getElementById("wallet-recover") as HTMLAnchorElement | null;
  if (recover) { recover.href = `${base}/recover` + query.search; recover.hidden = false; }
  // In a frame the three ways out share one row, in the app's words.
  if (openAsPage) openAsPage.href = `${base}${query.search}`;
  if (framed) {
    // Signing up stays in the frame (Center admits the same app to frame it); recovery and the page of its own open on top.
    for (const link of [recover, openAsPage]) if (link) { link.target = "_top"; link.rel = "noopener"; }
    if (recover) recover.textContent = "Recover";
    if (openAsPage) { openAsPage.textContent = "Fullscreen"; openAsPage.title = "Fullscreen"; document.getElementById("wallet-links")?.append(openAsPage); }
  }
  const rpId = string(config.rpId, 253);
  if (location.hostname !== rpId && !location.hostname.endsWith(`.${rpId}`)) throw new InvalidResponse();
  configuration = { issuer: location.origin, audience: string(config.audience), rpId };
  if (intentId) {
    const result = await authorization!, requested = record(result.request);
    if (result.id !== intentId || !["prepared", "issued"].includes(String(result.state))
      || requested.issuer !== configuration.issuer || requested.audience !== configuration.audience) throw new InvalidResponse();
    const callbackUri = string(requested.callbackUri), callback = new URL(callbackUri);
    if (callback.origin !== requested.origin || callback.username || callback.password || callback.hash || callback.search
      || callback.href !== callbackUri || !["https:", "http:"].includes(callback.protocol)) throw new InvalidResponse();
    intent = { id: intentId, callbackUri, state: token(requested.state), expiresAtMs: future(result.expiresAtMs) };
    framerOrigin = callback.origin;
    // Inside the app's own page there is nowhere else to return to.
    destination.textContent = `Returning to ${callback.origin} after sign-in.`; destination.hidden = framed;
  }
  if (framed && intent) {
    listenForTheme(framerOrigin!);
    // No cookie reaches a cross-site frame, so there is no session to read; the sign-in below carries its own proof.
    ahead?.catch(() => undefined); ahead = null; session = null; sessionKnown = true;
    setStatus("ready", "Using Signa"); return;
  }
  await readSession();
}
let ahead: Promise<Json> | null = null;
async function readSession() {
  nextRetry = readSession; setStatus("checking", "Checking current wallet access…");
  const read = ahead ?? readyRequest(`${base}/session`, undefined, undefined, 100_000); ahead = null;
  acceptSession(await read);
  await continueSession();
}
async function continueSession() {
  if (session && paymentReviewId) {
    setStatus("returning", "Returning to your payment review…");
    location.replace(`${base}/payment?review=${paymentReviewId}`);
  }
  else if (session && intent) await issue();
  // A direct visit without a session or an app return belongs on the signup page, which also logs in.
  else if (!session && !intent && !paymentReviewId && document.getElementById("wallet-create")) location.replace(`${base}/create`);
  else setStatus(session ? "signed-in" : "ready", session ? "You are signed in." : "Use Face ID, Touch ID, a screen lock, or a security key.");
}
async function login() {
  nextRetry = login;
  if (framed && intent) return framedSignIn();
  if (pending) return completeLogin();
  if (!window.isSecureContext || !navigator.credentials?.get) {
    setStatus("error", "This browser cannot use passkeys here. Open Signa in a browser that supports passkeys."); return;
  }
  setStatus("checking", "Preparing your sign-in…");
  const begun = await request(`${base}/login/begin`, {}), publicKey = record(begun.publicKey);
  if (publicKey.rpId !== configuration.rpId || publicKey.userVerification !== "required" || publicKey.timeout !== 90_000) throw new InvalidResponse();
  const challenge = decode(publicKey.challenge); if (challenge.length !== 32) throw new InvalidResponse();
  const loginId = string(begun.loginId, 36); future(begun.expiresAtMs);
  const flowCsrf = token(begun.csrfToken);
  nativePrompt = new AbortController(); setStatus("authenticating", deviceSignInPrompt); render();
  const credential = await navigator.credentials.get({ publicKey: { rpId: configuration.rpId, challenge,
    userVerification: "required", timeout: 90_000 }, signal: nativePrompt.signal });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new InvalidResponse();
  const assertion = credential.response;
  pending = { loginId, assertion: { credentialId: encode(credential.rawId), userHandle: assertion.userHandle ? encode(assertion.userHandle) : null,
    authenticatorData: encode(assertion.authenticatorData), clientDataJSON: encode(assertion.clientDataJSON), signature: encode(assertion.signature) } };
  csrf = flowCsrf; nativePrompt = null; render();
  completionAttempted = false;
  await completeLogin();
}
async function completeLogin() {
  nextRetry = completeLogin;
  if (!pending) throw new InvalidResponse();
  setStatus("checking", "Confirming your account access…");
  if (completionAttempted) {
    // Success headers can install the session and clear the flow cookie before its body
    // arrives. Only this exact login can recover the selected credential's completion.
    const recovered = await readyRequest(`${base}/session`);
    if (recovered.session && record(recovered.session).loginId === pending.loginId) {
      acceptSession(recovered, true); pending = null; completionAttempted = false;
      await continueSession(); return;
    }
    // A different tab's session must neither replace this identity nor its flow CSRF.
  }
  completionAttempted = true;
  // Completion may refresh the account's authority on Base first; the site holds the request up to 90 s.
  setStatus("checking", "Checking your account. This can take up to a minute…");
  const result = await readyRequest(`${base}/login/complete`, pending, csrf, 100_000);
  if (record(result.session).loginId !== pending.loginId) throw new InvalidResponse();
  acceptSession(result, true);
  pending = null; completionAttempted = false;
  await continueSession();
}
// The framed sign-in: begin, one passkey prompt, approve; the approval's answer is the app's callback.
async function framedSignIn() {
  nextRetry = framedSignIn;
  if (!intent) throw new InvalidResponse();
  if (frameTooSmall() || !signInVisible) { setStatus("ready", "Open this sign-in as a page of its own to continue."); return; }
  if (!window.isSecureContext || !navigator.credentials?.get) {
    setStatus("error", "This browser cannot use passkeys here. Open Signa in a browser that supports passkeys."); return;
  }
  future(intent.expiresAtMs);
  setStatus("checking", "Preparing your sign-in…");
  const begun = await request(`${base}/authorize/${intent.id}/begin`, {}), publicKey = record(begun.publicKey);
  if (publicKey.rpId !== configuration.rpId || publicKey.userVerification !== "required" || publicKey.timeout !== 90_000) throw new InvalidResponse();
  const challenge = decode(publicKey.challenge); if (challenge.length !== 32) throw new InvalidResponse();
  const loginId = string(begun.loginId, 36), flowToken = token(begun.flowToken); future(begun.expiresAtMs);
  nativePrompt = new AbortController(); setStatus("authenticating", deviceSignInPrompt); render();
  const credential = await navigator.credentials.get({ publicKey: { rpId: configuration.rpId, challenge,
    userVerification: "required", timeout: 90_000 }, signal: nativePrompt.signal });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new InvalidResponse();
  const assertion = credential.response;
  nativePrompt = null;
  // Approval may refresh the account's authority on Base first; the site holds the request up to 90 s.
  setStatus("checking", "Checking your account. This can take up to a minute…");
  const result = await readyRequest(`${base}/authorize/${intent.id}/approve`, { loginId, flowToken, assertion: {
    credentialId: encode(credential.rawId), userHandle: assertion.userHandle ? encode(assertion.userHandle) : null,
    authenticatorData: encode(assertion.authenticatorData), clientDataJSON: encode(assertion.clientDataJSON), signature: encode(assertion.signature) } },
    undefined, 100_000);
  setStatus("returning", "Returning to your app…");
  location.replace(appReturn(result));
}
/** The app's return, checked; anything else is an unverifiable response, never a navigation. */
function appReturn(result: Json): string {
  try { return checkedRedirect(result, intent!, configuration.issuer); } catch { throw new InvalidResponse(); }
}
async function issue() {
  nextRetry = issue;
  if (!intent || !session) throw new InvalidResponse();
  future(intent.expiresAtMs); future(session.expiresAtMs);
  setStatus("returning", "Returning to your app…");
  // Issuing needs fresh on-chain authority; after idle that is a hosted refresh of ~25 s.
  const result = await readyRequest(`${base}/authorize/issue`, { intentId: intent.id }, csrf, undefined, 90, 1000);
  location.replace(appReturn(result));
}
async function logout() {
  nextRetry = logout; setStatus("checking", "Signing out…");
  const result = await request(`${base}/logout`, {}, csrf);
  if (result.loggedOut !== true) throw new InvalidResponse();
  session = null; csrf = ""; pending = null; completionAttempted = false; sessionKnown = true;
  setStatus("ready", "You are signed out. You can sign in again with your passkey.");
}
function networkView(value: Json): NetworksView {
  const v = record(value);
  const list = (items: unknown, keys: string[]) => (Array.isArray(items) ? items : []).map(item => { const r = record(item); for (const key of keys) if (!(key in r)) throw new InvalidResponse(); return r; });
  return { networks: list(v.networks, ["chainId", "name", "state"]).map(r => ({ chainId: Number(r.chainId), name: string(r.name, 40), state: string(r.state, 20), txHash: typeof r.txHash === "string" ? r.txHash : null })),
    offered: list(v.offered, ["chainId", "name", "family", "centerPays"]).map(r => ({ chainId: Number(r.chainId), name: string(r.name, 40), family: string(r.family, 10), centerPays: r.centerPays === true })),
    pending: list(v.pending, ["id", "state", "chainIds"]).map(r => ({ id: string(r.id, 36), state: string(r.state, 20), chainIds: (r.chainIds as unknown[]).map(Number) })) };
}
function renderNetworks() {
  if (!networksList || !networksAdd || !networksForm) return;
  const view = session ? networksView : null;
  // The list shows where the account is and where it is arriving; quotes and failures stay out of it.
  const shown = view ? view.networks.filter(item => item.state === "deployed" || item.state === "pending") : [];
  networksList.textContent = view ? shown.map(item => item.state === "deployed" ? item.name : `${item.name} (deploying…)`).join(", ") : "Base";
  networksAdd.hidden = !view || !view.offered.length || networksOpen || busy;
  networksForm.hidden = !view || !networksOpen;
  element<HTMLButtonElement>("wallet-networks-deploy").disabled = busy;
  // Polling runs beside the busy gate so a click is never dropped; it stops after ten minutes or when nothing is pending.
  if (view && view.pending.length && !networksTimer) networksTimer = setInterval(() => {
    if (busy || document.hidden || !navigator.onLine || networksPolls++ > 200) return;
    networksStatus().catch(() => { /* The next poll reads again. */ });
  }, 3000);
  if (view && !view.pending.length && networksTimer) { clearInterval(networksTimer); networksTimer = null; networksPolls = 0; }
}
function chosenFamily(): string {
  return (networksForm?.querySelector<HTMLInputElement>("input[name=family]:checked")?.value) ?? "mainnet";
}
// Relayr never mixes mainnets and testnets in one bundle, so the picker shows one family at a time.
function renderChoices() {
  if (!networksView) return;
  const choices = element("wallet-networks-choices"), family = chosenFamily();
  for (const node of [...choices.querySelectorAll("label")]) node.remove();
  for (const item of networksView.offered.filter(item => item.family === family)) {
    const label = document.createElement("label"), input = document.createElement("input"); label.className = "choice";
    input.type = "checkbox"; input.value = String(item.chainId); input.dataset.family = item.family; input.name = "chain";
    label.append(input, document.createTextNode(item.centerPays ? item.name : `${item.name} (you pay)`)); choices.append(label);
  }
}
function openNetworks() {
  if (!networksView) return;
  renderChoices();
  networksQuote = null; networksOpen = true; render();
}
function chosenChains(): number[] {
  return [...element("wallet-networks-choices").querySelectorAll<HTMLInputElement>("input:checked")].map(input => Number(input.value));
}
// A quiet read: a 503 (authority still refreshing, or no networks service) retries a few times without touching the status line.
async function refreshNetworks(attempt = 0) {
  if (!session || !networksList) return;
  try { networksView = networkView(await request(`${base}/networks`)); render(); }
  catch (error) {
    if (error instanceof HttpFailure && error.status === 503 && attempt < 5) setTimeout(() => { refreshNetworks(attempt + 1).catch(() => { /* The list stays as it is. */ }); }, 3000);
    else throw error;
  }
}
// Center pays for every offered network, so the quote stays inside one click: quote, one passkey prompt, funding.
async function networksDeploy() {
  const chainIds = chosenChains();
  if (!chainIds.length) { setStatus("ready", "Choose at least one network."); return; }
  const families = new Set([...element("wallet-networks-choices").querySelectorAll<HTMLInputElement>("input:checked")].map(input => input.dataset.family));
  if (families.size > 1) { setStatus("ready", "Choose mainnets or testnets, not both at once."); return; }
  setStatus("checking", "Preparing the deployments…");
  const quoted = record(await request(`${base}/networks/quote`, { chainIds }, csrf, 60_000));
  networksView = networkView(quoted.view as Json);
  if (quoted.bundle === null) { networksOpen = false; networksQuote = null; setStatus("ready", "Your account is already on those networks."); return; }
  const bundle = record(quoted.bundle);
  networksQuote = { bundleId: string(bundle.id, 36), challenge: string(quoted.challenge, 66) };
  if (!configuration) throw new InvalidResponse();
  const challenge = networksQuote.challenge; if (!/^0x[0-9a-fA-F]{64}$/.test(challenge)) throw new InvalidResponse();
  // Only the account's passkey can approve, so the prompt offers that one instead of every passkey for the site.
  nativePrompt = new AbortController(); setStatus("authenticating", "Approve the new networks with your passkey."); render();
  const credential = await navigator.credentials.get({ publicKey: { rpId: configuration.rpId, challenge: Uint8Array.from(challenge.slice(2).match(/../g)!.map(pair => parseInt(pair, 16))),
    userVerification: "required", timeout: 90_000 }, signal: nativePrompt.signal });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new InvalidResponse();
  const response = credential.response; nativePrompt = null;
  setStatus("checking", "Funding the deployments…");
  const result = record(await request(`${base}/networks/approve`, { bundleId: networksQuote.bundleId, assertion: { credentialId: encode(credential.rawId),
    userHandle: response.userHandle ? encode(response.userHandle) : null, authenticatorData: encode(response.authenticatorData),
    clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) } }, csrf, 60_000));
  networksView = networkView(result.view as Json); networksQuote = null; networksOpen = false;
  setStatus("checking", deployingText());
}
function deployingText() {
  const names = networksView?.networks.filter(item => item.state === "pending").map(item => item.name) ?? [];
  return `Deploying on ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "the new networks"}…`;
}
async function networksStatus() {
  if (!session) return;
  networksView = networkView(await request(`${base}/networks/status`, {}, csrf, 60_000));
  render();
  if (networksView.pending.length) setStatus("checking", deployingText());
  else setStatus("ready", `Your account is on ${networksView.networks.filter(item => item.state === "deployed").length} networks.`);
}
if (networksAdd && networksForm) {
  networksAdd.addEventListener("click", () => openNetworks());
  networksForm.addEventListener("submit", event => { event.preventDefault(); void run(networksDeploy); });
  for (const radio of networksForm.querySelectorAll<HTMLInputElement>("input[name=family]")) radio.addEventListener("change", () => { networksQuote = null; renderChoices(); render(); });
  element("wallet-networks-cancel").addEventListener("click", () => { networksOpen = false; networksQuote = null; render(); });
}
// The last hex characters of the new device's signer show on both pages, so a swapped device is visible before approval.
// The mark spins only while the service works (adding, finishing); waiting on a person does not spin.
const deviceWorking = (phase: string) => phase === "adding" || phase === "awaiting_activation";
const deviceTag = (signer: string | null) => typeof signer === "string" && /^0x[0-9a-fA-F]{40}$/.test(signer) ? signer.slice(-6).toUpperCase() : "";
function deviceText(phase: string, signer: string | null = device?.view.deviceSigner ?? null) {
  return phase === "awaiting_registration" || phase === "awaiting_possession" ? "Waiting for the other device to create its passkey…"
    : phase === "awaiting_approval" ? `The other device is ready. Approve it with your passkey if it shows ${deviceTag(signer)}.` : phase === "adding" ? "Adding the device to your account…"
    : phase === "awaiting_activation" ? "Finishing…" : phase === "ready" ? "The device is added. Sign in again on this device to continue."
    : phase === "addition_failed" ? "Adding the device did not complete. Try again." : "The link expired. Start again.";
}
function renderDevice() {
  if (!deviceAdd || !devicePanel) return;
  const open = !!session && !!device;
  deviceAdd.hidden = !session || open || busy;
  devicePanel.hidden = !open;
  if (!open) { element<HTMLButtonElement>("wallet-device-cancel").hidden = true; retry.classList.remove("link"); if (deviceTimer) { clearInterval(deviceTimer); deviceTimer = null; } return; }
  const phase = device!.view.phase;
  // The link instructions belong with the link; once the other device has its passkey, the status
  // line says what is happening and the only text left is the one the approval needs.
  element("wallet-device-code").hidden = phase !== "awaiting_registration" && phase !== "awaiting_possession";
  element("wallet-device-hint").hidden = element("wallet-device-code").hidden;
  const link = element<HTMLAnchorElement>("wallet-device-link"); link.hidden = element("wallet-device-code").hidden;
  deviceApprove.hidden = phase !== "awaiting_approval" || busy; deviceApprove.disabled = busy;
  const deviceCancel = element<HTMLButtonElement>("wallet-device-cancel");
  deviceCancel.hidden = false; deviceCancel.textContent = phase === "ready" || phase === "expired" || phase === "addition_failed" ? "Close" : "Cancel";
  // One dark button on the page: while the approval is the action, Retry is a text button beside Cancel.
  retry.classList.toggle("link", !deviceApprove.hidden);
  if (!deviceTimer && ["awaiting_registration", "awaiting_possession", "adding", "awaiting_activation"].includes(phase)) deviceTimer = setInterval(() => {
    if (busy || document.hidden || !navigator.onLine) return;
    devicePoll().catch(() => { /* The next poll reads again. */ });
  }, 3000);
}
async function deviceBegin() {
  setStatus("checking", "Preparing a link for the other device…");
  const result = record(await request(`${base}/devices/begin`, { passkeyName: null }, csrf, 60_000)), view = record(result.view) as unknown as DeviceView, link = string(result.link, 4096);
  if (!link.startsWith(`${location.origin}${base}/add#`)) throw new InvalidResponse();
  device = { view, link };
  element("wallet-device-code").innerHTML = qrSvg(link, "Link for the other device");
  const anchor = element<HTMLAnchorElement>("wallet-device-link"); anchor.href = link; anchor.textContent = "Open the link on this device instead";
  setStatus(deviceWorking(view.phase) ? "checking" : "ready", deviceText(view.phase));
}
async function devicePoll() {
  if (!session || !device) return;
  const result = record(await request(`${base}/devices/${device.view.id}`)), view = record(result.view) as unknown as DeviceView;
  device = { ...device, view };
  if (view.phase === "awaiting_activation") { await run(deviceActivate); return; }
  render(); setStatus(deviceWorking(view.phase) ? "checking" : "ready", deviceText(view.phase));
}
async function deviceApproveNow() {
  if (!device || !configuration) return;
  setStatus("checking", "Preparing the approval…");
  const prepared = record(await request(`${base}/devices/${device.view.id}/review`, {}, csrf, 60_000));
  const challenge = string(prepared.challenge, 66); if (!/^0x[0-9a-fA-F]{64}$/.test(challenge)) throw new InvalidResponse();
  nativePrompt = new AbortController(); setStatus("authenticating", "Approve the new device with your passkey."); render();
  const credential = await navigator.credentials.get({ publicKey: { rpId: configuration.rpId, challenge: Uint8Array.from(challenge.slice(2).match(/../g)!.map(pair => parseInt(pair, 16))),
    userVerification: "required", timeout: 90_000 }, signal: nativePrompt.signal });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new InvalidResponse();
  const response = credential.response; nativePrompt = null;
  setStatus("checking", "Adding the device to your account…");
  const result = record(await request(`${base}/devices/${device.view.id}/approve`, { review: prepared.review, assertion: { credentialId: encode(credential.rawId),
    userHandle: response.userHandle ? encode(response.userHandle) : null, authenticatorData: encode(response.authenticatorData),
    clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) } }, csrf, 60_000));
  device = { ...device, view: record(result.view) as unknown as DeviceView };
  setStatus(deviceWorking(device.view.phase) ? "checking" : "ready", deviceText(device.view.phase));
}
async function deviceActivate() {
  if (!device) return;
  setStatus("checking", "Finishing…");
  const result = record(await request(`${base}/devices/${device.view.id}/activate`, {}, csrf, 100_000));
  device = { ...device, view: record(result.view) as unknown as DeviceView };
  setStatus("ready", deviceText(device.view.phase));
}
if (deviceAdd && devicePanel) {
  deviceAdd.addEventListener("click", () => void run(deviceBegin));
  deviceApprove.addEventListener("click", () => void run(deviceApproveNow));
  element("wallet-device-cancel").addEventListener("click", () => { device = null; render(); });
}
signIn.addEventListener("click", () => void run(login));
if (framed) window.addEventListener("resize", render);
retry.addEventListener("click", () => { if (retryAction) void run(retryAction); });
cancel.addEventListener("click", () => nativePrompt?.abort());
signOut.addEventListener("click", () => void run(logout));
void run(load);
export {};
