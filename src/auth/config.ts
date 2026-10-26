import { ConfigError } from './errors.js';

export interface Config {
  clientId: string;
  /** Present for confidential clients; absent for public clients. */
  clientSecret?: string;
  port: number;
  redirectUri: string;
}

export const SCOPES = ['tweet.read', 'users.read', 'follows.read', 'follows.write', 'offline.access'] as const;

const DEFAULT_PORT = 8765;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = env.X_CLIENT_ID?.trim();
  if (!clientId) {
    throw new ConfigError(
      'X_CLIENT_ID is not set. Set it to the OAuth 2.0 Client ID of your X developer app ' +
        '(and X_CLIENT_SECRET too if the app is a confidential client).',
    );
  }

  const rawPort = env.TWITTERTIDY_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`TWITTERTIDY_PORT must be an integer from 1 to 65535, got "${rawPort}".`);
  }

  const clientSecret = env.X_CLIENT_SECRET?.trim() || undefined;
  return { clientId, clientSecret, port, redirectUri: `http://127.0.0.1:${port}/callback` };
}
