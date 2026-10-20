import { getAddress, type Address, type Hex } from "viem";
import type { Account, BotGrant, BotScope } from "../auth/store.js";
import {
  SignedRestClient, accountIdFor, newRequestNonce,
  signWalletTypedData,
  type BotConnection, type BotRegistration, type RestSigner, type TypedDocument,
} from "../client/index.js";
import type * as SignedIn from "./accountsSignedIn.js";
import { lazyModule } from "./lazyModule.js";

import * as authApi from "./externalWallet.js";
import type { Provider } from "./externalWallet.js";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const input = (id: string) => element<HTMLInputElement>(id);
const audience = document.body.dataset.audience || window.location.origin;
type AccountConnection = {
  provider: Provider; owner: Address; chainId: number; walletChainId: number;
  accountId: string; client: SignedRestClient; execution(chainId: number): Promise<Provider>;
};
let current: AccountConnection | undefined;
let pending: { privateKey: Hex; proof: BotRegistration; attempted: boolean } | undefined;
let savedConnection: BotConnection | undefined;
let reviewed: BotRegistration | undefined;
let busy = false;
let smartUi: ReturnType<typeof SignedIn.installSmartWalletUI> | undefined;
let authRevision = 0;
let identitySubscription: { provider: Provider; invalidate: () => void; networkChanged: () => void; dispose?: () => void } | undefined;

function status(message: string, error = false) {
  const node = element("status"); node.textContent = message; node.dataset.error = String(error);
  if (error) node.scrollIntoView({ block: "nearest" });
}
/** Smart wallets, sessions and bot keys are their own bundle, loaded with the first signed-in account. */
function signedIn() {
  return lazyModule<typeof SignedIn>("accounts-signed-in").then(module => {
    smartUi ??= module.installSmartWalletUI({ audience, connection: () => current, run, status });
    return module;
  });
}
function revealLinkedSetup() {
  if (["#smart-heading", "#operation-heading", "#session-heading"].includes(window.location.hash))
    element<HTMLDetailsElement>("smart-setup").open = true;
}
window.addEventListener("hashchange", revealLinkedSetup);
revealLinkedSetup();
function active() { if (!current) throw new Error("Sign in first."); return current; }
function accountReady(ready: boolean) {
  element<HTMLFieldSetElement>("bot-fields").disabled = !ready;
  element("bot-fields").hidden = !ready;
  element("bot-management").hidden = !ready;
  button("refresh-bots").disabled = !ready;
  smartUi?.accountReady(ready);
}
function reset() {
  authRevision++;
  if (identitySubscription) {
    const { provider, invalidate, networkChanged, dispose } = identitySubscription;
    identitySubscription = undefined;
    dispose?.();
    for (const event of ["accountsChanged", "disconnect"]) provider.removeListener?.(event, invalidate);
    provider.removeListener?.("chainChanged", networkChanged);
  }
  current = undefined; pending = undefined; savedConnection = undefined; reviewed = undefined; accountReady(false);
  for (const id of ["bot-label", "bot-days", "bot-permissions"]) input(id).disabled = false;
  button("generate-bot").textContent = "Create API connection";
  smartUi?.reset();
  button("connect").hidden = false;
  button("disconnect").hidden = true; button("register-generated").disabled = true; button("register-generated").hidden = true;
  button("register-proof").hidden = true; element("proof-preview").hidden = true;
  element("connection-next").hidden = true;
  element("pending-bot").textContent = ""; element("identity").textContent = "Sign in to create or manage API access."; element("identity").removeAttribute("title");
  element<HTMLTextAreaElement>("registration-json").value = "";
  element("bot-list").replaceChildren(); status("Signed out. Sign in to continue.");
}
async function run(operation: () => Promise<void>) {
  if (busy) return;
  busy = true; document.body.setAttribute("aria-busy", "true");
  try { await operation(); }
  catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || (error.name === "CenterWalletError" && "code" in error && error.code === 4001))) status("Action canceled.");
    else status(error instanceof Error && ["RestClientError", "SignInError", "CenterWalletError", "WalletRecoveryError"].includes(error.name) ? error.message : "The action did not complete. Check your connection and try again.", true);
  }
  finally { busy = false; document.body.removeAttribute("aria-busy"); }
}
async function walletTypedSignature(provider: Provider, owner: Address, chainId: number, typedData: TypedDocument): Promise<Hex> {
  const connection = active();
  if (connection.provider !== provider || connection.owner !== owner || connection.chainId !== chainId) throw new Error("Account identity changed.");
  // API ownership is anchored to the same account ID even while transactions use other networks.
  const authorityProvider = await connection.execution(chainId);
  return signWalletTypedData({ provider: authorityProvider, address: owner, chainId, document: typedData, signatureFormat: "wallet",
    stillCurrent: () => current === connection });
}
async function connectAccount(sourceProvider: Provider, enroll: boolean, revision: number) {
  if (revision !== authRevision) return;
  let networkSession: ReturnType<typeof authApi.walletNetworkSession> | undefined;
  let connection: AccountConnection | undefined, ready = false, setupNetworkRevision = 0;
  const invalidate = () => {
    if (identitySubscription?.invalidate !== invalidate) return;
    authApi.forgetSignIn();
    reset();
  };
  const networkChanged = () => {
    if (identitySubscription?.networkChanged !== networkChanged) return;
    if (!networkSession || !connection) { setupNetworkRevision++; return; }
    // Let the provider's own event listeners observe the change before validating its live state.
    queueMicrotask(() => { void networkSession!.refresh().catch((error: unknown) => {
      if (current === connection && error instanceof Error && "code" in error && error.code === 4900) invalidate();
    }); });
  };
  // Fetched alongside the sign-in requests below; awaited before the account's controls are shown.
  const loading = signedIn(); loading.catch(() => {});
  identitySubscription = { provider: sourceProvider, invalidate, networkChanged };
  for (const event of ["accountsChanged", "disconnect"]) sourceProvider.on?.(event, invalidate);
  sourceProvider.on?.("chainChanged", networkChanged);
  const accounts = await sourceProvider.request({ method: "eth_accounts" });
  const chain = await sourceProvider.request({ method: "eth_chainId" });
  if (revision !== authRevision) return;
  if (setupNetworkRevision !== 0) throw new Error("The wallet network changed during sign-in. Try again.");
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || typeof chain !== "string" || !/^0x[0-9a-fA-F]+$/.test(chain)) throw new Error("Invalid account identity.");
  const owner = getAddress(accounts[0]), walletChainId = Number(chain);
  if (!Number.isSafeInteger(walletChainId) || walletChainId < 1) throw new Error("Invalid account network.");
  const chainId = enroll ? walletChainId : authApi.restoredAuthorityChainId(sourceProvider, owner, walletChainId);
  if (!chainId) throw new Error("Restored account identity changed.");
  const accountId = accountIdFor(owner, chainId);
  networkSession = authApi.walletNetworkSession({ provider: sourceProvider, owner, chainId: walletChainId,
    stillCurrent: () => !!connection && current === connection && revision === authRevision,
    onChain: (activeChainId) => {
      if (!connection || current !== connection || revision !== authRevision) return;
      connection.walletChainId = activeChainId;
      if (ready) authApi.rememberSignIn(sourceProvider, owner, chainId, activeChainId);
    },
  });
  identitySubscription.dispose = () => networkSession?.dispose();
  const provider = networkSession.provider;
  const signer: RestSigner = { address: owner, signTypedData: (data) => walletTypedSignature(provider, owner, chainId, data) };
  connection = { provider, owner, chainId, walletChainId, accountId, client: new SignedRestClient({ audience, accountId, signer }),
    execution: networkSession.execution };
  current = connection;
  if (enroll) {
    status("Finishing sign-in. This creates or loads your API account and sends no transaction.");
    const result = await connection.client.request<{ account: Account }>({ method: "POST", requestTarget: "/api/v1/accounts/enroll", json: {} });
    if (current !== connection) return;
    if (result.account.id !== accountId) throw new Error("Unexpected account identity.");
  }
  if (revision !== authRevision || current !== connection) return;
  await loading;
  if (revision !== authRevision || current !== connection) return;
  // This remembers only a public reconnect hint. The wallet still validates and signs every protected action.
  ready = true;
  authApi.rememberSignIn(sourceProvider, owner, chainId, connection.walletChainId);
  element("identity").textContent = `Signed in as ${owner.slice(0, 6)}…${owner.slice(-4)}`;
  element("identity").title = owner;
  button("disconnect").hidden = false;
  accountReady(true); button("connect").hidden = true;
  const unloaded = document.createElement("li"); unloaded.textContent = "Use Refresh bots to load your connections.";
  element("bot-list").replaceChildren(unloaded);
  status("Signed in. Create or manage API access below.");
}
button("connect").addEventListener("click", () => void run(async () => {
  reset();
  const revision = authRevision;
  button("connect").disabled = true;
  button("connect").textContent = "Signing in…";
  status("Signing in…");
  try {
    const provider = await authApi.signIn();
    await connectAccount(provider, true, revision);
  } catch (error) {
    if (revision === authRevision) { authApi.forgetSignIn(); reset(); }
    throw error;
  } finally {
    button("connect").disabled = false;
    button("connect").textContent = "Sign in";
  }
}));
button("disconnect").addEventListener("click", () => void run(async () => {
  try { await authApi.signOut(); }
  finally { reset(); }
}));
function botSettings() {
  const days = Number(input("bot-days").value);
  const profiles: Record<string, BotScope[]> = { read: ["read"], plan: ["read", "plan"], relay: ["read", "plan", "relay"] };
  const scopes = profiles[element<HTMLSelectElement>("bot-permissions").value];
  if (!Number.isSafeInteger(days) || days < 1 || days > 365 || !scopes) throw new Error("Choose a valid expiration and permission profile.");
  return { scopes, label: input("bot-label").value, expiresAt: Math.floor(Date.now() / 1000) + days * 86400, ownerRequestNonce: newRequestNonce(), accountId: active().accountId };
}
function download(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
button("generate-bot").addEventListener("click", () => void run(async () => {
  const connection = active(), { generatePrivateKey, privateKeyToAccount, createBotRegistration, connectionForBot } = await signedIn();
  if (current !== connection) return;
  if (!pending) {
    const settings = botSettings();
    const privateKey = generatePrivateKey();
    const signer = privateKeyToAccount(privateKey);
    const proof = await createBotRegistration(audience, { ...settings, botAddress: signer.address }, signer);
    if (current !== connection) return;
    pending = { privateKey, proof, attempted: false };
    for (const id of ["bot-label", "bot-days", "bot-permissions"]) input(id).disabled = true;
    element("pending-bot").textContent = `Review API access for ${settings.label}: ${settings.scopes.join(", ")}. Expires ${new Date(settings.expiresAt * 1000).toISOString()}.`;
  }
  const setup = pending;
  let bot: BotGrant | undefined;
  // After an interrupted response, look up this key before registering again.
  // Keep the same local key and reviewed settings until the outcome is known.
  if (setup.attempted) {
    status("Checking whether your connection was registered. Approve the account read in your wallet.");
    const result = await connection.client.request<{ bots: BotGrant[] }>({ requestTarget: "/api/v1/accounts/me/bots" });
    if (current !== connection) return;
    bot = result.bots.find(item => item.botAddress.toLowerCase() === setup.proof.registration.botAddress.toLowerCase() &&
      item.accountId === connection.accountId && !item.revokedAt && item.expiresAt === setup.proof.registration.expiresAt &&
      JSON.stringify(item.scopes) === JSON.stringify(setup.proof.registration.scopes));
    if (!bot) setup.proof = await createBotRegistration(audience, {
      ...setup.proof.registration, accountId: connection.accountId, ownerRequestNonce: newRequestNonce(),
    }, privateKeyToAccount(setup.privateKey));
  }
  setup.attempted = true;
  button("generate-bot").textContent = "Resume connection setup";
  bot ??= await register(setup.proof);
  if (current !== connection) return;
  savedConnection = connectionForBot(audience, bot, setup.privateKey);
  download("juicebox-connection.json", savedConnection);
  pending = undefined;
  for (const id of ["bot-label", "bot-days", "bot-permissions"]) input(id).disabled = false;
  button("generate-bot").textContent = "Create another connection";
  button("register-generated").hidden = false; button("register-generated").disabled = false;
  element("pending-bot").textContent = `Connection ready for ${bot.label}. The file includes your key, account and access settings. No IDs to copy.`;
  status("Connection downloaded. Install the client, keep the file private, and run your first request below.");
  element("connection-next").hidden = false;
}));
async function register(document: BotRegistration) {
  const connection = active();
  if (document.audience !== audience || document.accountId !== connection.accountId) throw new Error("Registration belongs to another account or service.");
  await (await signedIn()).verifyBotProof(audience, { accountId: document.accountId, ownerRequestNonce: document.ownerRequestNonce, ...document.registration }, document.registration.proofSignature);
  status("Review the bot details and approve registration in your wallet.");
  const { bot } = await connection.client.request<{ bot: BotGrant }>({
    method: "POST", requestTarget: "/api/v1/accounts/me/bots", json: document.registration, nonce: document.ownerRequestNonce,
  });
  if (current !== connection || bot.accountId !== connection.accountId ||
      bot.botAddress.toLowerCase() !== document.registration.botAddress.toLowerCase() ||
      bot.expiresAt !== document.registration.expiresAt || JSON.stringify(bot.scopes) !== JSON.stringify(document.registration.scopes))
    throw new Error("Registration response does not match the reviewed connection.");
  renderBots([bot]); status("API access registered.");
  return bot;
}
button("register-generated").addEventListener("click", () => {
  if (savedConnection) download("juicebox-connection.json", savedConnection);
});
button("proof-request").addEventListener("click", () => void run(async () => {
  const settings = botSettings();
  download("juicebox-bot-proof-request.json", { format: "juicebox-center-bot-proof-request-v1", audience, ...settings });
  status("Public proof request downloaded. Run center proof with your private key file, then paste only the registration JSON.");
}));
button("review-proof").addEventListener("click", () => void run(async () => {
  reviewed = undefined; button("register-proof").hidden = true;
  const raw = element<HTMLTextAreaElement>("registration-json").value;
  if (raw.length > 16 * 1024) throw new Error("Registration document is too large.");
  const parsed = (await signedIn()).parseBotRegistration(JSON.parse(raw));
  if (parsed.accountId !== active().accountId || parsed.audience !== audience) throw new Error("Registration account or service does not match.");
  await (await signedIn()).verifyBotProof(audience, { accountId: parsed.accountId, ownerRequestNonce: parsed.ownerRequestNonce, ...parsed.registration }, parsed.registration.proofSignature);
  const { botAddress, scopes, expiresAt, label } = parsed.registration;
  if (expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Bot proof is expired.");
  element("proof-preview").textContent = JSON.stringify({ accountId: parsed.accountId, botAddress, scopes, label, expires: new Date(expiresAt * 1000).toISOString() }, null, 2);
  element("proof-preview").hidden = false; button("register-proof").hidden = false; reviewed = parsed;
  status("Proof verified. Review the address, permissions, label, and expiration before registering.");
}));
element("registration-json").addEventListener("input", () => { reviewed = undefined; button("register-proof").hidden = true; element("proof-preview").hidden = true; });
button("register-proof").addEventListener("click", () => void run(async () => {
  if (!reviewed) return; const proof = reviewed; reviewed = undefined; button("register-proof").hidden = true;
  await register(proof); element<HTMLTextAreaElement>("registration-json").value = "";
}));
function renderBots(bots: BotGrant[]) {
  const list = element("bot-list"); list.replaceChildren();
  if (!bots.length) { const empty = document.createElement("li"); empty.textContent = "No bots registered."; list.append(empty); }
  for (const bot of bots) {
    if (bot.accountId !== active().accountId) throw new Error("Unexpected bot account.");
    const row = document.createElement("li");
    for (const value of [bot.label || "Unnamed bot", `Address: ${bot.botAddress}`, `Grant ID: ${bot.id}`, `Permissions: ${bot.scopes.join(", ")}`, `Expires: ${new Date(bot.expiresAt * 1000).toISOString()}${bot.revokedAt ? " / REVOKED" : ""}`]) {
      const line = document.createElement("p"); line.textContent = value; row.append(line);
    }
    if (!bot.revokedAt && bot.expiresAt > Math.floor(Date.now() / 1000)) {
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.textContent = "Revoke bot";
      revoke.addEventListener("click", () => void run(async () => {
        await active().client.request({ method: "DELETE", requestTarget: `/api/v1/accounts/me/bots/${encodeURIComponent(bot.id)}` });
        revoke.disabled = true; revoke.textContent = "Revoked"; status(`Bot grant ${bot.id} revoked.`);
      })); row.append(revoke);
    }
    list.append(row);
  }
}
button("refresh-bots").addEventListener("click", () => void run(async () => {
  const { bots } = await active().client.request<{ bots: BotGrant[] }>({ requestTarget: "/api/v1/accounts/me/bots" }); renderBots(bots); status("Bot list refreshed.");
}));
void (async () => {
  const revision = authRevision;
  status("Checking your sign-in…");
  element("identity").textContent = "Checking your sign-in…";
  try {
    const provider = await authApi.restoreSignIn();
    if (revision !== authRevision) return;
    if (provider) await connectAccount(provider, false, revision);
    else {
      element("identity").textContent = "Sign in to create or manage API access.";
      status("Sign in to get started.");
    }
  } catch {
    if (revision !== authRevision) return;
    reset();
    status("Your sign-in could not be restored. Sign in to reconnect.");
  }
})();
