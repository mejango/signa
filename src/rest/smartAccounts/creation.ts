import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  isAddress,
  keccak256,
  sliceHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { RestError } from "../core.js";
import type { SmartAccountManifest } from "./types.js";
import { predictPasskeySignerAddress } from "./passkeyCreation.js";
import { SAFE_141_PROXY_CREATION_CODE } from "./safeCode.js";
export { validatePasskeyCreationManifest } from "./passkeyCreation.js";

export { SAFE_141_PROXY_CREATION_CODE } from "./safeCode.js";
export const SAFE_CREATION_ABI = [{"name":"createProxyWithNonce","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address","name":"singleton"},{"type":"bytes","name":"initializer"},{"type":"uint256","name":"saltNonce"}],"outputs":[{"type":"address","name":"proxy"}]},{"name":"ProxyCreation","type":"event","inputs":[{"type":"address","name":"proxy","indexed":true},{"type":"address","name":"singleton"}]}] as const;
export const SAFE_SETUP_ABI = [{"name":"setup","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address[]","name":"owners"},{"type":"uint256","name":"threshold"},{"type":"address","name":"to"},{"type":"bytes","name":"data"},{"type":"address","name":"fallbackHandler"},{"type":"address","name":"paymentToken"},{"type":"uint256","name":"payment"},{"type":"address","name":"paymentReceiver"}],"outputs":[]}] as const;
export const SAFE7579_LAUNCH_SETUP_ABI = [{"name":"addSafe7579","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address","name":"safe7579"},{"type":"tuple[]","name":"modules","components":[{"type":"address","name":"module"},{"type":"bytes","name":"initData"},{"type":"uint256","name":"moduleType"}]},{"type":"address[]","name":"attesters"},{"type":"uint8","name":"threshold"}],"outputs":[]}] as const;
const MULTI_SEND_ABI = [{"name":"multiSend","type":"function","stateMutability":"nonpayable","inputs":[{"type":"bytes","name":"transactions"}],"outputs":[]}] as const;
const SIGNER_FACTORY_ABI = [{"name":"createSigner","type":"function","stateMutability":"nonpayable","inputs":[{"type":"uint256","name":"x"},{"type":"uint256","name":"y"},{"type":"uint176","name":"verifiers"}],"outputs":[{"type":"address"}]}] as const;
export interface PasskeyCreationBootstrap {
  version: "center-passkey-bootstrap-v1";
  signerAddress: Address;
  publicKey: { x: Hex; y: Hex };
  verifiers: Hex;
  multiSendData: Hex;
  launchpadData: Hex;
  signerFactoryData: Hex;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(): never {
  throw new RestError(
    422,
    "SMART_CREATION_UNSUPPORTED",
    "Use the reviewed atomic Safe 1.4.1 setup with an empty SmartSession validator and no payment.",
  );
}

type CreationInput = {
  manifest: SmartAccountManifest;
  owners: readonly Address[];
  threshold: number;
  saltNonce: string;
};
function validateCreationInput(input: CreationInput) {
  const { manifest: m } = input;
  if (
    m.safeVersion !== "1.4.1" ||
    m.smartSessions.generation !== "legacy-validator" ||
    m.safe7579.source.commit !== "f22a194148ff087f0c16125e530512e59794e188" ||
    !Array.isArray(input.owners) ||
    input.owners.length < 1 ||
    input.owners.length > 16 ||
    Array.from({ length: input.owners.length }, (_, i) => i).some(
      (i) =>
        !Object.hasOwn(input.owners, i) ||
        !isAddress(input.owners[i]!) ||
        BigInt(input.owners[i]!) <= 1n,
    ) ||
    new Set(input.owners.map((a) => a.toLowerCase())).size !==
      input.owners.length ||
    !Number.isSafeInteger(input.threshold) ||
    input.threshold < 1 ||
    input.threshold > input.owners.length ||
    typeof input.saltNonce !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(input.saltNonce) ||
    input.saltNonce.length > 78 ||
    BigInt(input.saltNonce) >= 1n << 256n
  )
    invalid();
}
function launchpadSetup(m: SmartAccountManifest) {
  return encodeFunctionData({
    abi: SAFE7579_LAUNCH_SETUP_ABI,
    functionName: "addSafe7579",
    args: [
      m.safe7579.address,
      [{ module: m.smartSessions.address, initData: "0x", moduleType: 1n }],
      [],
      0,
    ],
  });
}

function assembleCreation(input: CreationInput, setupTarget: Address, setupData: Hex) {
  validateCreationInput(input);
  const m = input.manifest, owners = input.owners.map((a) => getAddress(a));
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: "setup",
    args: [
      owners,
      BigInt(input.threshold),
      setupTarget,
      setupData,
      m.safe7579.address,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
  const initializerHash = keccak256(initializer);
  const salt = keccak256(
    concatHex([
      initializerHash,
      encodeAbiParameters([{ type: "uint256" }], [BigInt(input.saltNonce)]),
    ]),
  );
  const bytecode = concatHex([
    SAFE_141_PROXY_CREATION_CODE,
    encodeAbiParameters([{ type: "address" }], [m.singleton.address]),
  ]);
  const address = getContractAddress({
    from: m.factory.address,
    opcode: "CREATE2",
    salt,
    bytecode,
  });
  return {
    chainId: m.chainId,
    manifestId: m.id,
    manifestRevision: m.revision,
    address,
    owners,
    threshold: input.threshold,
    saltNonce: input.saltNonce,
    initializer,
    initializerHash,
    transaction: {
      to: m.factory.address,
      value: "0" as const,
      data: encodeFunctionData({
        abi: SAFE_CREATION_ABI,
        functionName: "createProxyWithNonce",
        args: [m.singleton.address, initializer, BigInt(input.saltNonce)],
      }),
    },
    initialAuthority: {
      validator: m.smartSessions.address,
      enabledSessions: 0,
      executors: [],
      hooks: [],
      fallbacks: [],
      registryEnforced: false as const,
    },
  };
}

/** Pure preparation only. The owner signs and funds the factory transaction in their wallet. */
export function prepareSafe7579Creation(input: CreationInput) {
  // Never silently produce the legacy initializer for an opted-in atomic passkey manifest.
  if (input.manifest.creationProfile !== undefined) invalid();
  validateCreationInput(input);
  return assembleCreation(input, input.manifest.launchpad.address, launchpadSetup(input.manifest));
}

/** Creates the immutable signer before setting up its Safe in the same reverting transaction. */
export function preparePasskeySafe7579Creation(input: {
  manifest: SmartAccountManifest;
  publicKey: { x: Hex; y: Hex };
  recoveryOwner: Address;
  saltNonce: string;
}) {
  const m = input.manifest, signerAddress = predictPasskeySignerAddress(input);
  const verifiers = toHex(BigInt(m.ownerProfile!.p256Verifier.address), { size: 22 });
  const signerFactoryData = encodeFunctionData({ abi: SIGNER_FACTORY_ABI, functionName: "createSigner",
    args: [BigInt(input.publicKey.x), BigInt(input.publicKey.y), BigInt(verifiers)] });
  const launchpadData = launchpadSetup(m);
  const call = (operation: 0 | 1, to: Address, data: Hex) => concatHex([
    toHex(operation, { size: 1 }), to.toLowerCase() as Address, toHex(0n, { size: 32 }),
    toHex((data.length - 2) / 2, { size: 32 }), data,
  ]);
  const multiSendData = encodeFunctionData({ abi: MULTI_SEND_ABI, functionName: "multiSend", args: [concatHex([
    call(0, m.ownerProfile!.signerFactory.address, signerFactoryData), call(1, m.launchpad.address, launchpadData),
  ])] });
  const bootstrap: PasskeyCreationBootstrap = { version: "center-passkey-bootstrap-v1", signerAddress,
    publicKey: { x: toHex(BigInt(input.publicKey.x), { size: 32 }), y: toHex(BigInt(input.publicKey.y), { size: 32 }) },
    verifiers, multiSendData, launchpadData, signerFactoryData };
  return { ...assembleCreation({ manifest: m, owners: [signerAddress, input.recoveryOwner], threshold: 1, saltNonce: input.saltNonce },
    m.creationProfile!.multiSend.address, multiSendData), bootstrap };
}

/** Canonical round-trip validation rejects arbitrary launchpad init data, hidden calls and payments. */
export function verifySafe7579CreationCall(
  manifest: SmartAccountManifest,
  account: Address,
  data: Hex,
) {
  try {
    if (manifest.creationProfile !== undefined && data.length > 32_770) invalid();
    const factory = decodeFunctionData({ abi: SAFE_CREATION_ABI, data });
    if (
      factory.functionName !== "createProxyWithNonce" ||
      !same(factory.args[0], manifest.singleton.address)
    )
      invalid();
    const setup = decodeFunctionData({
      abi: SAFE_SETUP_ABI,
      data: factory.args[1],
    });
    let prepared: ReturnType<typeof prepareSafe7579Creation> & { bootstrap?: PasskeyCreationBootstrap };
    if (manifest.creationProfile !== undefined) {
      // The first fixed call is createSigner(uint256,uint256,uint176). Reconstructing the complete
      // factory input below validates both packed entries, all offsets/padding and every setup field.
      const packed = decodeFunctionData({ abi: MULTI_SEND_ABI, data: setup.args[3] }).args[0];
      if (BigInt(sliceHex(packed, 53, 85)) !== 100n) invalid();
      const signer = decodeFunctionData({ abi: SIGNER_FACTORY_ABI, data: sliceHex(packed, 85, 185) });
      if (setup.args[0].length !== 2) invalid();
      prepared = preparePasskeySafe7579Creation({ manifest,
        publicKey: { x: toHex(signer.args[0], { size: 32 }), y: toHex(signer.args[1], { size: 32 }) },
        recoveryOwner: setup.args[0][1]!, saltNonce: String(factory.args[2]) });
    } else {
      prepared = prepareSafe7579Creation({ manifest, owners: setup.args[0],
        threshold: Number(setup.args[1]), saltNonce: String(factory.args[2]) });
    }
    if (
      !same(prepared.address, account) ||
      !same(prepared.transaction.data, data)
    )
      invalid();
    return prepared;
  } catch (error) {
    if (error instanceof RestError) throw error;
    return invalid();
  }
}
