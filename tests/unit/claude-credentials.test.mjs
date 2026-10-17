/**
 * proxy-bridge/claude-credentials.mjs — the claude CLI's login, per platform.
 * Keychain and file reads are injected; every platform is asserted on every host.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readClaudeCredentials, credentialsFilePath, parseClaudeCredentials } from '../../proxy-bridge/claude-credentials.mjs';

const blob = (t) => JSON.stringify({ claudeAiOauth: { accessToken: t, expiresAt: 1_900_000_000_000, refreshToken: 'r', subscriptionType: 'max' } });
const enoent = () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };

describe('readClaudeCredentials', () => {
  it('macOS: the keychain', () => {
    const got = readClaudeCredentials({ platform: 'darwin', readKeychain: () => `${blob('kc')}\n`, readFile: () => assert.fail('file not read') });
    assert.equal(got.accessToken, 'kc');
    assert.equal(got.expiresAt, 1_900_000_000_000);
    assert.equal(got.subscriptionType, 'max');
  });

  it('macOS without a keychain entry: the credentials file', () => {
    const got = readClaudeCredentials({ platform: 'darwin', readKeychain: () => { throw new Error('could not be found'); }, readFile: () => blob('file') });
    assert.equal(got.accessToken, 'file');
  });

  it('Linux / WSL: ~/.claude/.credentials.json, never the keychain', () => {
    let read = null;
    const got = readClaudeCredentials({
      platform: 'linux', home: '/home/u', env: {},
      readKeychain: () => assert.fail('no keychain off macOS'),
      readFile: (f) => { read = f; return blob('linux'); },
    });
    assert.equal(read, '/home/u/.claude/.credentials.json');
    assert.equal(got.accessToken, 'linux');
  });

  it('CLAUDE_CONFIG_DIR moves the file', () => {
    assert.equal(credentialsFilePath({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/home/u' }), '/cfg/.credentials.json');
  });

  it('no login anywhere: null, and only a non-macOS miss is logged', () => {
    const logged = [];
    assert.equal(readClaudeCredentials({ platform: 'linux', env: {}, home: '/h', readFile: enoent, log: (m) => logged.push(m) }), null);
    assert.equal(logged.length, 1);
    logged.length = 0;
    assert.equal(readClaudeCredentials({ platform: 'darwin', env: {}, home: '/h', readKeychain: () => '', readFile: enoent, log: (m) => logged.push(m) }), null);
    assert.equal(logged.length, 0, 'no file is the normal state on macOS');
  });

  it('a blob without a token or expiry is no login', () => {
    assert.equal(parseClaudeCredentials('{"claudeAiOauth":{"accessToken":"x"}}'), null);
    assert.equal(parseClaudeCredentials('not json'), null);
  });
});
