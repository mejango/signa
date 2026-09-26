import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cdpJwt, createWalletOnramp } from '../src/rest/wallet/onramp.js';

const address = '0x00000000000000000000000000000000000000aa';
const vid = 'onramp_verification_a1b2c3d4-e5f6-7890-abcd-ef1234567890';
function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey, secret: Buffer.concat([Buffer.from(jwk.d!, 'base64url'), Buffer.from(jwk.x!, 'base64url')]).toString('base64') };
}
function decode(jwt: string) {
  const [header, claims] = jwt.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part!, 'base64url').toString()));
  return { header, claims };
}
function onramp(reply: (url: string, body: any) => [number, unknown], extra: { applePay?: boolean; sandbox?: boolean } = {}) {
  const calls: { url: string; method: string; body: any; auth: string }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: String(init.method), body, auth: String((init.headers as Record<string, string>).authorization) });
    const [status, json] = reply(url, body);
    return new Response(JSON.stringify(json), { status });
  });
  return { calls, service: createWalletOnramp({ keyId: 'key-id', secret: ed25519().secret, origin: 'https://signa.center', fetch: fetch as never, ...extra }) };
}

describe('CDP request signing', () => {
  it('signs an Ed25519 JWT bound to one method and URL for two minutes', () => {
    const { publicKey, secret } = ed25519();
    const jwt = cdpJwt('key-id', secret, 'POST', 'https://api.cdp.coinbase.com/platform/v2/onramp/sessions', 1_000_000_000);
    const { header, claims } = decode(jwt);
    expect(header).toMatchObject({ alg: 'EdDSA', kid: 'key-id', typ: 'JWT' }); expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(claims).toEqual({ sub: 'key-id', iss: 'cdp', iat: 1_000_000, nbf: 1_000_000, exp: 1_000_120, uris: ['POST api.cdp.coinbase.com/platform/v2/onramp/sessions'] });
    const [h, c, s] = jwt.split('.');
    expect(verify(null, Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });
  it('signs ES256 with a PEM key whose newlines arrive escaped', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = String(privateKey.export({ format: 'pem', type: 'sec1' })).replace(/\n/g, '\\n');
    const jwt = cdpJwt('key-id', pem, 'GET', 'https://api.cdp.coinbase.com/platform/v2/onramp/orders/x');
    expect(decode(jwt).header.alg).toBe('ES256');
    const [h, c, s] = jwt.split('.');
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
  });
  it('refuses a secret that is neither key type', () => {
    expect(() => createWalletOnramp({ keyId: 'k', secret: 'short', origin: 'https://signa.center' })).toThrow(/CDP_API_KEY_SECRET/);
  });
});

describe('hosted onramp', () => {
  it('buys USDC on Base for the account, with a preset amount when given', async () => {
    const { calls, service } = onramp(() => [201, { session: { onrampUrl: 'https://pay.coinbase.com/buy?sessionToken=t' } }]);
    expect(await service.session(address, { amount: '25.50' })).toEqual({ url: 'https://pay.coinbase.com/buy?sessionToken=t' });
    expect(calls[0]!.url).toBe('https://api.cdp.coinbase.com/platform/v2/onramp/sessions');
    expect(calls[0]!.body).toEqual({ destinationAddress: address, destinationNetwork: 'base', purchaseCurrency: 'USDC',
      partnerUserRef: expect.stringMatching(/^[0-9a-f]{32}$/), paymentAmount: '25.50', paymentCurrency: 'USD' });
    expect(decode(calls[0]!.auth.slice('Bearer '.length)).claims.uris).toEqual(['POST api.cdp.coinbase.com/platform/v2/onramp/sessions']);
    await service.session(address, {});
    expect(calls[1]!.body).not.toHaveProperty('paymentAmount');
    expect(calls[1]!.body.partnerUserRef).toBe(calls[0]!.body.partnerUserRef);
  });
  it('rejects bad amounts before calling Coinbase and URLs that are not Coinbase checkout', async () => {
    const { calls, service } = onramp(() => [201, { session: { onrampUrl: 'https://evil.example/buy' } }]);
    for (const amount of ['0.5', '10001', '1e3', '-5', '5.001', 5]) await expect(service.session(address, { amount })).rejects.toMatchObject({ code: 'WALLET_ONRAMP_INVALID' });
    expect(calls).toHaveLength(0);
    await expect(service.session(address, {})).rejects.toMatchObject({ status: 503, code: 'WALLET_ONRAMP_UNAVAILABLE' });
  });
  it('names limits the person can act on and hides every other Coinbase failure', async () => {
    let reply: [number, unknown] = [429, { errorType: 'guest_transaction_limit', errorMessage: 'private' }];
    const { service } = onramp(() => reply);
    await expect(service.session(address, {})).rejects.toMatchObject({ status: 429, code: 'WALLET_ONRAMP_LIMIT' });
    reply = [500, { errorType: 'internal', errorMessage: 'private' }];
    await expect(service.session(address, {})).rejects.toMatchObject({ status: 503, code: 'WALLET_ONRAMP_UNAVAILABLE' });
  });
});

describe('Apple Pay guest checkout', () => {
  it('stays off until enabled', async () => {
    const { calls, service } = onramp(() => [201, {}]);
    expect(service.applePay).toBe(false);
    await expect(service.verify('a', { channel: 'sms', destination: '+12125551234' })).rejects.toMatchObject({ status: 503, code: 'WALLET_ONRAMP_APPLE_PAY_UNAVAILABLE' });
    await expect(service.order(address, {})).rejects.toMatchObject({ code: 'WALLET_ONRAMP_APPLE_PAY_UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });
  it('sends US mobile and email codes through Coinbase, five per account per ten minutes', async () => {
    const { calls, service } = onramp(() => [201, { verificationId: vid, otpExpiresAt: 'x' }], { applePay: true });
    await expect(service.verify('a', { channel: 'sms', destination: '+442071234567' })).rejects.toMatchObject({ code: 'WALLET_ONRAMP_INVALID' });
    await expect(service.verify('a', { channel: 'email', destination: 'not an email' })).rejects.toMatchObject({ code: 'WALLET_ONRAMP_INVALID' });
    for (let i = 0; i < 5; i++) expect(await service.verify('a', { channel: i % 2 ? 'email' : 'sms', destination: i % 2 ? 'a@b.co' : '+12125551234' })).toEqual({ verificationId: vid });
    await expect(service.verify('a', { channel: 'sms', destination: '+12125551234' })).rejects.toMatchObject({ status: 429, code: 'WALLET_ONRAMP_BUSY' });
    await service.verify('b', { channel: 'sms', destination: '+12125551234' });
    expect(calls).toHaveLength(6); expect(calls[0]!.body).toEqual({ channel: 'sms', destination: '+12125551234' });
  });
  it('submits a six-digit code and maps a wrong one', async () => {
    let reply: [number, unknown] = [200, { verificationId: vid, verificationExpiresAt: '2026-11-25T00:00:00Z' }];
    const { calls, service } = onramp(() => reply, { applePay: true });
    await expect(service.confirm({ verificationId: vid, code: '12345' })).rejects.toMatchObject({ code: 'WALLET_ONRAMP_INVALID' });
    expect(await service.confirm({ verificationId: vid, code: '123456' })).toMatchObject({ verificationId: vid, expiresAt: '2026-11-25T00:00:00Z' });
    expect(calls[0]!.url).toBe(`https://api.cdp.coinbase.com/platform/v2/onramp/verifications/${vid}/submit`);
    reply = [400, { errorType: 'otp_verification_code_invalid' }];
    await expect(service.confirm({ verificationId: vid, code: '123456' })).rejects.toMatchObject({ status: 400, code: 'WALLET_ONRAMP_CODE_INVALID' });
  });
  const input = { amount: '20', email: 'a@b.co', phoneNumber: '+12125551234', emailVerificationId: vid, smsVerificationId: vid, phoneVerifiedAtMs: Date.now() - 1000, agreed: true };
  it('orders to the account with Coinbase-verified contacts and opens top-level (sandbox sheet in sandbox)', async () => {
    const { calls, service } = onramp(() => [201, { order: { orderId: 'order-1' }, paymentLink: { url: 'https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1' }, userAuthToken: 'tok' }], { applePay: true, sandbox: true });
    const result = await service.order(address, input);
    expect(result).toEqual({ orderId: 'order-1', url: 'https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1&useApplePaySandbox=true', userAuthToken: 'tok' });
    expect(calls[0]!.body).toMatchObject({ paymentAmount: '20', paymentCurrency: 'USD', purchaseCurrency: 'USDC', paymentMethod: 'GUEST_CHECKOUT_APPLE_PAY',
      destinationAddress: address, destinationNetwork: 'base', partnerUserRef: expect.stringMatching(/^sandbox-[0-9a-f]{32}$/),
      email: 'a@b.co', phoneNumber: '+12125551234', emailVerificationId: vid, smsVerificationId: vid });
    expect(calls[0]!.body).not.toHaveProperty('domain');
    await service.order(address, { ...input, embed: true });
    expect(calls[1]!.body.domain).toBe('signa.center');
    for (const bad of [{ agreed: false }, { phoneVerifiedAtMs: Date.now() - 61 * 86_400_000 }, { phoneVerifiedAtMs: Date.now() + 3_600_000 }, { smsVerificationId: 'x' }])
      await expect(service.order(address, { ...input, ...bad })).rejects.toMatchObject({ code: 'WALLET_ONRAMP_INVALID' });
  });
  it('asks to verify again when Coinbase no longer accepts the verification', async () => {
    const { service } = onramp(() => [400, { errorType: 'otp_verification_destination_mismatch' }], { applePay: true });
    await expect(service.order(address, input)).rejects.toMatchObject({ status: 409, code: 'WALLET_ONRAMP_VERIFY_AGAIN' });
  });
  it('reads an order only for the account it pays', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const { service } = onramp(() => [200, { order: { orderId: 'order-1', destinationAddress: address.toUpperCase().replace('0X', '0x'), status: 'ONRAMP_ORDER_STATUS_COMPLETED', txHash: hash } }], { applePay: true });
    expect(await service.status(address, { orderId: 'order-1' })).toEqual({ orderId: 'order-1', status: 'completed', txHash: hash });
    await expect(service.status('0x00000000000000000000000000000000000000bb', { orderId: 'order-1' })).rejects.toMatchObject({ status: 404 });
    await expect(service.status(address, { orderId: '../x' })).rejects.toMatchObject({ code: 'WALLET_ONRAMP_INVALID' });
  });
});
