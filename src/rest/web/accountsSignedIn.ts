// What /accounts needs only after sign-in: smart wallets and sessions, bot keys and bot proof checks.
// Its own bundle, loaded when an account connects (src/rest/web/lazyModule.ts).
export { installSmartWalletUI } from "./smartSessions.js";
export { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
export { verifyBotProof } from "../auth/signatures.js";
export { connectionForBot, createBotRegistration, parseBotRegistration } from "../client/index.js";
