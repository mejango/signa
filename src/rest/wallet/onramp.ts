import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { RestError } from '../core.js';

/** Coinbase Onramp for a Signa account: headless Apple Pay guest checkout (cards, US), and the hosted
 * checkout for people paying from a Coinbase account (Coinbase ended hosted guest checkout 2026-06-30).
 * Apple Pay embeds Coinbase's pay button in a frame on the wallet origin; the hosted checkout opens a window. Purchases land as USDC or ETH on Base at the account's own
 * address; the caller never names a destination. Signa stores nothing: Coinbase runs the one-time codes
 * and checks each order's email and phone against its own verification records, and the device keeps
 * the verification ids. Contact details never sign in, recover or otherwise act for the account. */
export interface WalletOnrampConfig {
  keyId: string;
  /** Ed25519 (base64 of seed and public key, 64 bytes) or an EC private key in PEM. */
  secret: string;
  /** The wallet origin; its host is the registered domain the embedded Apple Pay button renders on. */
  origin: string;
  applePay?: boolean;
  /** Coinbase sandbox: production key, `sandbox-` user refs, Apple Pay's sandbox sheet. */
  sandbox?: boolean;
  fetch?: typeof fetch;
}
export interface WalletOnrampOrder { orderId: string; status: string; txHash: string | null }

const api = 'https://api.cdp.coinbase.com/platform/v2/onramp';
const network = 'base';
const phone = /^\+1[2-9][0-9]{9}$/, email = /^[^\s@<>()"',;:\\]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){1,8}$/, verification = /^onramp_verification_[0-9a-f-]{36}$/;

function invalid(): never { throw new RestError(400, 'WALLET_ONRAMP_INVALID', 'Onramp request fields are invalid.'); }
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}
/** What the account can buy on Base: USDC (the default) or ETH. */
function asset(value: unknown): 'USDC' | 'ETH' {
  return value === undefined || value === null ? 'USDC' : text(value, /^(USDC|ETH)$/) as 'USDC' | 'ETH';
}
/** Whole US dollars and cents, $1 to $10,000; Coinbase applies its own tighter limits per user. */
export function onrampAmount(value: unknown): string {
  const amount = text(value, /^[0-9]{1,5}(\.[0-9]{1,2})?$/);
  if (Number(amount) < 1 || Number(amount) > 10_000) invalid();
  return amount;
}

function signingKey(secret: string): { key: KeyObject; alg: 'EdDSA' | 'ES256' } {
  if (secret.includes('PRIVATE KEY')) return { key: createPrivateKey(secret.replace(/\\n/g, '\n')), alg: 'ES256' };
  const raw = Buffer.from(secret, 'base64');
  if (raw.length !== 64) throw new Error('CDP_API_KEY_SECRET must be an Ed25519 key (64 bytes, base64) or an EC PEM key');
  return { key: createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519',
    d: raw.subarray(0, 32).toString('base64url'), x: raw.subarray(32).toString('base64url') } }), alg: 'EdDSA' };
}
/** CDP's per-request bearer: two minutes, bound to one method and URL (as `@coinbase/cdp-sdk` builds it). */
export function cdpJwt(keyId: string, secret: KeyObject | string, method: string, url: string, nowMs = Date.now()): string {
  const { key, alg } = typeof secret === 'string' ? signingKey(secret) : { key: secret, alg: secret.asymmetricKeyType === 'ed25519' ? 'EdDSA' as const : 'ES256' as const };
  const now = Math.floor(nowMs / 1000), target = new URL(url);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${part({ alg, kid: keyId, typ: 'JWT', nonce: randomBytes(16).toString('hex') })}.${part({
    sub: keyId, iss: 'cdp', iat: now, nbf: now, exp: now + 120, uris: [`${method} ${target.host}${target.pathname}`] })}`;
  const signature = alg === 'EdDSA' ? sign(null, Buffer.from(data), key) : sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

/** Coinbase's error types the person can act on; anything else is Coinbase being unavailable. */
const known: Record<string, [number, string]> = {
  guest_transaction_limit: [429, 'WALLET_ONRAMP_LIMIT'],
  rate_limit_exceeded: [429, 'WALLET_ONRAMP_BUSY'],
  otp_verification_code_invalid: [400, 'WALLET_ONRAMP_CODE_INVALID'],
  otp_verification_expired: [409, 'WALLET_ONRAMP_VERIFY_AGAIN'],
  otp_verification_invalid: [409, 'WALLET_ONRAMP_VERIFY_AGAIN'],
  otp_verification_not_found: [409, 'WALLET_ONRAMP_VERIFY_AGAIN'],
  otp_verification_required: [409, 'WALLET_ONRAMP_VERIFY_AGAIN'],
  otp_verification_destination_mismatch: [409, 'WALLET_ONRAMP_VERIFY_AGAIN'],
  phone_number_verification_expired: [409, 'WALLET_ONRAMP_VERIFY_AGAIN'],
};

export function createWalletOnramp(config: WalletOnrampConfig) {
  const { key } = signingKey(config.secret), request = config.fetch ?? fetch, domain = new URL(config.origin).hostname;
  const call = async (method: 'GET' | 'POST', path: string, body?: object): Promise<Record<string, unknown>> => {
    const url = api + path;
    let response: Response;
    try {
      response = await request(url, { method, signal: AbortSignal.timeout(15_000), headers: {
        authorization: `Bearer ${cdpJwt(config.keyId, key, method, url)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new RestError(503, 'WALLET_ONRAMP_UNAVAILABLE', 'Coinbase did not answer.'); }
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok && json && typeof json === 'object') return json;
    const type = typeof json?.errorType === 'string' ? json.errorType : '';
    const [status, code] = known[type] ?? [503, 'WALLET_ONRAMP_UNAVAILABLE'];
    throw new RestError(status, code, 'Coinbase declined the onramp request.', { upstreamStatus: response.status, errorType: type.slice(0, 60) });
  };
  // Coinbase's per-user key: stable per account, opaque, under its 50-character bound.
  const userRef = (address: string) => (config.sandbox ? 'sandbox-' : '') + createHash('sha256').update('signa-onramp-v1\0' + address.toLowerCase()).digest('hex').slice(0, 32);
  // ponytail: per-process count; a shared limiter when Signa runs more than one instance.
  const codesSent = new Map<string, number[]>();
  const applePay = () => { if (!config.applePay) throw new RestError(503, 'WALLET_ONRAMP_APPLE_PAY_UNAVAILABLE', 'Apple Pay is not enabled.'); };

  return {
    applePay: config.applePay === true,
    /** A single-use Coinbase checkout URL for USDC on Base to this account. */
    async session(address: string, input: { amount?: unknown; asset?: unknown }) {
      const amount = input.amount === undefined || input.amount === null ? null : onrampAmount(input.amount);
      const result = await call('POST', '/sessions', { destinationAddress: address, destinationNetwork: network, purchaseCurrency: asset(input.asset),
        partnerUserRef: userRef(address), ...(amount ? { paymentAmount: amount, paymentCurrency: 'USD' } : {}) });
      const url = (result.session as { onrampUrl?: unknown } | undefined)?.onrampUrl;
      if (typeof url !== 'string' || !url.startsWith('https://pay.coinbase.com/')) throw new RestError(503, 'WALLET_ONRAMP_UNAVAILABLE', 'Coinbase returned no checkout URL.');
      return { url };
    },
    /** Coinbase texts or emails a six-digit code. At most five sends per account per ten minutes. */
    async verify(accountId: string, input: { channel?: unknown; destination?: unknown }) {
      applePay();
      const channel = text(input.channel, /^(sms|email)$/);
      const destination = text(input.destination, channel === 'sms' ? phone : email);
      const now = Date.now(), recent = (codesSent.get(accountId) ?? []).filter(at => now - at < 600_000);
      if (recent.length >= 5) throw new RestError(429, 'WALLET_ONRAMP_BUSY', 'Too many codes sent.');
      codesSent.set(accountId, [...recent, now]);
      const result = await call('POST', '/verifications', { channel, destination });
      return { verificationId: text(result.verificationId, verification) };
    },
    async confirm(input: { verificationId?: unknown; code?: unknown }) {
      applePay();
      const id = text(input.verificationId, verification);
      const result = await call('POST', `/verifications/${id}/submit`, { otpCode: text(input.code, /^[0-9]{6}$/) });
      return { verificationId: text(result.verificationId, verification),
        verifiedAtMs: Date.now(), expiresAt: typeof result.verificationExpiresAt === 'string' ? result.verificationExpiresAt : null };
    },
    /** An Apple Pay order. `embed` renders Coinbase's pay button in a frame on the wallet origin (its registered
     * domain); otherwise the link opens top-level, as inside an app's frame where Apple checks the app's domain. */
    async order(address: string, input: Record<string, unknown>) {
      applePay();
      const amount = onrampAmount(input.amount);
      const phoneVerifiedAtMs = Number(input.phoneVerifiedAtMs);
      if (!Number.isSafeInteger(phoneVerifiedAtMs) || phoneVerifiedAtMs > Date.now() + 60_000 || Date.now() - phoneVerifiedAtMs > 60 * 86_400_000) invalid();
      if (input.agreed !== true) invalid();
      const token = input.userAuthToken === undefined || input.userAuthToken === null ? undefined : text(input.userAuthToken, /^[A-Za-z0-9._~+/=-]{1,2048}$/);
      const result = await call('POST', '/orders', { paymentAmount: amount, paymentCurrency: 'USD', purchaseCurrency: asset(input.asset),
        paymentMethod: 'GUEST_CHECKOUT_APPLE_PAY', destinationAddress: address, destinationNetwork: network, partnerUserRef: userRef(address),
        email: text(input.email, email), phoneNumber: text(input.phoneNumber, phone),
        emailVerificationId: text(input.emailVerificationId, verification),
        smsVerificationId: text(input.smsVerificationId, verification),
        phoneNumberVerifiedAt: new Date(phoneVerifiedAtMs).toISOString(), agreementAcceptedAt: new Date().toISOString(),
        ...(input.embed === true ? { domain } : {}),
        ...(token ? { userAuthToken: token } : {}) });
      const order = result.order as Record<string, unknown> | undefined, link = result.paymentLink as Record<string, unknown> | undefined;
      if (typeof link?.url !== 'string' || !link.url.startsWith('https://pay.coinbase.com/') || typeof order?.orderId !== 'string')
        throw new RestError(503, 'WALLET_ONRAMP_UNAVAILABLE', 'Coinbase returned no payment link.');
      const url = new URL(link.url);
      if (config.sandbox) url.searchParams.set('useApplePaySandbox', 'true');
      return { orderId: order.orderId, url: url.href, userAuthToken: typeof result.userAuthToken === 'string' ? result.userAuthToken : null };
    },
    /** An order's progress, read only for the account it pays. */
    async status(address: string, input: { orderId?: unknown }): Promise<WalletOnrampOrder> {
      applePay();
      const id = text(input.orderId, /^[A-Za-z0-9-]{1,64}$/);
      const order = (await call('GET', `/orders/${id}`)).order as Record<string, unknown> | undefined;
      if (typeof order?.destinationAddress !== 'string' || order.destinationAddress.toLowerCase() !== address.toLowerCase())
        throw new RestError(404, 'WALLET_ONRAMP_ORDER_MISSING', 'No such order for this account.');
      return { orderId: id, status: String(order.status ?? 'unknown').replace(/^ONRAMP_ORDER_STATUS_/, '').toLowerCase().slice(0, 40),
        txHash: typeof order.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(order.txHash) ? order.txHash : null };
    },
  };
}
