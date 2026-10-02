import assert from 'node:assert/strict';
import { symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_FILE_BYTES, SkillCatalog } from '../src/catalog.js';
import { file, manifest, workspace } from './helpers.js';

test('discovers arbitrary groups, a root skill, and skills nested inside another skill', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'SKILL.md', manifest('root-skill'));
  await file(root, 'engineering/reviews/code-review/SKILL.md', manifest('code-review'));
  await file(root, 'engineering/reviews/code-review/specialized/security/SKILL.md', manifest('security'));
  await file(root, 'writing/change-summary/SKILL.md', manifest('change-summary'));
  const catalog = new SkillCatalog(root);

  // Act
  const snapshot = await catalog.scan();

  // Assert
  assert.deepEqual(snapshot.skills.map(skill => skill.id), [
    '.', 'engineering/reviews/code-review', 'engineering/reviews/code-review/specialized/security', 'writing/change-summary',
  ]);
  assert.deepEqual(snapshot.diagnostics, []);
});

test('duplicate names remain addressable using their relative IDs', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'team-a/review/SKILL.md', manifest('review', 'Review frontend changes'));
  await file(root, 'team-b/review/SKILL.md', manifest('review', 'Review backend changes'));
  const catalog = new SkillCatalog(root);

  // Act
  const snapshot = await catalog.scan();
  const selected = await catalog.getSkill('team-b/review');

  // Assert
  assert.equal(snapshot.skills.length, 2);
  assert.equal(selected.skill.description, 'Review backend changes');
});

test('parses multiline YAML, BOM, and CRLF manifests', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'example/SKILL.md', '\uFEFF---\r\nname: example\r\ndescription: >\r\n  Review code\r\n  changes carefully\r\n---\r\nInstructions\r\n');

  // Act
  const snapshot = await new SkillCatalog(root).scan();

  // Assert
  assert.equal(snapshot.skills[0]?.description, 'Review code changes carefully');
});

test('skips malformed manifests and reports relative diagnostics without losing valid skills', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'good/SKILL.md', manifest('good'));
  await file(root, 'missing/SKILL.md', '# Missing frontmatter');
  await file(root, 'broken/SKILL.md', '---\nname: broken\ndescription: [oops\n---\n');
  await file(root, 'empty/SKILL.md', '---\nname: empty\ndescription: ""\n---\n');

  // Act
  const snapshot = await new SkillCatalog(root).scan();

  // Assert
  assert.deepEqual(snapshot.skills.map(skill => skill.id), ['good']);
  assert.equal(snapshot.diagnostics.length, 3);
  assert.ok(snapshot.diagnostics.every(item => !item.message.includes(root)));
});

test('search matches every word against names, descriptions, and grouped IDs', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'engineering/review/SKILL.md', manifest('review', 'Review TypeScript changes'));
  await file(root, 'writing/review/SKILL.md', manifest('review', 'Review documents'));

  // Act
  const matches = await new SkillCatalog(root).search('ENGINEERING typescript');

  // Assert
  assert.deepEqual(matches.skills.map(skill => skill.id), ['engineering/review']);
});

test('a later scan reflects added, modified, and removed skills', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'example/SKILL.md', manifest());
  const catalog = new SkillCatalog(root);
  const before = await catalog.scan();

  // Act
  await file(root, 'example/SKILL.md', manifest('example', 'Updated workflow'));
  await file(root, 'new-skill/SKILL.md', manifest('new-skill'));
  const updated = await catalog.scan();
  await unlink(path.join(root, 'example/SKILL.md'));
  const removed = await catalog.scan();

  // Assert
  assert.notEqual(before.skills[0]?.digest, updated.skills[0]?.digest);
  assert.equal(updated.skills.length, 2);
  assert.deepEqual(removed.skills.map(skill => skill.id), ['new-skill']);
});

test('loads complete instructions and recursively lists and reads supporting files', async t => {
  // Arrange
  const root = await workspace(t);
  const instructions = manifest('example');
  await file(root, 'example/SKILL.md', instructions);
  await file(root, 'example/references/deep/checklist.md', 'Check the inputs.');
  const catalog = new SkillCatalog(root);

  // Act
  const loaded = await catalog.getSkill('example');
  const reference = await catalog.readFile('example', 'references/deep/checklist.md');

  // Assert
  assert.equal(loaded.content, instructions);
  assert.deepEqual(loaded.files, ['SKILL.md', 'references/deep/checklist.md']);
  assert.equal(loaded.skill.version, '1.0.0');
  assert.equal(reference.content, 'Check the inputs.');
  assert.equal(reference.encoding, 'utf-8');
});

test('returns binary assets as base64 without executing anything', async t => {
  // Arrange
  const root = await workspace(t);
  const bytes = Buffer.from([0, 255, 128, 42]);
  await file(root, 'example/SKILL.md', manifest());
  await file(root, 'example/assets/data.bin', bytes);

  // Act
  const result = await new SkillCatalog(root).readFile('example', 'assets/data.bin');

  // Assert
  assert.equal(result.encoding, 'base64');
  assert.deepEqual(Buffer.from(result.content, 'base64'), bytes);
});

test('rejects traversal, absolute paths, and crossing into a sibling skill', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'example/SKILL.md', manifest());
  await file(root, 'sibling/SKILL.md', manifest('sibling'));
  const catalog = new SkillCatalog(root);
  const unsafePaths = ['../sibling/SKILL.md', '/etc/passwd', 'C:/secret.txt', 'C:\\secret.txt', 'references/../../secret', 'references\\secret', 'references/./secret', 'references//secret'];

  // Act / Assert
  for (const unsafe of unsafePaths) {
    await assert.rejects(catalog.readFile('example', unsafe));
  }
  await assert.rejects(catalog.getSkill('../sibling'));
  await assert.rejects(catalog.getSkill('/example'));
  await assert.rejects(catalog.getSkill('group-without-manifest'));
});

test('does not discover or read excluded dependency and Git directories', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'example/SKILL.md', manifest());
  await file(root, 'example/.git/SKILL.md', manifest('hidden'));
  await file(root, 'node_modules/hidden/SKILL.md', manifest('hidden'));
  const catalog = new SkillCatalog(root);

  // Act
  const snapshot = await catalog.scan();
  const loaded = await catalog.getSkill('example');

  // Assert
  assert.deepEqual(snapshot.skills.map(skill => skill.id), ['example']);
  assert.deepEqual(loaded.files, ['SKILL.md']);
  await assert.rejects(catalog.readFile('example', '.git/SKILL.md'));
});

test('ignores linked directories and refuses reading through links', async t => {
  // Arrange
  const root = await workspace(t);
  const outside = await workspace(t);
  await file(root, 'example/SKILL.md', manifest());
  await file(outside, 'SKILL.md', manifest('outside'));
  await file(outside, 'secret.txt', 'outside content');
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(outside, path.join(root, 'example', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const catalog = new SkillCatalog(root);

  // Act
  const snapshot = await catalog.scan();

  // Assert
  assert.deepEqual(snapshot.skills.map(skill => skill.id), ['example']);
  await assert.rejects(catalog.getSkill('linked'), /Symbolic links/);
  await assert.rejects(catalog.readFile('example', 'linked/secret.txt'), /Symbolic links/);
});

test('rejects oversized files and diagnoses oversized manifests', async t => {
  // Arrange
  const root = await workspace(t);
  await file(root, 'example/SKILL.md', manifest());
  await file(root, 'example/huge.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  await file(root, 'huge/SKILL.md', Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  const catalog = new SkillCatalog(root);

  // Act
  const snapshot = await catalog.scan();

  // Assert
  assert.equal(snapshot.diagnostics[0]?.path, 'huge/SKILL.md');
  await assert.rejects(catalog.readFile('example', 'huge.txt'), /exceeds/);
});

test('an empty catalog is valid, but a missing configured directory fails explicitly', async t => {
  // Arrange
  const root = await workspace(t);

  // Act
  const snapshot = await new SkillCatalog(root).scan();

  // Assert
  assert.deepEqual(snapshot, { skills: [], diagnostics: [] });
  await assert.rejects(new SkillCatalog(path.join(root, 'missing')).scan(), /Cannot open skills directory/);
});
