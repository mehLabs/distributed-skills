import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Authentication, AuthenticationError, bearerToken } from '../src/auth.js';
import { provider } from './auth-helpers.js';

test('disabled authentication accepts anonymous access without calling a provider', async () => {
  // Arrange
  const auth = new Authentication({ enabled: false });

  // Act
  const principal = await auth.verify();

  // Assert
  assert.equal(principal, undefined);
  assert.deepEqual(auth.info(), { enabled: false });
  assert.equal(auth.metadata(), undefined);
});

test('validates credentials using form-encoded introspection and checks requested scopes', async t => {
  // Arrange
  const fixture = await provider(t);
  const auth = new Authentication(fixture.config);

  // Act
  const principal = await auth.verify('valid-token');

  // Assert
  assert.equal(principal?.subject, 'employee');
  assert.deepEqual(principal?.scopes, ['skills:read']);
  assert.equal(fixture.requests[0]?.token, 'valid-token');
  assert.equal(fixture.requests[0]?.contentType, 'application/x-www-form-urlencoded');
});

test('missing credentials are rejected before contacting the verifier', async t => {
  // Arrange
  const fixture = await provider(t);
  const auth = new Authentication(fixture.config);

  // Act / Assert
  await assert.rejects(auth.verify(), (error: unknown) => error instanceof AuthenticationError && error.status === 401);
  assert.equal(fixture.requests.length, 0);
});

test('inactive credentials cannot access the catalog', async t => {
  // Arrange
  const fixture = await provider(t);
  const auth = new Authentication(fixture.config);

  // Act / Assert
  await assert.rejects(auth.verify('invalid-token'), (error: unknown) => error instanceof AuthenticationError && error.code === 'invalid_token');
});

for (const [name, claims] of [
  ['expired', { exp: 1 }],
  ['wrong audience', { aud: 'https://another.example.org/mcp' }],
  ['wrong issuer', { iss: 'https://another.example.org' }],
  ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ['missing expiration', { exp: undefined }],
] as const) {
  test(`rejects ${name} credentials even when active is true`, async t => {
    // Arrange
    const fixture = await provider(t);
    fixture.respond(response => response.end(JSON.stringify(fixture.active(claims))));
    const auth = new Authentication(fixture.config);

    // Act / Assert
    await assert.rejects(auth.verify('valid-token'), (error: unknown) => error instanceof AuthenticationError && error.status === 401);
  });
}

test('insufficient scopes return forbidden instead of accepting an active token', async t => {
  // Arrange
  const fixture = await provider(t);
  fixture.respond(response => response.end(JSON.stringify(fixture.active({ scope: 'another:scope' }))));
  const auth = new Authentication(fixture.config);

  // Act / Assert
  await assert.rejects(auth.verify('valid-token'), (error: unknown) => error instanceof AuthenticationError && error.status === 403);
});

test('provider errors fail closed without exposing tokens or provider response details', async t => {
  // Arrange
  const fixture = await provider(t);
  fixture.respond(response => { response.writeHead(500); response.end('sensitive provider error'); });
  const auth = new Authentication(fixture.config);

  // Act / Assert
  await assert.rejects(auth.verify('secret-token'), (error: unknown) => {
    assert.ok(error instanceof AuthenticationError);
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes('secret-token') && !error.message.includes('sensitive'));
    return true;
  });
});

test('does not follow redirects from an introspection endpoint', async t => {
  // Arrange
  const fixture = await provider(t);
  fixture.respond(response => { response.writeHead(307, { location: `${fixture.base}/other` }); response.end(); });
  const auth = new Authentication(fixture.config);

  // Act / Assert
  await assert.rejects(auth.verify('valid-token'), (error: unknown) => error instanceof AuthenticationError && error.status === 503);
  assert.equal(fixture.requests.length, 1);
});

for (const payload of ['not JSON', '{}', '{"active":"true"}', 'x'.repeat(65537)]) {
  test(`fails closed on ${payload.length > 100 ? 'oversized' : 'malformed'} introspection responses (${payload.length} bytes)`, async t => {
    // Arrange
    const fixture = await provider(t);
    fixture.respond(response => response.end(payload));
    const auth = new Authentication(fixture.config);

    // Act / Assert
    await assert.rejects(auth.verify('valid-token'), (error: unknown) => error instanceof AuthenticationError && error.status === 503);
  });
}

test('validation timeout fails closed even if the provider never sends a response', async t => {
  // Arrange
  const fixture = await provider(t);
  if (!fixture.config.enabled) throw new Error('Expected enabled authentication.');
  fixture.respond(() => {});
  const auth = new Authentication({ ...fixture.config, timeoutMs: 100 });

  // Act / Assert
  await assert.rejects(auth.verify('valid-token'), (error: unknown) => error instanceof AuthenticationError && error.status === 503);
});

test('introspection client credentials come from environment and stay out of public discovery', async t => {
  // Arrange
  const fixture = await provider(t);
  assert.equal(fixture.config.enabled, true);
  if (!fixture.config.enabled) throw new Error('Expected enabled authentication.');
  const config = { ...fixture.config, validationClientIdEnv: 'TEST_ID', validationClientSecretEnv: 'TEST_SECRET' };
  const auth = new Authentication(config, { TEST_ID: 'client:id', TEST_SECRET: 'private secret' });

  // Act
  await auth.verify('valid-token');
  const info = JSON.stringify(auth.info());

  // Assert
  const expected = Buffer.from('client%3Aid:private+secret').toString('base64');
  assert.equal(fixture.requests[0]?.authorization, `Basic ${expected}`);
  assert.ok(!info.includes('private secret') && !info.includes('TEST_SECRET') && !info.includes('introspect'));
  assert.throws(() => new Authentication(config, {}), /missing/);
});

test('bearer parsing rejects ambiguous headers and accepts case-insensitive schemes', () => {
  // Arrange
  const valid = 'bearer abc.def-123_~+/==';
  const invalid = ['Basic abc', 'Bearer ', 'Bearer abc Bearer def', 'Bearer abc,def', 'Bearer abc\r\n', 'Bearer abc\n'];

  // Act
  const token = bearerToken(valid);

  // Assert
  assert.equal(token, 'abc.def-123_~+/==');
  assert.ok(invalid.every(header => bearerToken(header) === undefined));
});
