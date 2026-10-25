import { describe, expect, test } from 'vitest';
import { profileUrl } from '../src/browser.js';

describe('profileUrl', () => {
  test('points at the account on x.com', () => {
    expect(profileUrl('jack')).toBe('https://x.com/jack');
  });

  test('escapes anything unexpected in the handle', () => {
    expect(profileUrl('a/b?c')).toBe('https://x.com/a%2Fb%3Fc');
  });
});
