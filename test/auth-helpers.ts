import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { parseConfiguration } from '../src/config.js';

export async function provider(t: TestContext) {
  const requests: { token: string | null; authorization?: string; contentType?: string }[] = [];
  let responder = (response: ServerResponse, token: string | null) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(token === 'valid-token' ? active() : { active: false }));
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const token = new URLSearchParams(Buffer.concat(chunks).toString()).get('token');
    requests.push({ token, authorization: request.headers.authorization, contentType: request.headers['content-type'] });
    responder(response, token);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  const base = `http://127.0.0.1:${address.port}`;
  const resource = 'https://skills.example.org/mcp';
  function active(overrides: Record<string, unknown> = {}) {
    return { active: true, iss: base, aud: resource, sub: 'employee', scope: 'skills:read', exp: Math.floor(Date.now() / 1000) + 600, ...overrides };
  }
  const config = parseConfiguration({ authentication: {
    enabled: true, resourceUrl: resource, issuerUrl: base, loginUrl: `${base}/login`, validationUrl: `${base}/introspect`, scopes: ['skills:read'],
  } }).authentication;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { config, requests, active, base, respond: (callback: typeof responder) => { responder = callback; } };
}
