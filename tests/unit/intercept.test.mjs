/**
 * glass G3 / WP3 — intercept.mjs: TLS interception on an existing http.Server.
 * A listed host is decrypted with a leaf cert from the persistent CA (the client
 * verifies it against ca.pem) and handed to onRequest with the session binding
 * from Proxy-Authorization; any other host is a blind tunnel.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

import { attachIntercept, loadOrCreateCa, hostMatcher, bindingOf } from '../../proxy-bridge/intercept.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercept-'));
let server; let port; let handle; let plain; let plainPort;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => { res.writeHead(200); res.end('normal route'); });
  handle = attachIntercept(server, {
    caDir: dir,
    hosts: ['copilot-api.*.ghe.com', 'api.githubcopilot.com'],
    onRequest: async (req, res, ctx) => {
      let body = '';
      for await (const c of req) body += c;
      seen.push({ ...ctx, method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: ctx.host }));
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  plain = http.createServer((req, res) => { res.writeHead(200); res.end('tunnelled'); });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  plainPort = plain.address().port;
});

after(async () => {
  handle.close();
  await new Promise((r) => server.close(r));
  await new Promise((r) => plain.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function connect(target, auth) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'CONNECT', path: target,
      headers: auth ? { 'proxy-authorization': `Basic ${Buffer.from(auth).toString('base64')}` } : {},
    });
    req.once('connect', (res, socket) => (res.statusCode === 200 ? resolve(socket) : reject(new Error(String(res.statusCode)))));
    req.once('error', reject);
    req.end();
  });
}

function requestOver(socket, { host, secure, body }) {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ socket, servername: host, ca: fs.readFileSync(handle.caPath) }) : socket;
    const req = http.request({
      host, method: body ? 'POST' : 'GET', path: '/v1/messages?beta=true', createConnection: () => s,
      headers: { host, 'content-type': 'application/json' },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a listed host is decrypted with a CA-signed leaf and handed to onRequest with the binding', async () => {
  const sock = await connect('copilot-api.acme.ghe.com:443', 'glass:session-123');
  const r = await requestOver(sock, { host: 'copilot-api.acme.ghe.com', secure: true, body: '{"model":"m"}' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { ok: true, host: 'copilot-api.acme.ghe.com' });
  const last = seen.at(-1);
  assert.equal(last.binding, 'session-123');
  assert.equal(last.method, 'POST');
  assert.equal(last.url, '/v1/messages?beta=true');
  assert.equal(last.body, '{"model":"m"}');
});

test('an unlisted host is a blind tunnel, never decrypted', async () => {
  const before = seen.length;
  const sock = await connect(`127.0.0.1:${plainPort}`, 'glass:session-123');
  const r = await requestOver(sock, { host: '127.0.0.1', secure: false });
  assert.equal(r.text, 'tunnelled');
  assert.equal(seen.length, before);
});

test('normal routes on the same server are untouched', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(await res.text(), 'normal route');
});

test('the CA persists, and its key is private', () => {
  const again = loadOrCreateCa(dir);
  assert.equal(again.certPem, fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'ca.key')).mode & 0o777, 0o600);
});

test('two CAs of this module in one trust bundle: each leaf verifies against its own CA', async () => {
  // NODE_EXTRA_CA_CERTS may hold another of these CAs ahead of ours (glass bundles
  // the user's prior CA file with its own). OpenSSL 3.0 picks an issuer by name.
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercept-other-'));
  const other = loadOrCreateCa(otherDir);
  const ours = new X509Certificate(fs.readFileSync(handle.caPath));
  assert.notEqual(new X509Certificate(other.certPem).subject, ours.subject);
  const sock = await connect('api.githubcopilot.com:443', 'glass:s');
  const tlsSock = tls.connect({ socket: sock, servername: 'api.githubcopilot.com', ca: [other.certPem, fs.readFileSync(handle.caPath)] });
  await new Promise((resolve, reject) => { tlsSock.once('secureConnect', resolve); tlsSock.once('error', reject); });
  const leaf = tlsSock.getPeerX509Certificate();
  tlsSock.destroy();
  assert.equal(leaf.checkIssued(ours), true);
  fs.rmSync(otherDir, { recursive: true, force: true });
});

test('host patterns: * is one label; binding needs a password', () => {
  const m = hostMatcher(['copilot-api.*.ghe.com', 'api.githubcopilot.com']);
  assert.equal(m('copilot-api.acme.ghe.com'), true);
  assert.equal(m('copilot-api.a.b.ghe.com'), false);
  assert.equal(m('evil-copilot-api.acme.ghe.com'), false);
  assert.equal(m('api.githubcopilot.com'), true);
  assert.equal(bindingOf(`Basic ${Buffer.from('glass:tok').toString('base64')}`), 'tok');
  assert.equal(bindingOf('Bearer x'), '');
  assert.equal(bindingOf(undefined), '');
});

test('close() ends open tunnels, so server.close() does not wait on the agent', async () => {
  // A CONNECT socket is outside closeAllConnections(); left open, it held a
  // stopping daemon alive until the agent dropped the tunnel.
  const own = http.createServer();
  const h = attachIntercept(own, { caDir: dir, hosts: ['api.githubcopilot.com'], onRequest: (req, res) => res.end() });
  await new Promise((r) => own.listen(0, '127.0.0.1', r));
  const open = (target) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: own.address().port, method: 'CONNECT', path: target });
    req.once('connect', (res, socket) => resolve(socket));
    req.once('error', reject);
    req.end();
  });
  const blind = await open(`127.0.0.1:${plainPort}`);
  const decrypted = tls.connect({ socket: await open('api.githubcopilot.com:443'), servername: 'api.githubcopilot.com', ca: fs.readFileSync(h.caPath) });
  await new Promise((resolve, reject) => { decrypted.once('secureConnect', resolve); decrypted.once('error', reject); });
  const ended = Promise.all([blind, decrypted].map((s) => new Promise((r) => (s.destroyed ? r() : s.once('close', r)))));
  decrypted.on('error', () => {});

  h.close();
  own.closeAllConnections();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('server.close() still waiting on a tunnel')), 2000).unref());
  await Promise.race([new Promise((r) => own.close(r)), timeout]);
  await ended;
});

test('setUpstream(): tunnels opened afterwards take the new egress proxy, and its NO_PROXY', async () => {
  // glass adopts the proxy settings of the newest session's shell while the
  // daemon runs; before this, the proxy was fixed when the daemon started.
  const targets = [];
  const upstream = http.createServer();
  upstream.on('connect', (req, socket) => { targets.push(req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const own = http.createServer();
  const h = attachIntercept(own, { caDir: dir, hosts: ['api.githubcopilot.com'], onRequest: (req, res) => res.end() });
  await new Promise((r) => own.listen(0, '127.0.0.1', r));
  const status = (target) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: own.address().port, method: 'CONNECT', path: target });
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.once('error', reject);
    req.end();
  });
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  h.setUpstream({ upstreamProxy: upstreamUrl, noProxy: '' });
  assert.equal(await status('model.example.test:443'), 502);
  assert.deepEqual(targets, ['model.example.test:443'], 'the tunnel went to the proxy set at runtime');

  h.setUpstream({ upstreamProxy: upstreamUrl, noProxy: 'example.test' });
  await status('model.example.test:443');
  assert.equal(targets.length, 1, 'a NO_PROXY host bypasses it');

  h.setUpstream({ upstreamProxy: null });
  await status('other.example.test:443');
  assert.equal(targets.length, 1, 'no proxy: dialled directly');

  h.close();
  own.closeAllConnections();
  await new Promise((r) => own.close(r));
  await new Promise((r) => upstream.close(r));
});
