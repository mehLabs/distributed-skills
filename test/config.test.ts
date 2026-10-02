import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfiguration, parseConfiguration } from '../src/config.js';
import { file, workspace } from './helpers.js';

const enabled = { enabled: true, resourceUrl: 'https://skills.example.org/mcp', issuerUrl: 'https://identity.example.org', loginUrl: 'https://identity.example.org/login', validationUrl: 'https://identity.example.org/introspect' };

test('configuration can explicitly enable or disable authentication', () => {
  // Arrange
  const input = { authentication: enabled };

  // Act
  const config = parseConfiguration(input);
  const disabled = parseConfiguration({ authentication: { enabled: false } });
  const toggled = parseConfiguration({ authentication: { ...enabled, enabled: false } });

  // Assert
  assert.equal(config.authentication.enabled, true);
  assert.deepEqual(disabled.authentication, { enabled: false });
  assert.equal(toggled.authentication.enabled, false);
  assert.equal(toggled.authentication.loginUrl, enabled.loginUrl);
});

test('incomplete or misspelled auth settings fail closed', () => {
  // Arrange
  const invalid = [
    { authentication: { enabled: true, loginUrl: enabled.loginUrl } },
    { authentication: { ...enabled, validationClientIdEnv: 'CLIENT_ID' } },
    { authentication: { ...enabled, enabled: 'false' } },
    { authentication: { ...enabled, unknowField: true } },
    { authenticaton: { enabled: false } },
  ];

  // Act / Assert
  for (const config of invalid) assert.throws(() => parseConfiguration(config), /Invalid configuration/);
});

test('rejects insecure remote and credential-bearing endpoint URLs, while allowing loopback development', () => {
  // Arrange
  const invalid = ['not a URL', 'http://identity.example.org/introspect', 'https://user:password@identity.example.org/introspect', 'https://identity.example.org/introspect#fragment'];

  // Act
  const local = parseConfiguration({ authentication: { ...enabled, validationUrl: 'http://127.0.0.1:3001/introspect' } });

  // Assert
  assert.equal(local.authentication.enabled, true);
  for (const validationUrl of invalid) assert.throws(() => parseConfiguration({ authentication: { ...enabled, validationUrl } }));
});

test('loads an explicitly selected JSON configuration and rejects missing or malformed files', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'auth.json', JSON.stringify({ authentication: { enabled: false } }));
  await file(root, 'broken.json', '{ nope');

  // Act
  const config = await loadConfiguration(path.join(root, 'auth.json'));

  // Assert
  assert.equal(config?.authentication.enabled, false);
  await assert.rejects(loadConfiguration(path.join(root, 'missing.json')), /Cannot read/);
  await assert.rejects(loadConfiguration(path.join(root, 'broken.json')), /valid JSON/);
});
