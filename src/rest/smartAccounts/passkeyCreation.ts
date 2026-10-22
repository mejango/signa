import {
  concatHex, encodeAbiParameters, getContractAddress, isAddress, zeroHash,
  type Address, type Hex,
} from "viem";
import { RestError } from "../core.js";
import type { SmartAccountManifest } from "./types.js";
import { SAFE_141_MULTI_SEND } from "./safeCode.js";

/** Exact safe-modules dfd3b05966e727dbb7a2fdeef52e4b230f63304e creation code.
 * A checked-in constant keeps deterministic prediction available in browsers without RPC or Node. */
export const SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE =
  "0x610100346100ad57601f6101b538819003918201601f19168301916001600160401b038311848410176100b2578084926080946040528339810103126100ad578051906001600160a01b03821682036100ad5760208101516040820151606090920151926001600160b01b03841684036100ad5760805260a05260c05260e05260405160ec90816100c98239608051816082015260a05181604d015260c051816027015260e0518160010152f35b600080fd5b634e487b7160e01b600052604160045260246000fdfe7f000000000000000000000000000000000000000000000000000000000000000060b63601527f000000000000000000000000000000000000000000000000000000000000000060a03601527f000000000000000000000000000000000000000000000000000000000000000036608001523660006080376000806056360160807f00000000000000000000000000000000000000000000000000000000000000005af43d600060803e60b1573d6080fd5b3d6080f3fea264697066735822122065c838c624ba438597bccb5b928a77c7d69c2eb18ae974c7fc6ee5597e1f2c6b64736f6c634300081a0033" as Hex;
const PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const same = (a: string | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
function invalid(): never {
  throw new RestError(422, "SMART_CREATION_UNSUPPORTED", "Use the reviewed atomic passkey signer and Safe7579 bootstrap profile.");
}

/** Synchronous configuration validation, including on warm inspector checkpoints.
 * Canonical inspection separately verifies every owner's exact runtime and factory lineage on chain. */
export function validatePasskeyCreationManifest(manifest: SmartAccountManifest): void {
  const p = manifest.creationProfile, owner = manifest.ownerProfile, pin = p?.multiSend;
  if (!p || p.version !== "center-passkey-bootstrap-v1" || manifest.chainId !== 8453 ||
    !owner || owner.version !== "center-passkey-v1" || manifest.safeVersion !== "1.4.1" ||
    manifest.smartSessions.generation !== "legacy-validator" ||
    manifest.safe7579.source.commit !== "f22a194148ff087f0c16125e530512e59794e188" ||
    !pin || !isAddress(pin.address) || !same(pin.address, SAFE_141_MULTI_SEND) ||
    !same(pin.runtimeCodeHash, "0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77") ||
    pin.source?.repository !== "https://github.com/safe-global/safe-contracts" ||
    pin.source.commit !== "bf943f80fec5ac647159d26161446ac5d716a294" ||
    pin.source.artifactSha256 !== "cdfa2bbcba64c698db975a0c332457f3ec1a0653f147ff6b5d2ee8771084961b" ||
    [owner.signerFactory, owner.signerSingleton, owner.p256Verifier].some((dependency) =>
      !dependency || !isAddress(dependency.address) || BigInt(dependency.address) <= 1n)) invalid();
}

export function predictPasskeySignerAddress(input: {
  manifest: SmartAccountManifest; publicKey: { x: Hex; y: Hex };
}): Address {
  validatePasskeyCreationManifest(input.manifest);
  if (!input.publicKey || !/^0x[0-9a-fA-F]{64}$/.test(input.publicKey.x) ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.publicKey.y)) invalid();
  const x = BigInt(input.publicKey.x), y = BigInt(input.publicKey.y), p = input.manifest.ownerProfile!;
  if (x >= PRIME || y >= PRIME || (y * y - x * x * x + 3n * x - B) % PRIME !== 0n) invalid();
  return getContractAddress({ from: p.signerFactory.address, opcode: "CREATE2", salt: zeroHash,
    bytecode: concatHex([SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE, encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }],
      [p.signerSingleton.address, x, y, BigInt(p.p256Verifier.address)])]) });
}
