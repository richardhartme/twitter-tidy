import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_INACTIVITY_MS } from '../../src/cache/index.js';
import { loadSettings, parseSettings, SettingsError } from '../../src/config/index.js';

describe('parseSettings', () => {
  test('a missing file means the 12-month default', () => {
    expect(parseSettings(null)).toEqual({ inactiveAfterMs: DEFAULT_INACTIVITY_MS });
  });

  test('a missing key means the default', () => {
    expect(parseSettings('{}')).toEqual({ inactiveAfterMs: DEFAULT_INACTIVITY_MS });
  });

  test('12 months is the default threshold exactly', () => {
    expect(parseSettings('{ "inactiveMonths": 12 }').inactiveAfterMs).toBe(DEFAULT_INACTIVITY_MS);
  });

  test('converts months to milliseconds in proportion to the 12-month default', () => {
    expect(parseSettings('{ "inactiveMonths": 6 }').inactiveAfterMs).toBe(DEFAULT_INACTIVITY_MS / 2);
    expect(parseSettings('{ "inactiveMonths": 24 }').inactiveAfterMs).toBe(DEFAULT_INACTIVITY_MS * 2);
  });

  test.each([
    ['not JSON', '{ inactiveMonths: 12'],
    ['a non-object', '[12]'],
    ['a string', '{ "inactiveMonths": "12" }'],
    ['zero', '{ "inactiveMonths": 0 }'],
    ['a negative number', '{ "inactiveMonths": -3 }'],
    ['null', '{ "inactiveMonths": null }'],
  ])('rejects %s with a clear error', (_, text) => {
    expect(() => parseSettings(text)).toThrow(SettingsError);
    expect(() => parseSettings(text, '/x/config.json')).toThrow(/\/x\/config\.json/);
  });

  test('names the key and the bad value', () => {
    expect(() => parseSettings('{ "inactiveMonths": -3 }')).toThrow(/inactiveMonths.*positive number.*-3/);
  });
});

describe('loadSettings', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const tempDir = () => (dir = mkdtempSync(join(tmpdir(), 'twittertidy-settings-')));

  test('reads the threshold from the file', () => {
    const path = join(tempDir(), 'config.json');
    writeFileSync(path, '{ "inactiveMonths": 6 }');
    expect(loadSettings(path)).toEqual({ inactiveAfterMs: DEFAULT_INACTIVITY_MS / 2 });
  });

  test('uses the default when the file does not exist', () => {
    expect(loadSettings(join(tempDir(), 'missing.json'))).toEqual({ inactiveAfterMs: DEFAULT_INACTIVITY_MS });
  });

  test('reports an invalid file with its path', () => {
    const path = join(tempDir(), 'config.json');
    writeFileSync(path, '{ "inactiveMonths": "soon" }');
    expect(() => loadSettings(path)).toThrow(new RegExp(path));
  });
});
