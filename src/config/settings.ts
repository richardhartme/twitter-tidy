import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_INACTIVITY_MS } from '../cache/index.js';

/** User settings from `config.json`, resolved to the units the app works in. */
export interface Settings {
  /** No post within this long counts as inactive. */
  inactiveAfterMs: number;
}

/** A config file that can't be read as valid settings. */
export class SettingsError extends Error {
  override name = 'SettingsError';
}

export const defaultSettingsPath = () => join(homedir(), '.config', 'twittertidy', 'config.json');

/** The one place months become milliseconds: in proportion to the 12-month default. */
const monthsToMs = (months: number) => (months / 12) * DEFAULT_INACTIVITY_MS;

/**
 * Parses the config file's text, or `null` for a missing file. Missing keys take their defaults;
 * an invalid value throws a `SettingsError` naming the file (`source`), the key and the value.
 */
export function parseSettings(text: string | null, source = 'config.json'): Settings {
  if (text === null) return { inactiveAfterMs: DEFAULT_INACTIVITY_MS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SettingsError(`${source} must contain a JSON object, like { "inactiveMonths": 12 }.`);
  }
  if (!('inactiveMonths' in raw)) return { inactiveAfterMs: DEFAULT_INACTIVITY_MS };
  const months = (raw as { inactiveMonths: unknown }).inactiveMonths;
  if (typeof months !== 'number' || !Number.isFinite(months) || months <= 0) {
    throw new SettingsError(`${source}: inactiveMonths must be a positive number of months, got ${JSON.stringify(months)}.`);
  }
  return { inactiveAfterMs: monthsToMs(months) };
}

/** Reads and parses the config file; a missing file means every default. */
export function loadSettings(path = defaultSettingsPath()): Settings {
  let text: string | null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SettingsError(`Couldn't read ${path}: ${(err as Error).message}`);
    }
    text = null;
  }
  return parseSettings(text, path);
}
