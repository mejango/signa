import { spawnSync, type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, copyFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, keccak256, parseTransaction, serializeTransaction, size, toHex,
  type Abi, type Address, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { preparePasskeySafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { baseFastLzLength, calculateBaseSignedFees, type BaseFeeParameters } from "../src/rest/wallet/deploymentFees.js";
import { enrollmentBackupAccount, enrollmentManifest } from "./fixtures/wallet-enrollment-crypto.js";

const referenceRoot = new URL("../src/rest/wallet/stack/baseFees/", import.meta.url);
const forge = process.env.FORGE_BINARY ?? "forge";
const available = anvilAvailable() && spawnSync(forge, ["--version"]).status === 0;
const referenceAddress = "0x000000000000000000000000000000000000bEEF" as Address;
const relay = privateKeyToAccount(`0x${"22".repeat(32)}`); // Public fixture authority only.
type SolidityQuote = {
  fastLzLength: bigint; estimatedSizeScaled: bigint; l1FeeAtParameters: bigint;
  operatorMaximumAtParameters: bigint; executionMaximum: bigint; totalMaximumAtParameters: bigint;
};
type PublishedVector = {
  name: string; rawTransaction: Hex; l1BaseFee: string; l1BlobBaseFee: string;
  l1BaseFeeScalar: string; l1BlobBaseFeeScalar: string; expectedFastLzLength?: number | string; expectedL1Fee: string;
};
const vectors = JSON.parse(readFileSync(new URL("base-vectors.json", referenceRoot), "utf8")) as PublishedVector[];
const parameters = (profile: BaseFeeParameters["profile"]): BaseFeeParameters => ({
  profile, l1BaseFee: 17_123_456_789n, l1BlobBaseFee: 123_456_789n, l1BaseFeeScalar: 5227n,
  l1BlobBaseFeeScalar: 1_014_213n, operatorFeeScalar: 1701n, operatorFeeConstant: 123_456_789n,
});

/** Deterministic high-entropy bytes, not key material. Different blocks exercise hash collisions and long distances. */
function entropy(length: number): Uint8Array {
  const output = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 32)
    createHash("sha256").update(`base-fee-reference:${offset}`).digest().copy(output, offset);
  return Uint8Array.from(output);
}
function deploymentTransaction(data?: Hex): TransactionSerializableEIP1559 {
  const creation = preparePasskeySafe7579Creation({ manifest: enrollmentManifest,
    publicKey: {
      x: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
      y: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
    }, recoveryOwner: enrollmentBackupAccount.address, saltNonce: "42" });
  return { type: "eip1559", chainId: 8453, nonce: 1, to: creation.transaction.to,
    data: data ?? creation.transaction.data, gas: 2_000_000n, maxFeePerGas: 15_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n, value: 0n, accessList: [] };
}

// Anvil executes the separately compiled Solidity/Solady reference. This establishes arithmetic
// and compression parity, not OP execution-client fee deductions, current Base parameters or runtime provenance.
describe.skipIf(!available)("full signed Base fee differential against pinned Solady on Anvil", () => {
  let child: ChildProcess | undefined, scratch: string | undefined, endpoint: string, abi: Abi, requestId = 0;
  const lifetime = new AbortController();
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = [], timeoutMs = 20_000): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]) });
    if (!response.ok) throw new Error(`Local reference HTTP ${response.status}`);
    const result = await response.json() as { result: T; error?: { message: string } };
    if (result.error) throw new Error(`${method}: ${result.error.message}`);
    return result.result;
  }
  async function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return decodeFunctionResult({ abi, functionName, data: await rpc<Hex>("eth_call", [{ to: referenceAddress,
      data: encodeFunctionData({ abi, functionName, args }), gas: toHex(250_000_000) }, "latest"]) }) as T;
  }
  async function compare(rawTransaction: Hex, p: BaseFeeParameters) {
    const decoded = parseTransaction(rawTransaction);
    expect(decoded.type).toBe("eip1559");
    const observed = await read<SolidityQuote>("quote", [rawTransaction, decoded.gas!, decoded.maxFeePerGas!, decoded.value ?? 0n,
      { jovian: p.profile === "fjord-jovian", l1BaseFee: p.l1BaseFee, l1BlobBaseFee: p.l1BlobBaseFee,
        l1BaseFeeScalar: p.l1BaseFeeScalar, l1BlobBaseFeeScalar: p.l1BlobBaseFeeScalar,
        operatorFeeScalar: p.operatorFeeScalar, operatorFeeConstant: p.operatorFeeConstant }]);
    const calculated = calculateBaseSignedFees({ rawTransaction, parameters: p });
    expect(calculated).toEqual({ ...observed, fastLzLength: Number(observed.fastLzLength),
      transactionHash: keccak256(rawTransaction), rawByteLength: size(rawTransaction), value: decoded.value ?? 0n, futureFeeCeiling: null });
    return { observed, calculated };
  }

  beforeAll(async () => {
    const provenance = JSON.parse(await readFile(new URL("provenance-solady.json", referenceRoot), "utf8")) as {
      files: { local: string; sha256: string }[];
    };
    for (const file of provenance.files) {
      const source = await readFile(new URL(file.local, referenceRoot));
      expect(createHash("sha256").update(source).digest("hex"), file.local).toBe(file.sha256);
    }
    const baseProvenance = JSON.parse(await readFile(new URL("provenance-base.json", referenceRoot), "utf8")) as {
      sources: { file: string; sha256: string }[]; vectors: { file: string; sha256: string };
    };
    for (const file of [...baseProvenance.sources, baseProvenance.vectors]) {
      const source = await readFile(new URL(file.file, referenceRoot));
      expect(createHash("sha256").update(source).digest("hex"), file.file).toBe(file.sha256);
    }
    scratch = await mkdtemp(join(tmpdir(), "center-base-fee-reference-"));
    await mkdir(join(scratch, "src"));
    for (const name of ["BaseSignedFeeReference.sol", "LibZip.sol"])
      await copyFile(fileURLToPath(new URL(name, referenceRoot)), join(scratch, "src", name));
    const compiled = spawnSync(forge, ["build", "--root", scratch, "--contracts", "src", "--out", "out", "--cache-path", "cache",
      "--use", "0.8.26", "--offline", "--evm-version", "cancun", "--optimize", "--optimizer-runs", "200", "--no-metadata"],
    { encoding: "utf8", timeout: 30_000 });
    expect(compiled.status, compiled.error?.message ?? `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
    const artifact = JSON.parse(await readFile(join(scratch, "out", "BaseSignedFeeReference.sol", "BaseSignedFeeReference.json"), "utf8")) as {
      abi: Abi; deployedBytecode: { object: Hex };
    };
    abi = artifact.abi;
    expect(artifact.deployedBytecode.object.length).toBeGreaterThan(2);
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "cancun",
      "--gas-limit", "300000000", "--silent"]);
    const startupDeadline = Date.now() + 5_000;
    for (;;) {
      lifetime.signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Local reference Anvil exited during startup");
      try { expect(await rpc("eth_chainId", [], 250)).toBe("0x2105"); break; }
      catch (error) {
        lifetime.signal.throwIfAborted();
        if (Date.now() >= startupDeadline) throw new Error("Local reference Anvil did not start within five seconds", { cause: error });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    await rpc("anvil_setCode", [referenceAddress, artifact.deployedBytecode.object]);
    expect(await rpc("eth_getCode", [referenceAddress, "latest"])).toBe(artifact.deployedBytecode.object);
  }, 45_000);
  afterAll(async () => {
    lifetime.abort();
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
        child.kill("SIGTERM");
        const force = setTimeout(() => child!.kill("SIGKILL"), 1_000);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([exited, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Local reference Anvil did not exit after SIGKILL")), 3_000);
          })]);
        } finally { clearTimeout(force); clearTimeout(deadline); }
      }
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  });

  it.each([0, 1, 12, 13, 14, 15, 16, 31, 32, 33, 263, 264, 8191, 8192, 8193, 32768, 131072])(
    "matches independent compression for repeated and high-entropy inputs of %i bytes", async length => {
      for (const input of [new Uint8Array(length).fill(0xa5), entropy(length)]) {
        const observed = await read<bigint>("compressedLength", [toHex(input)]);
        expect(baseFastLzLength(input)).toBe(Number(observed));
      }
    }, 30_000,
  );

  it.each(vectors)("reproduces upstream published full-signed fee vector: $name", async vector => {
    const p: BaseFeeParameters = { profile: "fjord-isthmus", l1BaseFee: BigInt(vector.l1BaseFee),
      l1BlobBaseFee: BigInt(vector.l1BlobBaseFee), l1BaseFeeScalar: BigInt(vector.l1BaseFeeScalar),
      l1BlobBaseFeeScalar: BigInt(vector.l1BlobBaseFeeScalar), operatorFeeScalar: 0n, operatorFeeConstant: 0n };
    const { observed, calculated } = await compare(vector.rawTransaction, p);
    expect(observed.l1FeeAtParameters).toBe(BigInt(vector.expectedL1Fee));
    expect(calculated.l1FeeAtParameters).toBe(BigInt(vector.expectedL1Fee));
    if (vector.expectedFastLzLength !== undefined)
      expect(observed.fastLzLength).toBe(BigInt(vector.expectedFastLzLength));
  });

  it("matches the independent compressor around its maximum back-reference distance", async () => {
    for (const distance of [8190, 8191, 8192, 8193]) {
      const input = Uint8Array.from(Buffer.concat([entropy(distance), entropy(512)]));
      expect(baseFastLzLength(input)).toBe(Number(await read<bigint>("compressedLength", [toHex(input)])));
    }
  });

  it.each(["fjord-isthmus", "fjord-jovian"] as const)("matches exact signed deployment and payloads under %s", async profile => {
    for (const data of [undefined, "0x" as Hex, toHex(entropy(4096)), toHex(new Uint8Array(16384).fill(0xa5))]) {
      const raw = await relay.signTransaction(deploymentTransaction(data));
      await compare(raw, parameters(profile));
    }
  });

  it("prices actual alternative signatures over the same transaction, without +68 unsigned padding", async () => {
    const unsigned = deploymentTransaction(), first = await relay.signTransaction(unsigned);
    const signature = secp256k1.sign(keccak256(serializeTransaction(unsigned)).slice(2), "22".repeat(32),
      { lowS: true, extraEntropy: new Uint8Array(32).fill(7) });
    const second = serializeTransaction(unsigned, { r: toHex(signature.r, { size: 32 }),
      s: toHex(signature.s, { size: 32 }), yParity: signature.recovery });
    expect(first).not.toBe(second);
    for (const raw of [first, second]) {
      const { observed } = await compare(raw, parameters("fjord-jovian"));
      expect(observed.fastLzLength).toBe(await read<bigint>("compressedLength", [raw]));
    }
  });

  it("keeps observed zero parameters explicit and distinguishes operator formulas at their integer boundary", async () => {
    const rawTransaction = await relay.signTransaction({ ...deploymentTransaction(), gas: 999_999n, value: 17n });
    const zero = { ...parameters("fjord-jovian"), l1BaseFee: 0n, l1BlobBaseFee: 0n,
      l1BaseFeeScalar: 0n, l1BlobBaseFeeScalar: 0n, operatorFeeScalar: 0n, operatorFeeConstant: 0n };
    expect((await compare(rawTransaction, zero)).calculated.l1FeeAtParameters).toBe(0n);
    const isthmus = await compare(rawTransaction, { ...zero, profile: "fjord-isthmus", operatorFeeScalar: 1n, operatorFeeConstant: 7n });
    const jovian = await compare(rawTransaction, { ...zero, operatorFeeScalar: 1n, operatorFeeConstant: 7n });
    expect(isthmus.calculated.operatorMaximumAtParameters).toBe(7n);
    expect(jovian.calculated.operatorMaximumAtParameters).toBe(99_999_907n);
    expect(jovian.calculated.futureFeeCeiling).toBeNull();
  });
});
