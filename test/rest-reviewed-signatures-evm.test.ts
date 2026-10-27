// SPDX-License-Identifier: MIT
import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, keccak256, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from "viem";
import { prepareSafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS } from "../src/rest/smartAccounts/manifests.js";
import { encodeSafe7579MessageSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import { signatureChain, verifyAccountSignature } from "../src/rest/userOperations/reviewedSignatures.js";
import { signatureRequestOf, signatureSigning, type SignatureRequest } from "../src/rest/userOperations/reviewedSignatureRules.js";
import { verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";
import type { RestRpc } from "../src/rest/core.js";
import { createRegistration, signGet } from "./fixtures/wallet-enrollment-crypto.js";

type Artifact = { address: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex; deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex };
const artifact = (name: string, passkey = false): Artifact => JSON.parse(readFileSync(new URL(
  `../src/rest/smartAccounts/stack/${passkey ? "passkey/" : ""}artifacts/${name}.json`, import.meta.url), "utf8"));
const safe = artifact("SafeL2"), factory = artifact("SafeProxyFactory"), adapter = artifact("Safe7579"), launchpad = artifact("Safe7579Launchpad"),
  utility = artifact("Safe7579DCUtil"), entry = artifact("EntryPoint"), senderCreator = artifact("SenderCreator"), sessions = artifact("SmartSession"),
  fcl = artifact("FCLP256Verifier", true), signerFactory = artifact("SafeWebAuthnSignerFactory", true);
const chainId = 8453, rpId = "wallet.juicebox.center", origin = `https://${rpId}`;
const credential = createRegistration({ challenge: zeroHash, rpId, origin, userHandle: Buffer.from("local-reviewed-signatures").toString("base64url") });

// Genuine P256/FCL, Safe and Safe7579 ERC-1271 verification on a local chain; no Base deployment or provider.
describe.skipIf(!anvilAvailable())("reviewed signatures through the passkey Safe", () => {
  let child: ChildProcess | undefined, endpoint: string, sender: Address, backup: Address, signer: Address, account: Address, requestId = 0;
  async function call<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (!response.ok || body.error) throw new Error(`${method}: ${body.error?.message ?? response.status}`);
    return body.result;
  }
  const rpc: RestRpc = { request: (requested, method, params) => { expect(requested).toBe(chainId); return call(method, params); } };
  async function send(data: Hex, to?: Address, value: Hex = "0x0") {
    const hash = await call<Hex>("eth_sendTransaction", [{ from: sender, ...(to ? { to } : {}), data, value, gas: "0xf42400" }]);
    for (let i = 0; i < 100; i++) {
      const receipt = await call<{ status: Hex; contractAddress: Address | null } | null>("eth_getTransactionReceipt", [hash]);
      if (receipt) { expect(receipt.status).toBe("0x1"); return receipt; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Local fixture transaction did not mine");
  }
  async function read(contract: { address: Address; abi: Abi }, functionName: string, args: readonly unknown[] = []) {
    return decodeFunctionResult({ abi: contract.abi, functionName, data: await call<Hex>("eth_call", [{ to: contract.address,
      data: encodeFunctionData({ abi: contract.abi, functionName, args }) }, "latest"]) });
  }
  /** What the approval produces: one passkey assertion over the SafeMessage digest, packed as Safe's owner signature behind a zero validator. */
  function sign(request: SignatureRequest, challenge = signatureSigning(account, request).digest) {
    const proof = verifyWalletAssertion(signGet({ ...credential, challenge, rpId, origin }), { purpose: "payment", challenge, rpId, origin, requireUserHandle: true,
      credential: { id: credential.credentialId, userHandle: credential.userHandle, publicKey: credential.publicKey, backupEligible: true } });
    return encodeSafe7579MessageSignature([{ kind: "contract", owner: signer, signature: proof.contractSignature }]);
  }
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()));
    endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--hardfork", "cancun", "--timestamp", "1800000000", "--silent"]);
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if (await call("eth_chainId") === "0x2105") { ready = true; break; } } catch { /* bounded startup */ }
      await new Promise(resolve => setTimeout(resolve, 30)); }
    expect(ready).toBe(true);
    [sender, backup] = await call<[Address, Address]>("eth_accounts");
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      expect(keccak256(code)).toBe(a.runtimeCodeHash); await call("anvil_setCode", [a.address, code]);
    }
    const fclAddress = (await send(fcl.bytecode)).contractAddress!, signerFactoryAddress = (await send(signerFactory.bytecode)).contractAddress!;
    const signerArgs = [BigInt(credential.publicKey.x), BigInt(credential.publicKey.y), BigInt(fclAddress)];
    signer = await read({ abi: signerFactory.abi, address: signerFactoryAddress }, "getSigner", signerArgs) as Address;
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args: signerArgs }), signerFactoryAddress);
    const creation = prepareSafe7579Creation({ manifest: { ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!, chainId },
      owners: [signer, backup], threshold: 1, saltNonce: "64018" });
    account = creation.address; await send(creation.transaction.data, creation.transaction.to);
  }, 45_000);
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill("SIGTERM"); await exited;
    }
  });

  it("the returned signature validates through isValidSignature on that chain", async () => {
    const permit = signatureRequestOf({ kind: "typed-data", chainId, typedData: { domain: { name: "Permit2", chainId, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      types: { PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
      primaryType: "PermitSingle", message: { details: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000000", expiration: 1_800_086_400, nonce: 0 },
        spender: backup, sigDeadline: "1800003600" } } });
    const message = signatureRequestOf({ kind: "message", chainId, message: "Sign in to example.com\nNonce: 7" });
    // The Safe reverts on a signature that is not its owners', which the review store reads as not valid.
    const valid = (hash: Hex, signature: Hex) => verifyAccountSignature(rpc, { chainId, account, hash, signature }).catch(() => false);
    for (const request of [permit, message]) {
      const { requestDigest } = signatureSigning(account, request), signature = sign(request);
      expect(await valid(requestDigest, signature)).toBe(true);
      // The same signature is for that request alone, and an assertion over the bare request digest is not the account's.
      expect(await valid(keccak256(toHex("another request")), signature)).toBe(false);
      expect(await valid(requestDigest, sign(request, requestDigest))).toBe(false);
    }
    // The review's chain facts read the same chain: the account is deployed, an empty address is not.
    const chain = signatureChain(rpc);
    expect(await chain.deployed(chainId, account)).toBe(true);
    expect(await chain.deployed(chainId, zeroAddress)).toBe(false);
  });
});
