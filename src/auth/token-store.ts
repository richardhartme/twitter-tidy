import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId: string;
  handle: string;
  /** The scopes X granted; absent in logins saved before they were recorded. */
  scopes?: string[];
}

export const defaultTokenPath = () => join(homedir(), '.config', 'twittertidy', 'tokens.json');

export class TokenStore {
  constructor(private readonly path: string = defaultTokenPath()) {}

  async load(): Promise<Tokens | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as Tokens;
    } catch {
      return null; // corrupt file: treat as logged out
    }
  }

  async save(tokens: Tokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
