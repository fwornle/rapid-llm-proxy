/**
 * A fake for every upstream the daemon talks to, reached the way the real ones
 * are: the daemon is started with HTTPS_PROXY pointing here, so its hard-coded
 * `https://api.anthropic.com…` / `https://api.openai.com…` URLs arrive as CONNECT
 * tunnels. Each tunnel is TLS-terminated with a throwaway CA (trusted by the
 * daemon via NODE_EXTRA_CA_CERTS) and answered by `respond` — nothing leaves the
 * machine.
 *
 * The CA is generated per run with the openssl CLI, so no key material lives in
 * the repo and no cert dependency is added.
 *
 *   const up = await startFakeUpstream({ dir, respond });
 *   up.proxyUrl   → HTTPS_PROXY for the daemon
 *   up.caPath     → NODE_EXTRA_CA_CERTS for the daemon
 *   up.requests   → every request seen: { host, method, path, headers, body }
 *
 * `respond({ host, method, path, headers, body })` returns
 *   { status = 200, headers = {}, body }   — body: string | object (JSON) |
 *   { status, headers, chunks: [string] }  — written one chunk at a time (SSE)
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOSTS = ['api.anthropic.com', 'api.openai.com', 'api.groq.com', 'api.github.com', 'api.githubcopilot.com', 'localhost'];

function makeCerts(dir) {
  const p = (f) => path.join(dir, f);
  const ssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('ca.key'), '-out', p('ca.pem'), '-days', '2',
    '-subj', '/CN=rapid-llm-proxy test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('leaf.key'), '-out', p('leaf.csr'), '-subj', '/CN=fake-upstream');
  fs.writeFileSync(p('leaf.ext'), [
    'basicConstraints=CA:FALSE',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`,
  ].join('\n'));
  ssl('x509', '-req', '-in', p('leaf.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial',
    '-out', p('leaf.pem'), '-days', '2', '-extfile', p('leaf.ext'));
  return { caPath: p('ca.pem'), key: fs.readFileSync(p('leaf.key')), cert: fs.readFileSync(p('leaf.pem')) };
}

export async function startFakeUpstream({ dir, respond }) {
  fs.mkdirSync(dir, { recursive: true });
  const { caPath, key, cert } = makeCerts(dir);
  const requests = [];

  const handle = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const seen = {
        host: (req.headers.host || '').split(':')[0],
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(seen);
      let out;
      try { out = await respond(seen); } catch (err) { out = { status: 500, body: { error: String(err?.message || err) } }; }
      out = out || { status: 404, body: { error: `fake upstream: no response for ${seen.host}${seen.path}` } };
      const headers = { ...(out.headers || {}) };
      if (out.chunks) {
        res.writeHead(out.status || 200, { 'content-type': 'text/event-stream', ...headers });
        for (const c of out.chunks) res.write(c);
        res.end();
        return;
      }
      const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...headers });
      res.end(text);
    });
  };

  // Never listens: tunnelled sockets are handed to it, and it does the TLS handshake.
  const tlsServer = https.createServer({ key, cert }, handle);
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });
  const sockets = new Set();
  proxy.on('connect', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tlsServer.emit('connection', socket);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

  return {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    caPath,
    requests,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      proxy.close(() => resolve());
    }),
  };
}
