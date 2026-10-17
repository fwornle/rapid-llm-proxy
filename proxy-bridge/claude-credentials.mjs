// proxy-bridge/claude-credentials.mjs
//
// Where the `claude` CLI keeps its Max OAuth login, per platform.
//
//   macOS        the login keychain, generic password "Claude Code-credentials"
//   Linux / WSL  ${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json (mode 0600)
//
// Both hold the same JSON: { claudeAiOauth: { accessToken, expiresAt, ... } }.
// Reading only the keychain made the direct-API fast path macOS-only: on Linux
// and WSL every background claude call fell through to the CLI subprocess
// (~7.5 s and ~22K injected prompt tokens instead of ~0.9 s). The file is also
// tried on macOS when the keychain has no entry — a CLI configured with
// CLAUDE_CONFIG_DIR, or one that could not reach the keychain, writes it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** The credentials file the CLI writes off macOS. */
export function credentialsFilePath({ env = process.env, home = os.homedir() } = {}) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json');
}

/** { accessToken, expiresAt, refreshToken, subscriptionType } from the stored JSON, or null. */
export function parseClaudeCredentials(text) {
  let parsed;
  try { parsed = JSON.parse(String(text).trim()); } catch { return null; }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken || !oauth?.expiresAt) return null;
  return {
    accessToken: oauth.accessToken,
    expiresAt: Number(oauth.expiresAt),
    refreshToken: oauth.refreshToken || null,
    subscriptionType: oauth.subscriptionType || null,
  };
}

/**
 * Read the current login. Never throws; null when there is none.
 * @param {object} [o]
 * @param {string} [o.platform]
 * @param {(cmd: string) => string} [o.readKeychain]  injectable for tests
 * @param {(file: string) => string} [o.readFile]
 * @param {(msg: string) => void} [o.log]
 */
export function readClaudeCredentials({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  readKeychain = () => execSync(`security find-generic-password -s 'Claude Code-credentials' -w`, { encoding: 'utf8', timeout: 5_000 }),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  log = () => {},
} = {}) {
  if (platform === 'darwin') {
    try {
      const fromKeychain = parseClaudeCredentials(readKeychain());
      if (fromKeychain) return fromKeychain;
    } catch (err) {
      log(`claude-code: keychain read failed: ${(err.message || '').slice(0, 120)}`);
    }
  }
  const file = credentialsFilePath({ env, home });
  try {
    return parseClaudeCredentials(readFile(file));
  } catch (err) {
    // No file is the normal state on macOS; say so only where it is the source.
    if (platform !== 'darwin' || err.code !== 'ENOENT') {
      log(`claude-code: credentials read failed (${file}): ${(err.message || '').slice(0, 120)}`);
    }
    return null;
  }
}
