import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SkillCatalog } from '../src/catalog.js';
import { createHttpService } from '../src/http.js';
import { file, manifest, workspace } from './helpers.js';

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  return result.structuredContent as Record<string, unknown>;
}

test('stdio client discovers tools, pages grouped skills, and loads instructions and references', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'engineering/example/SKILL.md', manifest());
  await file(root, 'engineering/example/references/checklist.md', 'Verify behavior.');
  await file(root, 'writing/example/SKILL.md', manifest());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('src/cli.ts'), '--skills-dir', root],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  t.after(() => client.close());

  // Act
  await client.connect(transport);
  const tools = await client.listTools();
  const firstPage = await client.callTool({ name: 'list_skills', arguments: { limit: 1 } });
  const secondPage = await client.callTool({ name: 'list_skills', arguments: { offset: 1, limit: 1 } });
  const matches = await client.callTool({ name: 'search_skills', arguments: { query: 'engineering' } });
  const instructions = await client.callTool({ name: 'get_skill', arguments: { id: 'engineering/example' } });
  const reference = await client.callTool({ name: 'read_skill_file', arguments: { id: 'engineering/example', path: 'references/checklist.md' } });
  const resource = await client.readResource({ uri: 'skill://catalog/index' });

  // Assert
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['get_auth_info', 'get_skill', 'list_skills', 'read_skill_file', 'search_skills']);
  assert.equal(data(firstPage).total, 2);
  assert.equal(data(firstPage).next_offset, 1);
  assert.equal(data(secondPage).next_offset, null);
  assert.equal(data(matches).total, 1);
  assert.equal(data(instructions).content, manifest());
  assert.equal(data(reference).content, 'Verify behavior.');
  assert.equal(resource.contents[0]?.uri, 'skill://catalog/index');
});

test('stdio returns tool errors for invalid inputs and inaccessible paths', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'example/SKILL.md', manifest());
  const client = new Client({ name: 'error-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('src/cli.ts'), '--skills-dir', root], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);

  // Act
  const invalidLimit = await client.callTool({ name: 'list_skills', arguments: { limit: 0 } });
  const traversal = await client.callTool({ name: 'read_skill_file', arguments: { id: 'example', path: '../secret.txt' } });
  const missing = await client.callTool({ name: 'get_skill', arguments: { id: 'missing' } });

  // Assert
  assert.equal(invalidLimit.isError, true);
  assert.equal(traversal.isError, true);
  assert.equal(missing.isError, true);
});

test('HTTP client reads the same catalog and bearer authentication protects the endpoint', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'deep/group/example/SKILL.md', manifest());
  const service = createHttpService(new SkillCatalog(root), { token: 'test-only-token' });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const address = service.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    service.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve()));
    await service.handler.close();
  });

  // Act
  const unauthenticated = await fetch(url, { method: 'POST' });
  const wrongToken = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
  // Node fetch normalizes Host; use a raw HTTP request to exercise the guard.
  const forbiddenHost = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(url, { headers: { host: 'untrusted.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
  const forbiddenOrigin = await fetch(url, { headers: { origin: 'https://untrusted.example' } });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer test-only-token' } } }));
  const skills = await client.callTool({ name: 'list_skills', arguments: {} });
  const health = await fetch(new URL('/health', url));

  // Assert
  assert.equal(unauthenticated.status, 401);
  assert.equal(wrongToken.status, 401);
  assert.equal(forbiddenHost, 403);
  assert.equal(forbiddenOrigin.status, 403);
  assert.equal(data(skills).total, 1);
  assert.equal(health.status, 200);
});
