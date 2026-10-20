import type * as RecoveryKit from './walletRecoveryKit.js';
import { lazyModule, whenIdle } from './lazyModule.js';

// The backup kit (BIP-39, BIP-32, secp256k1) is its own bundle, loaded when a backup is first used.
let loaded: typeof RecoveryKit | undefined;
export const loadRecoveryKit = () => lazyModule<typeof RecoveryKit>('wallet-recovery-kit').then(kit => loaded = kit);
/** The kit once it has loaded, for a click that must stay synchronous (file sharing needs the user's activation). */
export const loadedRecoveryKit = () => loaded;
/** A backup kit is the default method, so most visitors need it. */
export const preloadRecoveryKit = () => whenIdle(loadRecoveryKit);
