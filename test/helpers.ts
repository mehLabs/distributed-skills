import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';

export async function workspace(t: TestContext): Promise<string> {
  const parent = path.resolve('.cache/test-workspaces');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'catalog-'));
  t.after(async () => {
    const relative = path.relative(parent, path.resolve(directory));
    assert.ok(relative.startsWith('catalog-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export async function file(root: string, relative: string, content: string | Buffer) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

export function manifest(name = 'example', description = 'Review code changes') {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: "1.0.0"\n---\n\nInstructions for ${name}.\n`;
}
