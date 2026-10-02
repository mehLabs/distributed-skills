import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Authentication } from '../src/auth.js';
import { SkillCatalog } from '../src/catalog.js';
import { createHttpService } from '../src/http.js';
import { provider } from './auth-helpers.js';
import { file, manifest, workspace } from './helpers.js';

async function service(t: TestContext, authentication: Authentication) {
  const root = await workspace(t);
  await file(root, 'team/example/SKILL.md', manifest());
  const instance = createHttpService(new SkillCatalog(root), { authentication });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  const address = instance.server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    instance.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => instance.server.close(error => error ? reject(error) : resolve()));
    await instance.handler.close();
  });
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

function content(result: { structuredContent?: unknown }) {
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  return result.structuredContent as Record<string, unknown>;
}

test('anonymous MCP clients discover login information and standard resource metadata', async t => {
  // Arrange
  const fixture = await provider(t);
  const auth = new Authentication(fixture.config);
  const url = await service(t, auth);
  const client = new Client({ name: 'anonymous-discovery', version: '1.0.0' });
  t.after(() => client.close());

  // Act
  await client.connect(new StreamableHTTPClientTransport(url));
  const tools = await client.listTools();
  const resources = await client.listResources();
  const info = await client.callTool({ name: 'get_auth_info', arguments: {} });
  const authResource = await client.readResource({ uri: 'skill://auth/info' });
  const httpInfo = await fetch(new URL('/auth', url));
  const metadata = await fetch(new URL(auth.metadataPath()!, url));

  // Assert
  assert.ok(tools.tools.some(tool => tool.name === 'get_auth_info'));
  assert.ok(resources.resources.some(resource => resource.uri === 'skill://auth/info'));
  assert.equal(content(info).login_url, `${fixture.base}/login`);
  assert.equal(authResource.contents[0]?.uri, 'skill://auth/info');
  assert.deepEqual(await httpInfo.json(), auth.info());
  assert.deepEqual(await metadata.json(), auth.metadata());
  assert.equal(fixture.requests.length, 0);
});

test('every catalog tool and resource rejects anonymous HTTP access with a discoverable challenge', async t => {
  // Arrange
  const fixture = await provider(t);
  const auth = new Authentication(fixture.config);
  const url = await service(t, auth);
  const operations = [
    { method: 'tools/call', params: { name: 'list_skills', arguments: {} } },
    { method: 'tools/call', params: { name: 'search_skills', arguments: { query: 'example' } } },
    { method: 'tools/call', params: { name: 'get_skill', arguments: { id: 'team/example' } } },
    { method: 'tools/call', params: { name: 'read_skill_file', arguments: { id: 'team/example', path: 'SKILL.md' } } },
    { method: 'resources/read', params: { uri: 'skill://catalog/index' } },
  ];

  // Act
  const responses = await Promise.all(operations.map(operation => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...operation }),
  })));

  // Assert
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.ok(response.headers.get('www-authenticate')?.includes(auth.metadataUrl()!));
    const body = await response.json() as { error: string; authentication: { login_url: string } };
    assert.equal(body.error, 'authentication_required');
    assert.equal(body.authentication.login_url, `${fixture.base}/login`);
  }
  assert.equal(fixture.requests.length, 0);
});

test('authenticated HTTP MCP calls are validated on each read, including resource reads', async t => {
  // Arrange
  const fixture = await provider(t);
  const url = await service(t, new Authentication(fixture.config));
  const client = new Client({ name: 'authenticated-reader', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer valid-token' } } }));

  // Act
  const skills = await client.callTool({ name: 'list_skills', arguments: {} });
  const resource = await client.readResource({ uri: 'skill://catalog/index' });
  fixture.respond(response => response.end(JSON.stringify({ active: false })));
  const revoked = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_skills', arguments: {} } }) });

  // Assert
  assert.equal(content(skills).total, 1);
  assert.equal(resource.contents[0]?.uri, 'skill://catalog/index');
  assert.equal(revoked.status, 401);
  assert.ok(revoked.headers.get('www-authenticate')?.includes('invalid_token'));
  // The SDK may also open an authenticated GET stream alongside these reads.
  assert.ok(fixture.requests.length >= 3);
  assert.ok(fixture.requests.every(request => request.token === 'valid-token'));
});

test('explicitly disabled authentication makes HTTP skill reads anonymous', async t => {
  // Arrange
  const url = await service(t, new Authentication({ enabled: false }));
  const client = new Client({ name: 'disabled-auth', version: '1.0.0' });
  t.after(() => client.close());

  // Act
  await client.connect(new StreamableHTTPClientTransport(url));
  const info = await client.callTool({ name: 'get_auth_info', arguments: {} });
  const skills = await client.callTool({ name: 'list_skills', arguments: {} });

  // Assert
  assert.deepEqual(content(info), { enabled: false });
  assert.equal(content(skills).total, 1);
});

for (const authenticated of [false, true]) {
  test(`stdio exposes login discovery and ${authenticated ? 'validates configured credentials' : 'rejects skill reads without credentials'}`, async t => {
    // Arrange
    const fixture = await provider(t);
    const root = await workspace(t);
    await file(root, 'example/SKILL.md', manifest());
    await file(root, 'auth.json', JSON.stringify({ authentication: fixture.config }));
    const client = new Client({ name: 'stdio-auth', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/cli.ts'), '--skills-dir', root, '--config', path.join(root, 'auth.json')],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        SKILLS_MCP_ACCESS_TOKEN: authenticated ? 'valid-token' : '' }, stderr: 'pipe' });
    t.after(() => client.close());

    // Act
    await client.connect(transport);
    const info = await client.callTool({ name: 'get_auth_info', arguments: {} });
    const skills = await client.callTool({ name: 'list_skills', arguments: {} });

    // Assert
    assert.equal(content(info).login_url, `${fixture.base}/login`);
    if (authenticated) {
      assert.equal(content(skills).total, 1);
      assert.equal(fixture.requests.length, 1);
    } else {
      assert.equal(skills.isError, true);
      assert.equal(fixture.requests.length, 0);
    }
  });
}
