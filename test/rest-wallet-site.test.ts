import { paymentProjectionFixture } from './fixtures/wallet-payment-projection.js';
import { describe, expect, it, vi } from 'vitest';
import { createWalletSite, type WalletSiteOptions } from '../src/rest/wallet/site.js';
import { walletCsrfToken, walletFlowCookie, walletSessionCookie, walletLaunchCookie } from '../src/rest/wallet/http.js';
import { privateKeyToAccount } from 'viem/accounts';
import { walletHandoffLaunchDocument } from '../src/rest/wallet/handoff.js';
import type { WalletCentralSession } from '../src/rest/wallet/login.js';
import { Hono } from 'hono';
import { mountRestSite, type RestSite } from '../src/rest/site.js';
import { RestError } from '../src/rest/core.js';

const origin='https://wallet.example.test', appOrigin='https://beep.example.test', audience='https://center.example.test/api/v1';
const flow=Buffer.alloc(32,7).toString('base64url'), token=Buffer.alloc(32,8).toString('base64url');
const accountId='eip155:8453:0x0000000000000000000000000000000000000003';
const loginId='11111111-1111-4111-8111-111111111111';
const appKey=privateKeyToAccount(`0x${'35'.repeat(32)}`);
function setup(overrides: Partial<WalletSiteOptions> = {}) {
  const started=Date.now();
  // HTTP controller evidence only: storage/crypto correctness has separate real-PG/EVM suites.
  const session={id:'22222222-2222-4222-8222-222222222222',accountId,expiresAtMs:Date.now()+3_600_000,
    credentialId:'private-credential-metadata',userHandle:'private-user-handle'} as WalletCentralSession;
  const options:WalletSiteOptions={origin,audience,browserScript:'/* local browser entry */',
    login:{begin:vi.fn(async()=>({login:{id:loginId,rpId:'wallet.example.test',origin,challenge:`0x${'01'.repeat(32)}` as const,expiresAtMs:Date.now()+180_000},flowToken:flow})),
      identifyCompletion:vi.fn(async()=>({accountId})),complete:vi.fn(async()=>({session,sessionToken:token,replayed:false})),
      identifySession:vi.fn(async()=>({accountId})),identityKnown:vi.fn(async()=>true),readSession:vi.fn(async()=>session),viewSession:vi.fn(async()=>session),passkeyName:vi.fn(async()=>'Juicebox fixture'),logout:vi.fn(async()=>({loggedOut:true as const,replayed:false}))},
    handoff:{prepare:vi.fn(async()=>({id:loginId,state:'prepared' as const,createdAtMs:Date.now(),expiresAtMs:Date.now()+180_000,request:{} as never})),
      getIntent:vi.fn(async()=>({id:flow,state:'prepared' as const,createdAtMs:started,expiresAtMs:started+180_000,request:{version:'center-wallet-handoff-request-v1' as const,
        issuer:origin,origin:appOrigin,callbackUri:appOrigin+'/center/callback',audience,appGeneration:1,requestKey:appKey.address,state:token,codeChallenge:flow,
        nonce:`0x${'09'.repeat(32)}` as const,issuedAtMs:started,expiresAtMs:started+180_000}})),
      issue:vi.fn(async()=>({code:flow,state:token,issuer:origin,callbackUri:appOrigin+'/center/callback'})),identifyExchange:vi.fn(async()=>({accountId})),exchange:vi.fn(async()=>({grant:{id:'public-grant'} as never,replayed:false}))},
    policy:{readActivePolicy:vi.fn(async()=>({revision:1,configurationHash:'a'.repeat(64),configuration:{version:'center-wallet-policy-v1' as const,applications:[{origin:appOrigin,walletCallbacks:[appOrigin+'/center/callback']}]},activatedAt:1,apps:[{origin:appOrigin,walletCallbacks:[appOrigin+'/center/callback'],generation:1,enabled:true,grantLifetimeSeconds:3600}]}))},
    refresh:{request:vi.fn(async()=>({status:'queued'})),tick:vi.fn(async()=>({}))},onEvent:vi.fn()};
  Object.assign(options, overrides);
  return {app:createWalletSite(options),options};
}
function request(path:string,body:unknown,headers:Record<string,string>={}) {
  return new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json','x-center-wallet-request':'1',...headers},body:JSON.stringify(body)});
}

describe('central payment approval HTTP boundary',()=>{
  it('names the app origin when the app request expired, and nothing else', async () => {
    const {app,options}=setup();
    vi.mocked(options.handoff.getIntent).mockRejectedValueOnce(new RestError(410,'WALLET_HANDOFF_EXPIRED','private',{origin:'https://beep.example',secret:'x'}));
    const response=await app.fetch(new Request(`${origin}/wallet/authorize/${flow}`));
    expect(response.status).toBe(410);expect(await response.json()).toEqual({error:{code:'WALLET_HANDOFF_EXPIRED',message:expect.any(String)},app:{origin:'https://beep.example'}});
    vi.mocked(options.handoff.getIntent).mockRejectedValueOnce(new RestError(403,'WALLET_HANDOFF_INACTIVE','private',{origin:'https://beep.example'}));
    const inactive=await app.fetch(new Request(`${origin}/wallet/authorize/${flow}`));
    expect(await inactive.json()).not.toHaveProperty('app');
  });
  it('preserves the exact discovery contract for installed clients when signup is enabled', async () => {
    const { app } = setup({ signup: {} as never, signupBrowserScript: '/* signup */' });
    const response = await app.fetch(new Request(origin + '/wallet/config', { headers: { origin: appOrigin } }));
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual(['app', 'audience', 'issuer', 'rpId', 'version']);
  });
  function payments() {const view=paymentProjectionFixture();return {
    get:vi.fn(async()=>view),approve:vi.fn(async()=>({view,replayed:false})),cancel:vi.fn(async()=>({...view,status:'cancelled' as const})),
  };}
  const headers={cookie:`${walletSessionCookie}=${token}`,'x-center-wallet-csrf':walletCsrfToken(token)};
  const assertion={credentialId:flow,userHandle:null,authenticatorData:Buffer.alloc(37).toString('base64url'),clientDataJSON:Buffer.from('{}').toString('base64url'),signature:Buffer.alloc(70).toString('base64url')};
  it('mounts the emitted payment approval URL and its production assets only with explicit configuration',async()=>{
    const {app}=setup({payments:payments(),paymentBrowserScript:'/* reviewed payment browser */'});
    const response=await app.fetch(new Request(origin+'/wallet/payment?review='+loginId));
    expect(response.status).toBe(200);expect(await response.text()).toContain('/wallet/assets/wallet-payment.js');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self';");
    const script=await app.fetch(new Request(origin+'/wallet/assets/wallet-payment.js'));
    expect(script.status).toBe(200);expect(await script.text()).toBe('/* reviewed payment browser */');
    expect(script.headers.get('content-type')).toContain('application/javascript');
    expect((await app.fetch(new Request(origin+'/wallet/assets/wallet-payment.css'))).status).toBe(200);
    for(const path of ['/wallet/payment?review='+loginId,'/wallet/assets/wallet-payment.js','/wallet/assets/wallet-payment.css'])
      expect((await setup().app.fetch(new Request(origin+path))).status).toBe(503);
  });
  it('lets exactly the review\'s app origin frame the payment page, and nothing frame it otherwise',async()=>{
    const service={...payments(),frameOrigin:vi.fn(async(id:string)=>{if(id!==loginId)throw new RestError(404,'WALLET_PAYMENT_REVIEW_MISSING','private');return 'https://beep.example';})};
    const {app}=setup({payments:service,paymentBrowserScript:'/* reviewed payment browser */',frameableAppOrigins:['https://beep.example']});
    const framed=await app.fetch(new Request(origin+'/wallet/payment?review='+loginId));
    expect(framed.status).toBe(200);expect(framed.headers.get('content-security-policy')).toContain("frame-ancestors https://beep.example;");
    expect(framed.headers.get('content-security-policy')).not.toContain("'none'; object-src");expect(framed.headers.get('x-frame-options')).toBeNull();
    expect(framed.headers.get('permissions-policy')).toContain('publickey-credentials-get=(self)');
    for(const path of ['/wallet/payment','/wallet/payment?review=00000000-0000-4000-8000-000000000000']){
      const plain=await app.fetch(new Request(origin+path));
      expect(plain.status).toBe(200);expect(plain.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect(plain.headers.get('x-frame-options')).toBe('DENY');
    }
    // Every other wallet page stays unframeable.
    const other=await app.fetch(new Request(origin+'/wallet/assets/wallet-payment.js'));expect(other.headers.get('x-frame-options')).toBe('DENY');
    // An app that is not admitted to frame, or no admitted app at all, gets no framing however live its review.
    for(const admitted of [['https://other.example'],undefined]){
      const gated=await setup({payments:service,paymentBrowserScript:'/* reviewed payment browser */',...(admitted?{frameableAppOrigins:admitted}:{})}).app.fetch(new Request(origin+'/wallet/payment?review='+loginId));
      expect(gated.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect(gated.headers.get('x-frame-options')).toBe('DENY');
    }
  });
  it('reads the selected passkey and payment metadata by review id alone, with no cookie session',async()=>{
    const service=payments(),{app,options}=setup({payments:service});
    vi.mocked(options.login.readSession).mockResolvedValue(null);vi.mocked(options.login.viewSession).mockResolvedValue(null);
    vi.mocked(options.login.identifySession).mockResolvedValue(null);
    const result=await app.fetch(new Request(origin+'/wallet/payment-reviews/review-id'));
    expect(result.status).toBe(200);expect(service.get).toHaveBeenCalledWith('review-id');
    const body=await result.json();expect(body.passkey).toMatchObject({credentialId:'selected-credential',userVerification:'required'});
    expect(body).not.toHaveProperty('approval');expect(JSON.stringify(body)).not.toContain('private-');
    expect(options.login.readSession).not.toHaveBeenCalled();expect(options.login.viewSession).not.toHaveBeenCalled();
  });
  it('passes the exact decoded assertion without a session, returning only the saved callback',async()=>{
    const service=payments(),{app,options}=setup({payments:service});
    const result=await app.fetch(request('/wallet/payment-reviews/review-id/approve',{assertion},{}));
    expect(result.status).toBe(200);
    expect(service.approve).toHaveBeenCalledWith('review-id',{
      credentialId:flow,userHandle:null,authenticatorData:Buffer.alloc(37),clientDataJSON:Buffer.from('{}'),signature:Buffer.alloc(70),
    });
    const body=await result.json(),callback=new URL(body.redirectUri);
    expect(callback.origin).toBe(appOrigin);expect(callback.pathname).toBe('/center/callback');
    expect(Object.fromEntries(callback.searchParams)).toEqual({review:'review-id',state:'app-state',iss:origin});
    expect(body.review.status).toBe('approved');expect(body).not.toHaveProperty('approval');
    expect(JSON.stringify(body)).not.toContain('0x1234');expect(JSON.stringify(vi.mocked(options.onEvent!).mock.calls)).not.toContain(flow);
  });
  it('rejects cross-origin and body-supplied authority before approval or cancellation',async()=>{
    const service=payments(),{app}=setup({payments:service});
    for(const action of ['approve','cancel']) {
      const body=action==='approve'?{assertion}:{};
      for(const h of [{origin:appOrigin},{'sec-fetch-site':'cross-site'}])
        expect((await app.fetch(request('/wallet/payment-reviews/review-id/'+action,body,h))).status).toBe(403);
      for(const extra of [{sessionId:'other'},{accountId:'other'},{callbackUri:'https://attacker.test'}])
        expect((await app.fetch(request('/wallet/payment-reviews/review-id/'+action,{...body,...extra},headers))).status).toBe(400);
    }
    expect(service.approve).not.toHaveBeenCalled();expect(service.cancel).not.toHaveBeenCalled();
  });
  it('allows cancellation by review id and never creates an approval',async()=>{
    const service=payments(),{app}=setup({payments:service});
    const response=await app.fetch(request('/wallet/payment-reviews/review-id/cancel',{},{}));
    expect(response.status).toBe(200);expect((await response.json()).status).toBe('cancelled');
    expect(service.cancel).toHaveBeenCalledWith('review-id');expect(service.approve).not.toHaveBeenCalled();
  });
  it('does not expose payment cookie endpoints through app CORS or enable an unconfigured service',async()=>{
    const {app}=setup();
    expect((await app.fetch(request('/wallet/payment-reviews/review-id/approve',{assertion},headers))).status).toBe(503);
    const preflight=await app.fetch(new Request(origin+'/wallet/payment-reviews/review-id/approve',{method:'OPTIONS',headers:{origin:appOrigin,'access-control-request-method':'POST','access-control-request-headers':'content-type,x-center-wallet-request,x-center-wallet-csrf'}}));
    expect(preflight.status).toBe(403);expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('dedicated Center wallet HTTP journey',()=>{
  it('rejects a leaked intent URL without a browser launch claim before session or account work',async()=>{
    const {app,options}=setup();
    const response=await app.fetch(request('/wallet/authorize/issue',{intentId:flow},{cookie:`${walletSessionCookie}=${token}`,'x-center-wallet-csrf':walletCsrfToken(token)}));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('WALLET_HANDOFF_UNCLAIMED');
    expect(options.handoff.issue).not.toHaveBeenCalled();
    expect(options.login.readSession).not.toHaveBeenCalled();
    expect(options.refresh.request).not.toHaveBeenCalled();
  });
  it('sends a retired wallet host to the same path on the current origin',async()=>{
    const {app}=setup({ legacyOrigins: ['https://wallet.example.test.old'] });
    const moved=await app.fetch(new Request('https://wallet.example.test.old/wallet/create?intent=abc',{headers:{host:'wallet.example.test.old'}}));
    expect(moved.status).toBe(301);expect(moved.headers.get('location')).toBe(origin+'/wallet/create?intent=abc');
    expect((await app.fetch(new Request('https://wallet.example.test.old/wallet/login/begin',{method:'POST',headers:{host:'wallet.example.test.old'}}))).status).toBe(301);
    expect((await app.fetch(new Request(origin+'/wallet/assets/wallet.css'))).status).toBe(200);
  });
  it('serves the wallet at the host root when mounted without a path prefix, and keeps /wallet links working',async()=>{
    const {app}=setup({ basePath: '', signup: {} as never, signupBrowserScript: '/* signup */' });
    const root=await app.fetch(new Request(origin+'/'));
    expect(root.status).toBe(200);expect(await root.text()).toContain('>Signa in</button>');
    expect(await (await app.fetch(new Request(origin+'/'))).text()).toContain('content=""');
    expect((await app.fetch(new Request(origin+'/create'))).status).toBe(200);
    expect((await app.fetch(new Request(origin+'/assets/wallet-signup.js'))).status).toBe(200);
    const icon=await app.fetch(new Request(origin+'/assets/favicon.svg'));
    expect(icon.status).toBe(200);expect(icon.headers.get('content-type')).toBe('image/svg+xml');expect(await icon.text()).toContain('🚬');
    expect((await app.fetch(new Request(origin+'/config'))).status).toBe(200);
    const moved=await app.fetch(new Request(origin+'/wallet/create?intent=abc',{headers:{'sec-fetch-mode':'navigate'}}));
    expect(moved.status).toBe(301);expect(moved.headers.get('location')).toBe(origin+'/create?intent=abc');
    // Never a protocol-relative or backslash path: the redirect stays on this origin or is refused.
    for (const path of ['/wallet//evil.example/x', '/wallet/\\evil.example', '/wallet//']) {
      const bad=await app.fetch(new Request(origin+path,{headers:{'sec-fetch-mode':'navigate'}}));
      expect(bad.status).toBe(404);
    }
    expect(()=>setup({ legacyOrigins:[origin] })).toThrow();
    expect((await app.fetch(new Request(origin+'/wallet/config'))).status).toBe(200);
    expect((await app.fetch(new Request(origin+'/api/v1/anything'))).status).toBe(404);
    expect((await app.fetch(new Request(origin+'/accounts'))).status).toBe(404);
  });
  it('sends the wallet host root to the wallet page',async()=>{
    const {app}=setup();const response=await app.fetch(new Request(origin+'/'));
    expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('/wallet');
    expect((await app.fetch(new Request(origin+'/anything'))).status).toBe(404);
  });
  it('serves a bare landing visit as the sign-in page, with signup offered as a link',async()=>{
    const {app}=setup({ signup: {} as never, signupBrowserScript: '/* signup */' });
    const bare=await app.fetch(new Request(origin+'/wallet'));
    expect(bare.status).toBe(200);const text=await bare.text();
    expect(text).toContain('>Signa in</button>');expect(text).toContain('id="wallet-create"');expect(text).not.toContain('id="signup-form"');
    expect((await app.fetch(new Request(origin+'/wallet',{headers:{cookie:`${walletSessionCookie}=${token}`}}))).status).toBe(200);
    expect((await app.fetch(new Request(origin+'/wallet?intent='+flow))).status).toBe(200);
    expect((await app.fetch(new Request(origin+'/wallet?payment='+loginId))).status).toBe(200);
    expect((await setup().app.fetch(new Request(origin+'/wallet'))).status).toBe(200);
  });
  it('serves a dedicated passkey page with self-only scripts',async()=>{
    const {app}=setup();const response=await app.fetch(new Request(origin+'/wallet'));
    expect(response.status).toBe(200);expect(await response.text()).toContain('>Signa in</button>');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self';");
    expect(response.headers.get('content-security-policy')).not.toMatch(/unsafe/);
    const script=await app.fetch(new Request(origin+'/wallet/assets/wallet.js'));
    expect(script.status).toBe(200);expect(script.headers.get('content-type')).toContain('application/javascript');
    expect(await script.text()).toBe('/* local browser entry */');
    const style=await app.fetch(new Request(origin+'/wallet/assets/wallet.css'));
    expect(style.status).toBe(200);expect(style.headers.get('content-type')).toContain('text/css');
  });
  it('issues a login challenge with an HttpOnly flow cookie and exposes no bearer in JSON',async()=>{
    const {app}=setup();const response=await app.fetch(request('/wallet/login/begin',{}));
    expect(response.status).toBe(201);const body=await response.json();
    expect(body.loginId).toBe(loginId);expect(body.publicKey).toMatchObject({rpId:'wallet.example.test',userVerification:'required'});
    expect(body.publicKey).not.toHaveProperty('allowCredentials');expect(JSON.stringify(body)).not.toContain(flow);
    expect(response.headers.get('set-cookie')).toContain(`${walletFlowCookie}=${flow}`);
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('rejects cross-app cookie mutations before service work, even for an allowlisted app',async()=>{
    const {app,options}=setup();const response=await app.fetch(request('/wallet/login/begin',{}, {origin:appOrigin}));
    expect(response.status).toBe(403);expect(options.login.begin).not.toHaveBeenCalled();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('completes with the bound flow cookie and CSRF proof, then refreshes only the proof-verified identity',async()=>{
    const {app,options}=setup();
    const body={loginId,assertion:{credentialId:flow,userHandle:token,authenticatorData:Buffer.alloc(37).toString('base64url'),clientDataJSON:Buffer.from('{}').toString('base64url'),signature:Buffer.alloc(70).toString('base64url')}};
    const response=await app.fetch(request('/wallet/login/complete',body,{cookie:`${walletFlowCookie}=${flow}`,'x-center-wallet-csrf':walletCsrfToken(flow)}));
    expect(response.status).toBe(200);expect(options.refresh.request).toHaveBeenCalledWith(accountId);
    const result=await response.json();expect(result.session.accountId).toBe(accountId);expect(result.csrfToken).toBe(walletCsrfToken(token));
    expect(JSON.stringify(result)).not.toContain('private-');expect(JSON.stringify(result)).not.toContain(token);
    expect(response.headers.get('set-cookie')).toContain(`${walletSessionCookie}=${token}`);
    expect(response.headers.get('set-cookie')).toContain(`${walletFlowCookie}=; Path=/; Max-Age=0`);
  });
  it('cannot issue a code from a session ID sent by the browser or from a cookie without CSRF',async()=>{
    const {app,options}=setup();const response=await app.fetch(request('/wallet/authorize/issue',{intentId:loginId,sessionId:loginId},{cookie:`${walletSessionCookie}=${token}`}));
    expect(response.status).toBe(403);expect(options.handoff.issue).not.toHaveBeenCalled();
  });
  it('issues the callback only through the cookie-authenticated central action',async()=>{
    const {app,options}=setup();
    const intent=await options.handoff.getIntent(flow), signature=await appKey.signTypedData(walletHandoffLaunchDocument({request:intent.request,intentId:flow}));
    const response=await app.fetch(request('/wallet/authorize/issue',{intentId:flow},{cookie:`${walletSessionCookie}=${token}; ${walletLaunchCookie}=${flow}.${signature}`,'x-center-wallet-csrf':walletCsrfToken(token)}));
    expect(response.status).toBe(200);expect(options.handoff.issue).toHaveBeenCalledWith(flow,'22222222-2222-4222-8222-222222222222',signature);
    expect(response.headers.get('set-cookie')).toContain(`${walletLaunchCookie}=; Path=/; Max-Age=0`);
    const result=await response.json();const callback=new URL(result.redirectUri);expect(callback.origin).toBe(appOrigin);
    expect(callback.searchParams.get('code')).toBe(flow);expect(callback.searchParams.get('state')).toBe(token);expect(callback.searchParams.get('iss')).toBe(origin);
  });
  it('sets a short HttpOnly launch claim only after an exact app-origin document POST and separate proof',async()=>{
    const {app,options}=setup(), intent=await options.handoff.getIntent(flow);
    const signature=await appKey.signTypedData(walletHandoffLaunchDocument({request:intent.request,intentId:flow}));
    const body=new URLSearchParams({intentId:flow,signature}).toString();
    const headers={origin:appOrigin,'content-type':'application/x-www-form-urlencoded','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
    for(const changed of [{origin:'https://attacker.test'}, {origin:'null'}, {'sec-fetch-dest':'iframe'}, {'sec-fetch-dest':'empty'}, {'sec-fetch-mode':'cors'}, {'content-type':'application/json'}]) {
      const result=await app.fetch(new Request(origin+'/wallet/launch',{method:'POST',headers:{...headers,...changed},body}));
      expect(result.status).toBeGreaterThanOrEqual(400);expect(result.headers.get('set-cookie')).toBeNull();
    }
    for(const invalid of [body+'&intentId='+flow, body+'&extra=1',body.replace(signature,'0x'+'00'.repeat(65)), 'x'.repeat(513)]) {
      const result=await app.fetch(new Request(origin+'/wallet/launch',{method:'POST',headers,body:invalid}));
      expect(result.status).toBeGreaterThanOrEqual(400);expect(result.headers.get('set-cookie')).toBeNull();
    }
    const result=await app.fetch(new Request(origin+'/wallet/launch',{method:'POST',headers,body}));
    expect(result.status).toBe(303);expect(result.headers.get('location')).toBe(origin+'/wallet?intent='+flow);
    expect(result.headers.get('location')).not.toContain(signature);
    expect(result.headers.get('set-cookie')).toContain(`${walletLaunchCookie}=${flow}.${signature}; Path=/; Max-Age=`);
    expect(result.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(options.login.readSession).not.toHaveBeenCalled();expect(options.handoff.issue).not.toHaveBeenCalled();
    const errorPage=await app.fetch(new Request(origin+'/wallet/launch',{method:'POST',headers:{...headers,origin:'null'},body}));
    expect(errorPage.headers.get('content-type')).toContain('text/html');
    expect(await errorPage.text()).toContain('Return to the app and connect again.');
  });
  it('allows credentialless exchange only for the active configured app origin',async()=>{
    const {app,options}=setup();const response=await app.fetch(request('/wallet/handoff/exchange',{intentId:loginId},{origin:appOrigin}));
    expect(response.status).toBe(200);expect(response.headers.get('access-control-allow-origin')).toBe(appOrigin);
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();expect(options.handoff.exchange).toHaveBeenCalledWith({intentId:loginId},appOrigin);
    const denied=await app.fetch(request('/wallet/handoff/exchange',{intentId:loginId},{origin:'https://untrusted.example.test'}));expect(denied.status).toBe(403);
    const withCookie=await app.fetch(request('/wallet/handoff/exchange',{intentId:loginId},{origin:appOrigin,cookie:`${walletSessionCookie}=${token}`}));expect(withCookie.status).toBe(403);
  });
  it('offers narrow app preflight without allowing cookie endpoints or a claimed Origin header',async()=>{
    const {app}=setup();
    const preflight=(path:string,headers='content-type,x-center-wallet-request')=>new Request(origin+path,{method:'OPTIONS',headers:{origin:appOrigin,'access-control-request-method':'POST','access-control-request-headers':headers}});
    const good=await app.fetch(preflight('/wallet/handoff/exchange'));expect(good.status).toBe(204);expect(good.headers.get('access-control-allow-origin')).toBe(appOrigin);
    expect((await app.fetch(preflight('/wallet/login/complete'))).status).toBe(403);
    expect((await app.fetch(preflight('/wallet/handoff/exchange','content-type,authorization'))).status).toBe(403);
  });
  it('logs out without refreshing provider authority and sends no sensitive values to events',async()=>{
    const {app,options}=setup();const response=await app.fetch(request('/wallet/logout',{}, {cookie:`${walletSessionCookie}=${token}`,'x-center-wallet-csrf':walletCsrfToken(token)}));
    expect(response.status).toBe(200);expect(options.login.logout).toHaveBeenCalledWith(token);expect(options.refresh.request).not.toHaveBeenCalled();
    const events=JSON.stringify(vi.mocked(options.onEvent!).mock.calls);expect(events).not.toContain(token);expect(events).not.toContain(flow);expect(events).not.toContain(accountId);
    expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('mounts the wallet without applying its cookie origin to other Center routes',async()=>{
    const {app:wallet}=setup(); const app=new Hono();
    mountRestSite(app as never,{app:new Hono().get('/health',c=>c.text('ok')),audience:new URL(audience).origin,accountsScript:'',docsHtml:'docs',docsCss:'',documents:new Map(),wallet} as unknown as RestSite);
    expect((await app.fetch(new Request(origin+'/wallet/config'))).status).toBe(200);
    expect((await app.fetch(new Request('https://center.example.test/api/v1/health'))).status).toBe(200);
    const accounts=await app.fetch(new Request('https://center.example.test/accounts'));
    expect(accounts.status).toBe(200);
    expect(await accounts.text()).not.toMatch(/\bPara\b|data-para-|getpara|usecapsule/);
    expect(accounts.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(accounts.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(accounts.headers.get('content-security-policy')).not.toMatch(/getpara|usecapsule/);
    expect((await app.fetch(new Request('https://center.example.test/assets/para.js'))).status).toBe(404);
    expect((await app.fetch(new Request('https://center.example.test/wallet/config'))).status).toBe(403);
    // Accounts scripts must never execute on the passkey cookie origin.
    expect((await app.fetch(new Request(origin+'/accounts'))).status).toBe(404);
    expect((await app.fetch(new Request(origin+'/assets/accounts.js'))).status).toBe(404);
    expect((await app.fetch(new Request(origin+'/api/v1/health'))).status).toBe(404);
  });
  it('shows the account while authority is being refreshed and keeps the cookie',async()=>{
    const {app,options}=setup();vi.mocked(options.login.readSession).mockResolvedValue(null);
    const response=await app.fetch(new Request(origin+'/wallet/session',{headers:{cookie:`${walletSessionCookie}=${token}`}}));
    expect(response.status).toBe(200);const body=await response.json();expect(body.session.accountId).toBe(accountId);
    expect(JSON.stringify(body)).not.toContain('private-');
    expect(response.headers.get('set-cookie')).toBeNull();expect(options.refresh.request).toHaveBeenCalledWith(accountId);
    // A session that no longer exists at all is simply absent.
    vi.mocked(options.login.viewSession).mockResolvedValue(null);
    expect(await(await app.fetch(new Request(origin+'/wallet/session',{headers:{cookie:`${walletSessionCookie}=${token}`}}))).json()).toEqual({session:null});
  });
  it('lists networks while authority is being refreshed',async()=>{
    const list=vi.fn(async()=>({networks:[],offered:[],pending:[]}));
    const {app,options}=setup({networks:{list} as never});vi.mocked(options.login.readSession).mockResolvedValue(null);
    const response=await app.fetch(new Request(origin+'/wallet/networks',{headers:{cookie:`${walletSessionCookie}=${token}`}}));
    expect(response.status).toBe(200);expect(list).toHaveBeenCalledWith(expect.objectContaining({accountId}));expect(options.refresh.request).toHaveBeenCalledWith(accountId);
    vi.mocked(options.login.viewSession).mockResolvedValue(null);
    expect((await app.fetch(new Request(origin+'/wallet/networks',{headers:{cookie:`${walletSessionCookie}=${token}`}}))).status).toBe(403);
  });
  it('does not request provider work for an invalid session',async()=>{
    const {app,options}=setup();vi.mocked(options.login.identifySession).mockResolvedValue(null);vi.mocked(options.login.readSession).mockResolvedValue(null);
    vi.mocked(options.login.viewSession).mockResolvedValue(null);
    const response=await app.fetch(new Request(origin+'/wallet/session',{headers:{cookie:`${walletSessionCookie}=${token}`}}));
    expect(await response.json()).toEqual({session:null});expect(options.refresh.request).not.toHaveBeenCalled();
  });
  it('does not expose cookie session responses to an app origin',async()=>{
    const {app}=setup();const response=await app.fetch(new Request(origin+'/wallet/session',{headers:{origin:appOrigin,cookie:`${walletSessionCookie}=${token}`}}));
    expect(response.headers.get('access-control-allow-origin')).toBeNull();expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('rejects browser-supplied session authority even with valid CSRF',async()=>{
    const {app,options}=setup();const response=await app.fetch(request('/wallet/authorize/issue',{intentId:loginId,sessionId:loginId},{cookie:`${walletSessionCookie}=${token}`,'x-center-wallet-csrf':walletCsrfToken(token)}));
    expect(response.status).toBe(400);expect(options.handoff.issue).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected errors and tolerates a failed observer after a completed mutation',async()=>{
    const {app,options}=setup();vi.mocked(options.onEvent!).mockImplementation(()=>{throw new Error('observer failed');});
    expect((await app.fetch(request('/wallet/login/begin',{}))).status).toBe(201);
    vi.mocked(options.login.begin).mockRejectedValue(new Error('secret '+flow));
    const response=await app.fetch(request('/wallet/login/begin',{}));expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(flow);
  });
  it('returns only explicitly enabled app discovery and never a credentialed CORS response',async()=>{
    const {app,options}=setup();const response=await app.fetch(new Request(origin+'/wallet/config',{headers:{origin:appOrigin}}));
    expect(await response.json()).toMatchObject({issuer:origin,audience,rpId:'wallet.example.test',app:{origin:appOrigin,generation:1,callbackUris:[appOrigin+'/center/callback']}});
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();vi.mocked(options.policy.readActivePolicy).mockResolvedValue(null);
    expect((await app.fetch(new Request(origin+'/wallet/config',{headers:{origin:appOrigin}}))).status).toBe(403);
  });
  it('rejects invalid proof identity before requesting a refresh',async()=>{
    const {app,options}=setup();vi.mocked(options.login.identifyCompletion).mockRejectedValue(new RestError(403,'WALLET_LOGIN_UNAUTHORIZED','private proof'));
    const response=await app.fetch(request('/wallet/login/complete',{loginId,assertion:{credentialId:flow,userHandle:token,authenticatorData:Buffer.alloc(37).toString('base64url'),clientDataJSON:Buffer.from('{}').toString('base64url'),signature:Buffer.alloc(70).toString('base64url')}},{cookie:`${walletFlowCookie}=${flow}`,'x-center-wallet-csrf':walletCsrfToken(flow)}));
    expect(response.status).toBe(403);expect(await response.text()).not.toContain('private proof');expect(options.refresh.request).not.toHaveBeenCalled();expect(options.login.complete).not.toHaveBeenCalled();
  });
  it('keeps the flow cookie long enough to recover a committed login after challenge expiry',async()=>{
    const {app}=setup(); const response=await app.fetch(request('/wallet/login/begin',{}));
    // The store rejects new completions after 3min, but an exact committed retry can recover
    // its original live 1h session. Losing the response must not also erase the recovery bearer.
    expect(response.headers.get('set-cookie')).toContain('Max-Age=3780;');
  });
  it('does not queue authority or issue a grant for a rejected exchange identity',async()=>{
    const {app,options}=setup();vi.mocked(options.handoff.identifyExchange).mockRejectedValue(new RestError(403,'WALLET_HANDOFF_INACTIVE','private proof'));
    const response=await app.fetch(request('/wallet/handoff/exchange',{intentId:loginId},{origin:appOrigin}));
    expect(response.status).toBe(403);expect(options.refresh.request).not.toHaveBeenCalled();expect(options.handoff.exchange).not.toHaveBeenCalled();
  });
  it('does not wait on a slow refresh batch when this session is already fresh',async()=>{
    const {app,options}=setup();let release!:()=>void; const slow=new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(options.refresh.tick).mockReturnValue(slow);
    const result=app.fetch(new Request(origin+'/wallet/session',{headers:{cookie:`${walletSessionCookie}=${token}`}}));
    try {
      const fast=await Promise.race([Promise.resolve(result).then(response=>response.status),new Promise<number>(resolve=>setTimeout(()=>resolve(0),50))]);
      expect(fast).toBe(200);
    } finally {release();await result;}
    expect(options.refresh.request).toHaveBeenCalledWith(accountId);
  });
  it('does not wait for blocked queue admission after proving a fresh session',async()=>{
    const {app,options}=setup();let release!:()=>void; const slow=new Promise<void>(resolve=>{release=resolve;});
    vi.mocked(options.refresh.request).mockReturnValue(slow);
    const result=app.fetch(new Request(origin+'/wallet/session',{headers:{cookie:`${walletSessionCookie}=${token}`}}));
    try {
      const fast=await Promise.race([Promise.resolve(result).then(response=>response.status),new Promise<number>(resolve=>setTimeout(()=>resolve(0),50))]);
      expect(fast).toBe(200);
    } finally {release();await result;}
  });
  it('requires a dedicated credential origin separate from the legacy API and Accounts site',()=>{
    const {options}=setup();expect(()=>createWalletSite({...options,origin:new URL(audience).origin})).toThrow();
  });
});

describe('sign-in framed by an admitted app',()=>{
  const assertion={credentialId:flow,userHandle:token,authenticatorData:Buffer.alloc(37).toString('base64url'),clientDataJSON:Buffer.from('{}').toString('base64url'),signature:Buffer.alloc(70).toString('base64url')};
  async function framedSetup(admitted:string[]|null=[appOrigin]) {
    const base=setup();
    const intent=await base.options.handoff.getIntent(flow);
    const launchSignature=await appKey.signTypedData(walletHandoffLaunchDocument({request:intent.request,intentId:flow}));
    const handoff={...base.options.handoff,
      frameOrigin:vi.fn(async(id:string)=>{if(id!==flow)throw new RestError(403,'WALLET_HANDOFF_INACTIVE','private');return appOrigin;}),
      claimLaunch:vi.fn(async()=>undefined),
      framedLaunch:vi.fn(async(id:string)=>{if(id!==flow)throw new RestError(403,'WALLET_HANDOFF_UNCLAIMED','private');return {intent,launchSignature};})};
    return {...setup({handoff,...(admitted?{frameableAppOrigins:admitted}:{})}),intent,launchSignature,handoff};
  }
  it('lets exactly the intent\'s app origin frame the sign-in page, and nothing frame it otherwise',async()=>{
    const {app}=await framedSetup();
    const framed=await app.fetch(new Request(origin+'/wallet?intent='+flow,{headers:{'Sec-Fetch-Dest':'iframe'}}));
    expect(framed.status).toBe(200);expect(framed.headers.get('content-security-policy')).toContain(`frame-ancestors ${appOrigin};`);
    expect(framed.headers.get('x-frame-options')).toBeNull();
    expect(await framed.text()).toContain('<html lang="en" class="framed">');
    expect(await (await app.fetch(new Request(origin+'/wallet?intent='+flow))).text()).not.toContain('class="framed"');
    for(const path of ['/wallet?intent='+token,'/wallet/authorize/'+flow]){
      const plain=await app.fetch(new Request(origin+path));
      expect(plain.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect(plain.headers.get('x-frame-options')).toBe('DENY');
    }
    for(const admitted of [['https://other.example'],null]){
      const gated=await (await framedSetup(admitted)).app.fetch(new Request(origin+'/wallet?intent='+flow));
      expect(gated.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect(gated.headers.get('x-frame-options')).toBe('DENY');
    }
  });
  it('keeps a framed launch\'s claim on the row instead of a cookie, for admitted apps only',async()=>{
    const {app,handoff,launchSignature}=await framedSetup();
    const body=new URLSearchParams({intentId:flow,signature:launchSignature}).toString();
    const headers={origin:appOrigin,'content-type':'application/x-www-form-urlencoded','sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'};
    const result=await app.fetch(new Request(origin+'/wallet/launch',{method:'POST',headers,body}));
    expect(result.status).toBe(303);expect(result.headers.get('location')).toBe(origin+'/wallet?intent='+flow);
    expect(result.headers.get('set-cookie')).toBeNull();expect(handoff.claimLaunch).toHaveBeenCalledWith(flow,launchSignature);
    expect(result.headers.get('content-security-policy')).toContain(`frame-ancestors ${appOrigin};`);
    // A document launch by the same app still takes the cookie path and leaves the row alone.
    const document=await app.fetch(new Request(origin+'/wallet/launch',{method:'POST',headers:{...headers,'sec-fetch-dest':'document'},body}));
    expect(document.status).toBe(303);expect(document.headers.get('set-cookie')).toContain(`${walletLaunchCookie}=${flow}.${launchSignature}`);
    expect(handoff.claimLaunch).toHaveBeenCalledTimes(1);
    for(const admitted of [['https://other.example'],null]){
      const gated=await framedSetup(admitted);
      const refused=await gated.app.fetch(new Request(origin+'/wallet/launch',{method:'POST',headers,body:new URLSearchParams({intentId:flow,signature:gated.launchSignature}).toString()}));
      expect(refused.status).toBe(403);expect(refused.headers.get('set-cookie')).toBeNull();expect(gated.handoff.claimLaunch).not.toHaveBeenCalled();
    }
  });
  it('signs in and issues the callback by intent id and one passkey naming the app, with no cookie either way',async()=>{
    const {app,options,launchSignature}=await framedSetup();
    const begun=await app.fetch(request(`/wallet/authorize/${flow}/begin`,{}));
    expect(begun.status).toBe(201);expect(begun.headers.get('set-cookie')).toBeNull();
    const challenge=await begun.json();expect(challenge.loginId).toBe(loginId);expect(challenge.flowToken).toBe(flow);expect(challenge.csrfToken).toBeUndefined();
    const approved=await app.fetch(request(`/wallet/authorize/${flow}/approve`,{loginId,flowToken:flow,assertion}));
    expect(approved.status).toBe(200);expect(approved.headers.get('set-cookie')).toBeNull();
    expect(options.login.identifyCompletion).toHaveBeenCalledWith(expect.objectContaining({loginId,flowToken:flow}),{topOrigin:appOrigin});
    expect(options.login.complete).toHaveBeenCalledWith(expect.objectContaining({loginId,flowToken:flow}),{topOrigin:appOrigin});
    expect(options.refresh.request).toHaveBeenCalledWith(accountId);
    expect(options.handoff.issue).toHaveBeenCalledWith(flow,'22222222-2222-4222-8222-222222222222',launchSignature);
    const result=await approved.json();const callback=new URL(result.redirectUri);expect(callback.origin).toBe(appOrigin);
    expect(callback.searchParams.get('code')).toBe(flow);expect(callback.searchParams.get('state')).toBe(token);expect(callback.searchParams.get('iss')).toBe(origin);
    expect(JSON.stringify(result)).not.toContain(token+'"');
    // An intent that was never launched into a frame, or an app not admitted, has no framed sign-in.
    expect((await app.fetch(request(`/wallet/authorize/${token}/begin`,{}))).status).toBe(403);
    expect((await app.fetch(request(`/wallet/authorize/${token}/approve`,{loginId,flowToken:flow,assertion}))).status).toBe(403);
    const gated=await framedSetup(['https://other.example']);
    expect((await gated.app.fetch(request(`/wallet/authorize/${flow}/begin`,{}))).status).toBe(403);
    expect((await gated.app.fetch(request(`/wallet/authorize/${flow}/approve`,{loginId,flowToken:flow,assertion}))).status).toBe(403);
    expect(gated.options.login.complete).not.toHaveBeenCalled();expect(gated.options.handoff.issue).not.toHaveBeenCalled();
  });
  it('lets a framed launch opened as a page issue its callback from the claim on the row',async()=>{
    const {app,options,launchSignature}=await framedSetup();
    const headers={cookie:`${walletSessionCookie}=${token}`,'x-center-wallet-csrf':walletCsrfToken(token)};
    const issued=await app.fetch(request('/wallet/authorize/issue',{intentId:flow},headers));
    expect(issued.status).toBe(200);expect(options.handoff.issue).toHaveBeenCalledWith(flow,'22222222-2222-4222-8222-222222222222',launchSignature);
    expect(new URL((await issued.json()).redirectUri).origin).toBe(appOrigin);
    // An intent never launched into a frame still needs the cookie.
    const unclaimed=await app.fetch(request('/wallet/authorize/issue',{intentId:token},headers));
    expect(unclaimed.status).toBe(403);expect((await unclaimed.json()).error.code).toBe('WALLET_HANDOFF_UNCLAIMED');
  });
  it('never admits a framing top origin on the cookie sign-in',async()=>{
    const {app,options}=await framedSetup();
    const response=await app.fetch(request('/wallet/login/complete',{loginId,assertion},{cookie:`${walletFlowCookie}=${flow}`,'x-center-wallet-csrf':walletCsrfToken(flow)}));
    expect(response.status).toBe(200);expect(options.login.complete).toHaveBeenCalledTimes(1);
    expect((options.login.complete as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
  });
});

describe('onramp HTTP boundary',()=>{
  const signedIn={cookie:`${walletSessionCookie}=${token}`,'x-center-wallet-csrf':walletCsrfToken(token)};
  function onramp(){return {applePay:false,session:vi.fn(async()=>({url:'https://pay.coinbase.com/buy?sessionToken=t'})),verify:vi.fn(),confirm:vi.fn(),order:vi.fn(),status:vi.fn()};}
  it('opens checkout only for the signed-in account, to its own address',async()=>{
    const service=onramp();const {app}=setup({onramp:service as never});
    const response=await app.fetch(request('/wallet/onramp/session',{amount:'20'},signedIn));
    expect(response.status).toBe(200);expect(await response.json()).toEqual({url:'https://pay.coinbase.com/buy?sessionToken=t'});
    expect(service.session).toHaveBeenCalledWith('0x0000000000000000000000000000000000000003',{amount:'20'});
    expect((await app.fetch(request('/wallet/onramp/session',{},{cookie:signedIn.cookie}))).status).toBe(403);
    expect((await app.fetch(request('/wallet/onramp/session',{}))).status).toBe(403);
    expect((await app.fetch(request('/wallet/onramp/session',{destinationAddress:'0x00000000000000000000000000000000000000bb'},signedIn))).status).toBe(400);
    expect(service.session).toHaveBeenCalledTimes(1);
  });
  it('reports what is offered to a signed-in account and is absent without configuration',async()=>{
    const {app}=setup({onramp:onramp() as never});
    const offered=await app.fetch(new Request(origin+'/wallet/onramp',{headers:{cookie:signedIn.cookie}}));
    expect(await offered.json()).toEqual({applePay:false});
    expect((await app.fetch(new Request(origin+'/wallet/onramp'))).status).toBe(403);
    expect((await setup().app.fetch(request('/wallet/onramp/session',{},signedIn))).status).toBe(503);
  });
});
