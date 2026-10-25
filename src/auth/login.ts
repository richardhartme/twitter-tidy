import { createServer } from 'node:http';
import type { Config } from './config.js';
import { AuthError } from './errors.js';
import { buildAuthorizeUrl, challengeFor, generateState, generateVerifier } from './pkce.js';
import { exchangeCode } from './token-request.js';
import type { Tokens } from './token-store.js';

export interface LoginDeps {
  fetch: typeof fetch;
  now: () => number;
  openBrowser: (url: string) => void | Promise<void>;
  log: (message: string) => void;
  timeoutMs?: number;
}

const ME_URL = 'https://api.x.com/2/users/me';

/** Interactive OAuth 2.0 PKCE login. Resolves with fresh tokens once the user approves. */
export async function login(config: Config, deps: LoginDeps): Promise<Tokens> {
  const verifier = generateVerifier();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(config, challengeFor(verifier), state);

  const code = await waitForCode(config, deps, authorizeUrl, state);

  const grant = await exchangeCode(config, deps, code, verifier);

  // One call to confirm the login worked and learn who we are.
  const res = await deps.fetch(ME_URL, { headers: { Authorization: `Bearer ${grant.accessToken}` } });
  if (!res.ok) throw new AuthError(`Login succeeded but GET /2/users/me returned ${res.status}.`);
  const me = ((await res.json()) as { data: { id: string; username: string } }).data;

  return { ...grant, userId: me.id, handle: me.username };
}

function waitForCode(config: Config, deps: LoginDeps, authorizeUrl: string, state: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', config.redirectUri);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const respond = (status: number, text: string) => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
      };
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state) {
        respond(400, 'State mismatch. Login rejected.');
        finish(new AuthError('Login rejected: the callback state did not match.'));
      } else if (error || !code) {
        respond(400, `Login failed: ${error ?? 'no code returned'}.`);
        finish(new AuthError(`X login failed: ${error ?? 'no authorization code returned'}.`));
      } else {
        respond(200, 'Logged in. You can close this tab and return to the terminal.');
        finish(undefined, code);
      }
    });

    const timer = setTimeout(
      () => finish(new AuthError('Timed out waiting for the browser login.')),
      deps.timeoutMs ?? 5 * 60_000,
    );

    function finish(err?: Error, code?: string) {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(code as string);
    }

    server.once('error', (err: NodeJS.ErrnoException) => {
      finish(
        err.code === 'EADDRINUSE'
          ? new AuthError(`Port ${config.port} is in use. Set TWITTERTIDY_PORT and register the new redirect URI.`)
          : err,
      );
    });

    server.listen(config.port, '127.0.0.1', () => {
      deps.log(`Register this redirect URI in your X app if you haven't: ${config.redirectUri}`);
      deps.log(`Opening your browser to log in. If nothing opens, visit:\n${authorizeUrl}`);
      void Promise.resolve(deps.openBrowser(authorizeUrl)).catch(() => {});
    });
  });
}
