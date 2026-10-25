import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createXClient } from '../../src/auth/client.js';
import { loadConfig, type Config } from '../../src/auth/config.js';
import { AuthError, ConfigError } from '../../src/auth/errors.js';
import { login } from '../../src/auth/login.js';
import { buildAuthorizeUrl, challengeFor, generateVerifier } from '../../src/auth/pkce.js';
import { exchangeCode } from '../../src/auth/token-request.js';
import { TokenStore, type Tokens } from '../../src/auth/token-store.js';

const config: Config = { clientId: 'cid', port: 18765, redirectUri: 'http://127.0.0.1:18765/callback' };
const tokens: Tokens = { accessToken: 'old', refreshToken: 'r1', expiresAt: 0, userId: '1', handle: 'me' };
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
const grantBody = { access_token: 'new', refresh_token: 'r2', expires_in: 7200 };

describe('loadConfig', () => {
  test('requires X_CLIENT_ID with an actionable message', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/X_CLIENT_ID/);
  });
  test('secret is optional; port defaults to 8765 and is configurable', () => {
    expect(loadConfig({ X_CLIENT_ID: 'a' })).toMatchObject({ port: 8765, clientSecret: undefined, redirectUri: 'http://127.0.0.1:8765/callback' });
    expect(loadConfig({ X_CLIENT_ID: 'a', X_CLIENT_SECRET: 's', TWITTERTIDY_PORT: '9000' })).toMatchObject({ port: 9000, clientSecret: 's' });
    expect(() => loadConfig({ X_CLIENT_ID: 'a', TWITTERTIDY_PORT: 'x' })).toThrow(ConfigError);
  });
});

describe('PKCE', () => {
  test('S256 challenge matches the RFC 7636 example', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  test('verifier is random and URL-safe', () => {
    const v = generateVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateVerifier()).not.toBe(v);
  });
  test('authorize URL has exactly the four scopes, S256 and state', () => {
    const u = new URL(buildAuthorizeUrl(config, 'chal', 'st'));
    expect(u.searchParams.get('scope')).toBe('tweet.read users.read follows.read offline.access');
    expect(u.searchParams.get('code_challenge')).toBe('chal');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('redirect_uri')).toBe(config.redirectUri);
  });
});

describe('token requests', () => {
  const deps = (f: typeof fetch) => ({ fetch: f, now: () => 1000 });
  test('public client sends client_id and no Authorization header', async () => {
    const f = vi.fn(async () => json(grantBody));
    const grant = await exchangeCode(config, deps(f as never), 'code', 'ver');
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('code_verifier')).toBe('ver');
    expect(grant).toEqual({ accessToken: 'new', refreshToken: 'r2', expiresAt: 1000 + 7200_000 });
  });
  test('confidential client uses HTTP Basic', async () => {
    const f = vi.fn(async () => json(grantBody));
    await exchangeCode({ ...config, clientSecret: 'sec' }, deps(f as never), 'c', 'v');
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
  });
});

describe('TokenStore', () => {
  test('round-trips and writes the file with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tt-'));
    const store = new TokenStore(join(dir, 'sub', 'tokens.json'));
    expect(await store.load()).toBeNull();
    await store.save(tokens);
    expect(await store.load()).toEqual(tokens);
    expect((await stat(join(dir, 'sub', 'tokens.json'))).mode & 0o777).toBe(0o600);
  });
  test('treats a corrupt file as logged out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tt-'));
    await writeFile(join(dir, 't.json'), '{nope');
    expect(await new TokenStore(join(dir, 't.json')).load()).toBeNull();
  });
});

describe('login', () => {
  const run = (callback: (authorizeUrl: string) => Promise<void>) => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2/token') ? json(grantBody) : json({ data: { id: '42', username: 'rich' } }),
    );
    const promise = login(config, {
      fetch: f as never,
      now: () => 0,
      log: () => {},
      openBrowser: (url) => void callback(url),
    });
    return { promise, f };
  };

  test('completes the flow and confirms with /2/users/me', async () => {
    const { promise, f } = run(async (url) => {
      const state = new URL(url).searchParams.get('state')!;
      await fetch(`${config.redirectUri}?code=abc&state=${state}`);
    });
    expect(await promise).toMatchObject({ accessToken: 'new', userId: '42', handle: 'rich' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  test('rejects a callback with a mismatched state', async () => {
    const { promise, f } = run(async () => {
      await fetch(`${config.redirectUri}?code=abc&state=wrong`);
    });
    await expect(promise).rejects.toThrow(/state/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('createXClient', () => {
  const setup = (responses: Response[], overrides: { now?: () => number } = {}) => {
    const queue = [...responses];
    const calls: { url: string; auth: string | null }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('oauth2/token')) return queue.shift()!;
      calls.push({ url: u, auth: new Headers(init?.headers).get('Authorization') });
      return queue.shift()!;
    });
    const store = { save: vi.fn(async () => {}) } as unknown as TokenStore;
    const sleep = vi.fn(async () => {});
    const client = createXClient({ config, store, tokens, fetch: f as never, now: overrides.now ?? (() => 1_000_000), sleep });
    return { client, calls, store, sleep, f };
  };

  test('a 401 triggers exactly one refresh and one retry with the new token', async () => {
    const { client, calls, store } = setup([new Response(null, { status: 401 }), json(grantBody), json({ ok: 1 })]);
    const res = await client.fetch('/2/users/me');
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer old', 'Bearer new']);
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new', refreshToken: 'r2' }));
  });

  test('a failed refresh asks the user to log in again', async () => {
    const { client } = setup([new Response(null, { status: 401 }), new Response('bad', { status: 400 })]);
    await expect(client.fetch('/2/users/me')).rejects.toThrow(AuthError);
    await expect(setup([new Response(null, { status: 401 }), new Response('bad', { status: 400 })]).client.fetch('/x')).rejects.toThrow(/log in again/);
  });

  test('a second 401 after refreshing is returned, not looped', async () => {
    const { client, calls } = setup([new Response(null, { status: 401 }), json(grantBody), new Response(null, { status: 401 })]);
    expect((await client.fetch('/x')).status).toBe(401);
    expect(calls).toHaveLength(2);
  });

  test('a 429 waits until the reset time, then retries', async () => {
    const reset = String(1_000_000 / 1000 + 30);
    const { client, sleep } = setup([new Response(null, { status: 429, headers: { 'x-rate-limit-reset': reset } }), json({ ok: 1 })]);
    expect((await client.fetch('/x')).status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(31_000);
  });

  const limited = () => new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(1_000_000 / 1000 + 60) } });

  test('by default a 429 is returned after 3 waits', async () => {
    const { client, sleep } = setup([limited(), limited(), limited(), limited(), json({ ok: 1 })]);
    expect((await client.fetch('/x')).status).toBe(429);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  test('a caller can wait out any number of 429s and is told each reset time', async () => {
    const { client, sleep } = setup([limited(), limited(), limited(), limited(), limited(), json({ ok: 1 })]);
    const onRateLimit = vi.fn();
    const res = await client.fetch('/x', undefined, { maxRateLimitWaits: Infinity, onRateLimit });
    expect(res.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(onRateLimit).toHaveBeenCalledTimes(5);
    expect(onRateLimit).toHaveBeenCalledWith(1_060_000);
  });

  test('beforeRetry is awaited before each retry, after a 429 or a refresh', async () => {
    const { client, calls } = setup([limited(), new Response(null, { status: 401 }), json(grantBody), json({ ok: 1 })]);
    const seen: number[] = [];
    const beforeRetry = vi.fn(async () => {
      seen.push(calls.length);
    });
    expect((await client.fetch('/x', undefined, { beforeRetry })).status).toBe(200);
    expect(seen).toEqual([1, 2]);
  });
});
