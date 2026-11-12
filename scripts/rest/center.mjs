#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HELP = `Signa signed REST client (Node 22+)

  center account --connection juicebox-connection.json
  center send --connection juicebox-connection.json --target /api/v1/...

  center keygen --out bot-key.json
  center proof --key bot-key.json --request public-proof-request.json --out registration.json
  center sign --key bot-key.json --audience https://api.signa.center --account eip155:1:0x... --grant UUID --target /api/v1/... --out signed-request.json
  center send --key bot-key.json --audience https://api.signa.center --account eip155:1:0x... --grant UUID --target /api/v1/...

sign/send options: --method GET|POST|PATCH|DELETE --body body.json
  --content-type application/json --idempotency KEY --retries 0|1|2 --timeout-ms 15000
The target is the exact encoded path and query. Quote it in your shell.
Bot scopes must be exactly [read], [read,plan], or [read,plan,relay], in that order.
Owner requests omit --grant. Proof request files come from /accounts.
Key files are local secrets. No command accepts a private key on its command line.
Bot authentication does not sign transactions or authorize spending owner funds.
Run npm run build in extensions/jbcenter before proof/sign/send.
`;

function fail(message) { throw new Error(message); }
function argsFor(argv) {
  const command = argv[0];
  const args = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || Object.hasOwn(args, key.slice(2))) fail("Expected unique --option value pairs");
    args[key.slice(2)] = value;
  }
  return { command, args };
}
function allow(args, names) {
  if (Object.keys(args).some((key) => !names.includes(key))) fail("Unknown option; run with --help");
}
function required(args, key) { const value = args[key]; if (!value) fail(`Missing --${key}`); return value; }
async function readBounded(handle, maximum) {
  const buffer = Buffer.alloc(maximum + 1); let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (length > maximum) { buffer.fill(0); fail("Input file exceeds its size limit"); }
  return buffer.subarray(0, length);
}
export async function writeExclusive(filename, value) {
  // O_EXCL refuses existing paths, including symlinks; never overwrite a key or signed request.
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let completed = false;
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8"); await handle.sync(); completed = true; }
  finally { await handle.close(); if (!completed) await unlink(filename).catch(() => undefined); }
}
export async function readProtectedDocument(filename) {
  if (constants.O_NOFOLLOW === undefined) fail("This platform cannot safely open a private key file");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 && (stat.mode & 0o777) !== 0o400
      || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("Key file must be an owned regular file with mode 0600 or 0400 and one hard link");
    const buffer = await readBounded(handle, 4096);
    let document;
    try { document = JSON.parse(buffer.toString("utf8")); }
    finally { buffer.fill(0); }
    return document;
  } finally { await handle.close(); }
}
export async function readProtectedKey(filename) {
    const document = await readProtectedDocument(filename);
    if (!document || typeof document !== "object" || Array.isArray(document)
      || Object.keys(document).some((key) => !["format", "botAddress", "privateKey"].includes(key))
      || document.format !== "juicebox-center-bot-key-v1" || !/^0x[0-9a-fA-F]{64}$/.test(document.privateKey)
      || !/^0x[0-9a-fA-F]{40}$/.test(document.botAddress)) fail("Invalid bot key file");
    const signer = privateKeyToAccount(document.privateKey);
    if (signer.address.toLowerCase() !== document.botAddress.toLowerCase()) fail("Key file address does not match its private key");
    return signer;
 }
async function boundedFile(filename, maximum) {
  const handle = await open(filename, "r");
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > maximum) fail("Input file exceeds its size limit or is not a regular file");
    return await readBounded(handle, maximum);
  } finally { await handle.close(); }
}
async function runtime() {
  try { return await import(new URL("../../dist/src/rest/client/index.js", import.meta.url).href); }
  catch { fail("Build the client first: run npm run build in extensions/jbcenter"); }
}
export async function main(argv, output = (value) => process.stdout.write(value + "\n")) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "help") { output(HELP); return; }
  let { command, args } = argsFor(argv);
  if (command === "account") {
    allow(args, ["connection"]);
    required(args, "connection");
    command = "send"; args.target = "/api/v1/accounts/me";
  }
  if (command === "keygen") {
    allow(args, ["out"]);
    const filename = required(args, "out"); const privateKey = generatePrivateKey(); const signer = privateKeyToAccount(privateKey);
    await writeExclusive(filename, { format: "juicebox-center-bot-key-v1", botAddress: signer.address, privateKey });
    output(JSON.stringify({ botAddress: signer.address, keyFileCreated: true })); return;
  }
  if (command === "proof") {
    allow(args, ["key", "request", "out"]);
    const { createBotRegistration, isCanonicalGrantScopes } = await runtime();
    const signer = await readProtectedKey(required(args, "key"));
    const request = JSON.parse((await boundedFile(required(args, "request"), 16384)).toString("utf8"));
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).some((key) => !["format", "audience", "accountId", "ownerRequestNonce", "scopes", "expiresAt", "label"].includes(key))
      || request.format !== "juicebox-center-bot-proof-request-v1" || typeof request.audience !== "string" || typeof request.accountId !== "string"
      || typeof request.ownerRequestNonce !== "string" || !/^0x[0-9a-f]{64}$/.test(request.ownerRequestNonce)
      || !isCanonicalGrantScopes(request.scopes)
      || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Math.floor(Date.now() / 1000) || request.expiresAt > Math.floor(Date.now() / 1000) + 365 * 86400
      || typeof request.label !== "string" || Buffer.byteLength(request.label) > 120) fail("Invalid public bot proof request");
    const registration = await createBotRegistration(request.audience, {
      accountId: request.accountId, botAddress: signer.address, ownerRequestNonce: request.ownerRequestNonce,
      scopes: request.scopes, expiresAt: request.expiresAt, label: request.label,
    }, signer);
    await writeExclusive(required(args, "out"), registration);
    output(JSON.stringify({ registrationFileCreated: true, botAddress: signer.address, scopes: request.scopes, expiresAt: request.expiresAt })); return;
  }
  if (command !== "sign" && command !== "send") fail("Unknown command; run with --help");
  allow(args, ["connection", "key", "audience", "account", "grant", "method", "target", "body", "content-type", "idempotency", "out", "retries", "timeout-ms"]);
  if (command === "sign" && args.retries !== undefined) fail("A signed request is a single attempt; --retries applies only to send");
  if (command === "send" && args.out !== undefined) fail("--out applies to sign; send writes its JSON response to stdout");
  const { prepareSignedRequest, SignedRestClient, parseConnection } = await runtime();
  let config;
  if (args.connection) {
    if (["key", "audience", "account", "grant"].some(name => args[name])) fail("Use a connection file or explicit key settings, not both");
    const saved = parseConnection(await readProtectedDocument(args.connection));
    if (saved.expiresAt <= Math.floor(Date.now() / 1000)) fail("Bot connection has expired");
    config = { audience: saved.audience, accountId: saved.accountId, grantId: saved.grantId, signer: privateKeyToAccount(saved.privateKey) };
  } else {
    const signer = await readProtectedKey(required(args, "key"));
    config = { audience: required(args, "audience"), accountId: required(args, "account"), signer,
      ...(args.grant ? { grantId: args.grant } : {}) };
  }
  if (args["timeout-ms"]) config.timeoutMs = Number(args["timeout-ms"]);
  const request = {
    requestTarget: required(args, "target"), method: args.method ?? "GET",
    ...(args.body ? { body: new Uint8Array(await boundedFile(args.body, 2 * 1024 * 1024)), contentType: args["content-type"] ?? "application/json" } : args["content-type"] ? { contentType: args["content-type"] } : {}),
    ...(args.idempotency ? { idempotencyKey: args.idempotency } : {}),
    ...(args.retries ? { retries: Number(args.retries) } : {}),
  };
  if (command === "sign") {
    const signed = await prepareSignedRequest(config, request);
    await writeExclusive(required(args, "out"), {
      format: "juicebox-center-signed-request-v1", url: signed.url, method: signed.method,
      headers: Object.fromEntries(signed.headers), bodyBase64: Buffer.from(signed.body).toString("base64"),
    });
    output(JSON.stringify({ signedRequestFileCreated: true, expiresAt: signed.claims.expiresAt }));
  } else {
    const result = await new SignedRestClient(config).request(request);
    output(JSON.stringify(result));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    // Library, filesystem, and wallet errors may contain input material. Keep stderr credential-free.
    const known = error?.name === "RestClientError" && /^[A-Z_]{1,80}$/.test(error.code)
      ? `${error.code}: ${error.message}`
      : error?.code === "ENOENT" ? "Connection or input file not found. Check its path."
      : "Command failed. Check the options, file permissions, and request identity. Run with --help for usage.";
    process.stderr.write(known + "\n");
    process.exitCode = 1;
  });
}
