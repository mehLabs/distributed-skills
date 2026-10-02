import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { SkillCatalog } from './catalog.js';
import { createServer } from './server.js';
import { Authentication, AuthenticationError, bearerToken, type PublicAuthInfo } from './auth.js';

export interface HttpOptions {
  allowedHosts?: string[];
  allowedOrigins?: string[];
  token?: string;
  authentication?: Authentication;
}

function publicDiscovery(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const rpc = body as { jsonrpc?: unknown; method?: unknown; params?: { name?: unknown; uri?: unknown } };
  if (rpc.jsonrpc !== '2.0') return false;
  if (['initialize', 'notifications/initialized', 'ping', 'server/discover', 'tools/list', 'resources/list', 'resources/templates/list'].includes(String(rpc.method))) return true;
  return (rpc.method === 'tools/call' && rpc.params?.name === 'get_auth_info') ||
    (rpc.method === 'resources/read' && rpc.params?.uri === 'skill://auth/info');
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

export function createHttpService(catalog: SkillCatalog, options: HttpOptions = {}) {
  if (options.authentication && options.token) throw new Error('Configure either external authentication or a shared token, not both.');
  const authentication = options.authentication;
  const info: PublicAuthInfo = authentication?.info() ?? (options.token ? {
    enabled: true, mode: 'shared-token',
    credential: { type: 'bearer', header: 'Authorization', scheme: 'Bearer' },
    instructions: 'Configure the shared bearer token in the MCP client. Do not send it in chat.',
  } : { enabled: false });
  const handler = createMcpHandler(({ authInfo }) => createServer(catalog, {
    authInfo: info,
    authorize: info.enabled ? async () => {
      if (!authInfo) throw new AuthenticationError(401, 'authentication_required', 'Sign in to access shared skills.');
    } : undefined,
  }));
  const handle = toNodeHandler(handler, { maxRequestBodySize: 64 * 1024 });
  const validateHost = hostHeaderValidation(options.allowedHosts ?? ['localhost', '127.0.0.1', '[::1]']);
  const validateOrigin = originValidation(options.allowedOrigins ?? []);
  const tokenHash = options.token ? createHash('sha256').update(`Bearer ${options.token}`).digest() : undefined;

  const reject = (response: ServerResponse, error: AuthenticationError) => json(response, error.status, {
    error: error.code, message: error.message, authentication: info,
  }, error.status === 503 ? { 'retry-after': '5' } : { 'www-authenticate': authentication?.challenge(error) ?? 'Bearer' });

  async function serve(request: IncomingMessage & { auth?: AuthInfo }, response: ServerResponse) {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const pathname = request.url?.split('?')[0];
    if (pathname === '/health' && request.method === 'GET') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (pathname === '/auth' && request.method === 'GET') {
      json(response, 200, info);
      return;
    }
    if (authentication?.config.enabled && request.method === 'GET' &&
        (pathname === authentication.metadataPath() || pathname === '/.well-known/oauth-protected-resource')) {
      json(response, 200, authentication.metadata());
      return;
    }
    if (pathname !== '/mcp') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    if (tokenHash) {
      const received = createHash('sha256').update(request.headers.authorization ?? '').digest();
      if (!timingSafeEqual(tokenHash, received)) {
        reject(response, new AuthenticationError(401, 'authentication_required', 'A shared bearer token is required.'));
        return;
      }
      request.auth = { token: options.token!, clientId: 'shared-token', scopes: [] };
    }

    let parsedBody: unknown;
    if (authentication?.config.enabled) {
      if (request.method === 'POST') {
        try {
          const webRequest = await toWebRequest(request, undefined, { maxRequestBodySize: 64 * 1024 });
          parsedBody = await webRequest.json();
        } catch (error) {
          const tooLarge = error instanceof Error && error.name === 'RequestBodyTooLargeError';
          json(response, tooLarge ? 413 : 400, { error: tooLarge ? 'request_too_large' : 'invalid_json' });
          return;
        }
      }
      if (!publicDiscovery(parsedBody)) {
        const token = bearerToken(request.headers.authorization);
        try {
          const principal = await authentication.verify(token);
          request.auth = { token: token!, clientId: principal?.subject ?? 'authenticated-client', scopes: principal!.scopes,
            expiresAt: principal!.expiresAt, resource: new URL(authentication.config.resourceUrl) };
        } catch (error) {
          if (error instanceof AuthenticationError) { reject(response, error); return; }
          throw error;
        }
      }
    }
    await handle(request, response, parsedBody);
  }

  const server = createHttpServer((request, response) => {
    void serve(request, response).catch(() => {
      console.error('HTTP MCP request failed.');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, handler };
}
