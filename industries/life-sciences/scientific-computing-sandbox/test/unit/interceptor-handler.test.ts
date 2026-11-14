// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { generateKeyPairSync, sign } from 'crypto';
import { CALLER_SUB_HEADER } from '../../lib/identity';

type Handler = typeof import('../../lambda/caller-identity-interceptor/index').handler;

const DISCOVERY_URL = 'https://idp.example.com/.well-known/openid-configuration';
const ISSUER = 'https://idp.example.com';
const JWKS_URI = 'https://idp.example.com/.well-known/jwks.json';
const KID = 'test-key';

// A locally generated signing key and its JWKS; nothing is fetched from the network.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function token(claims: Record<string, unknown> = {}): string {
  const payload = {
    iss: ISSUER,
    sub: 'user-123',
    client_id: 'quick-client',
    scope: 'openid sandbox/invoke',
    iat: now(),
    exp: now() + 300,
    ...claims,
  };
  const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT', kid: KID })}.${b64url(payload)}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

const body = {
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'sandbox___execute_code', arguments: { environment: 'chem', code: 'print(1)' } },
};
const event = (headers: Record<string, unknown>) => ({ mcp: { gatewayRequest: { headers, body } } });
const bearer = (claims?: Record<string, unknown>) => event({ Authorization: `Bearer ${token(claims)}` });

const discoveryFetch = jest.fn();
let jwksFetch: jest.SpyInstance;

/** Loads a fresh copy of the handler (and its verifier cache) with the given JWT settings. */
function loadHandler(settings: { clients?: string[]; audiences?: string[]; scopes?: string[] } = {}): Handler {
  process.env.JWT_DISCOVERY_URL = DISCOVERY_URL;
  process.env.JWT_ALLOWED_CLIENTS = JSON.stringify(settings.clients ?? ['quick-client']);
  process.env.JWT_ALLOWED_AUDIENCES = JSON.stringify(settings.audiences ?? []);
  process.env.JWT_ALLOWED_SCOPES = JSON.stringify(settings.scopes ?? []);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SimpleFetcher } = require('aws-jwt-verify/https') as typeof import('aws-jwt-verify/https');
  jwksFetch = jest
    .spyOn(SimpleFetcher.prototype, 'fetch')
    .mockImplementation(async (uri: string) => {
      if (uri !== JWKS_URI) throw new Error(`unexpected fetch of ${uri}`);
      return new TextEncoder().encode(JSON.stringify(JWKS)).buffer as ArrayBuffer;
    });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../../lambda/caller-identity-interceptor/index') as typeof import('../../lambda/caller-identity-interceptor/index')).handler;
}

const discoveryResponse = (document: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 503, json: async () => document }) as unknown as Response;

const accepted = (sub: string) => ({
  interceptorOutputVersion: '1.0',
  mcp: { transformedGatewayRequest: { headers: { [CALLER_SUB_HEADER]: sub }, body } },
});

function expectRejected(out: unknown) {
  expect(out).toMatchObject({
    interceptorOutputVersion: '1.0',
    mcp: { transformedGatewayResponse: { statusCode: 200, body: { jsonrpc: '2.0', id: 7, error: { code: -32001 } } } },
  });
  expect(JSON.stringify(out)).not.toContain('transformedGatewayRequest');
}

const logged = () => (console.log as jest.Mock).mock.calls.flat().join('\n');

beforeEach(() => {
  discoveryFetch.mockReset();
  discoveryFetch.mockResolvedValue(discoveryResponse({ issuer: ISSUER, jwks_uri: JWKS_URI }));
  global.fetch = discoveryFetch as unknown as typeof fetch;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('caller-identity interceptor', () => {
  test('accepts a valid token and passes on its sub with the body unchanged', async () => {
    const handler = loadHandler({ scopes: ['sandbox/invoke'] });
    expect(await handler(bearer())).toEqual(accepted('user-123'));
    // The discovery document and JWKS are fetched once and reused by warm invocations.
    expect(await handler(bearer({ sub: 'user-456' }))).toEqual(accepted('user-456'));
    expect(discoveryFetch).toHaveBeenCalledTimes(1);
    expect(discoveryFetch).toHaveBeenCalledWith(DISCOVERY_URL, expect.anything());
    expect(jwksFetch).toHaveBeenCalledTimes(1);
  });

  test('overwrites a caller header the client sent with the verified sub', async () => {
    const handler = loadHandler();
    const out = await handler(event({ authorization: `Bearer ${token()}`, [CALLER_SUB_HEADER]: 'someone-else' }));
    expect(out).toEqual(accepted('user-123'));
  });

  test('rejects a request without a bearer token', async () => {
    const handler = loadHandler();
    expectRejected(await handler(event({})));
    expectRejected(await handler(event({ Authorization: 'Basic abc' })));
    expect(discoveryFetch).not.toHaveBeenCalled();
  });

  test('rejects a token from another issuer', async () => {
    const handler = loadHandler();
    expectRejected(await handler(bearer({ iss: 'https://other.example.com' })));
    expect(logged()).toContain('ISSUER_NOT_ALLOWED');
  });

  test('rejects a token issued to a client that is not allowed', async () => {
    const handler = loadHandler();
    expectRejected(await handler(bearer({ client_id: 'other-client' })));
    expectRejected(await handler(bearer({ client_id: undefined })));
    expect(logged()).toContain('CLIENT_NOT_ALLOWED');
  });

  test('checks the audience when audiences are allowed, and skips it otherwise', async () => {
    const withAudience = loadHandler({ clients: [], audiences: ['api://sandbox'] });
    expect(await withAudience(bearer({ aud: 'api://sandbox', client_id: undefined }))).toEqual(accepted('user-123'));
    expectRejected(await withAudience(bearer({ aud: 'api://other' })));
    expectRejected(await withAudience(bearer({ aud: undefined })));
    expect(logged()).toContain('AUDIENCE_NOT_ALLOWED');

    const withoutAudience = loadHandler({ clients: ['quick-client'] });
    expect(await withoutAudience(bearer({ aud: 'anything' }))).toEqual(accepted('user-123'));
  });

  test('requires one of the allowed scopes when scopes are set', async () => {
    const handler = loadHandler({ scopes: ['sandbox/invoke', 'admin'] });
    expect(await handler(bearer({ scope: 'admin' }))).toEqual(accepted('user-123'));
    expectRejected(await handler(bearer({ scope: 'openid profile' })));
    expectRejected(await handler(bearer({ scope: undefined })));
  });

  test('reads scopes from an scp claim as Okta and Entra ID issue them', async () => {
    const handler = loadHandler({ scopes: ['sandbox/invoke'] });
    expect(await handler(bearer({ scope: undefined, scp: ['openid', 'sandbox/invoke'] }))).toEqual(accepted('user-123'));
    expect(await handler(bearer({ scope: undefined, scp: 'sandbox/invoke' }))).toEqual(accepted('user-123'));
    expectRejected(await handler(bearer({ scope: undefined, scp: ['openid'] })));
    expect(logged()).toContain('SCOPE_NOT_ALLOWED');
  });

  test('rejects an expired token', async () => {
    const handler = loadHandler();
    expectRejected(await handler(bearer({ iat: now() - 7200, exp: now() - 3600 })));
    expect(logged()).toContain('EXPIRED_OR_NOT_YET_VALID');
  });

  test('rejects a token signed with another key', async () => {
    const handler = loadHandler();
    const [header, payload] = token().split('.');
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), other).toString('base64url')}`;
    expectRejected(await handler(event({ Authorization: `Bearer ${forged}` })));
    expect(logged()).toContain('INVALID_SIGNATURE');
  });

  test('rejects a token without a usable sub', async () => {
    const handler = loadHandler();
    expect(JSON.stringify(await handler(bearer({ sub: 'has space' })))).toContain('no usable subject');
    expect(JSON.stringify(await handler(bearer({ sub: undefined })))).toContain('no usable subject');
  });

  test('fails closed while the discovery document is unavailable, and recovers on a later call', async () => {
    const handler = loadHandler();
    discoveryFetch.mockRejectedValueOnce(new Error('network down'));
    expectRejected(await handler(bearer()));
    discoveryFetch.mockResolvedValueOnce(discoveryResponse({}, false));
    expectRejected(await handler(bearer()));
    discoveryFetch.mockResolvedValueOnce(discoveryResponse({ issuer: ISSUER, jwks_uri: 'http://idp.example.com/jwks' }));
    expectRejected(await handler(bearer()));
    expect(await handler(bearer())).toEqual(accepted('user-123'));
    expect(discoveryFetch).toHaveBeenCalledTimes(4);
  });

  test('rejects every request when neither clients nor audiences are allowed', async () => {
    const handler = loadHandler({ clients: [], audiences: [], scopes: ['openid'] });
    expectRejected(await handler(bearer()));
    expect(discoveryFetch).not.toHaveBeenCalled();
    expect(logged()).toContain('CONFIGURATION');
  });

  test('never logs tokens, subjects or the request body', async () => {
    const handler = loadHandler();
    const secretToken = token({ sub: 'secret-user' });
    await handler(event({ Authorization: `Bearer ${secretToken}` }));
    await handler(bearer({ sub: 'secret-user', client_id: 'other-client' }));
    await handler(event({ Authorization: 'Bearer secret-garbage' }));
    const output = logged();
    expect(output).not.toContain('secret-');
    expect(output).not.toContain(secretToken.split('.')[1]);
    expect(output).not.toContain('print(1)');
  });
});
