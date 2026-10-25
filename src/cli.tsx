#!/usr/bin/env node
import { render } from 'ink';
import { App } from './app.js';
import { AuthError, ConfigError, connect, loadConfig, type XClient } from './auth/index.js';
import { openCache } from './cache/index.js';
import { loadSettings, SettingsError, type Settings } from './config/index.js';

let settings: Settings;
let client: XClient;
try {
  settings = loadSettings();
  client = await connect(loadConfig());
} catch (err) {
  if (err instanceof SettingsError || err instanceof ConfigError || err instanceof AuthError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const cache = openCache();
try {
  const instance = render(<App client={client} cache={cache} userId={client.tokens.userId} inactiveAfterMs={settings.inactiveAfterMs} />);
  await instance.waitUntilExit();
} finally {
  cache.close();
}
