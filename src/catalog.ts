import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { parseDocument } from 'yaml';

export const MAX_FILE_BYTES = 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.cache']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  version?: string;
  compatibility?: string;
  digest: string;
}

export interface CatalogDiagnostic {
  path: string;
  message: string;
}

export interface CatalogSnapshot {
  skills: SkillMetadata[];
  diagnostics: CatalogDiagnostic[];
}

export class CatalogError extends Error {}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function segments(value: string): string[] {
  if (!value || value.includes('\\') || value.includes(':') || value.includes('\0')) {
    throw new CatalogError('Use a relative path with forward slashes.');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new CatalogError('Absolute paths and path traversal are not allowed.');
  }
  if (parts.some(part => IGNORED_DIRECTORIES.has(part))) {
    throw new CatalogError('This path belongs to an excluded directory.');
  }
  return parts;
}

async function containedPath(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new CatalogError('Symbolic links are not served.');
  }
  const resolved = await realpath(current);
  if (!isWithin(root, resolved)) throw new CatalogError('Path is outside the configured directory.');
  return resolved;
}

async function readBytes(filename: string): Promise<Buffer> {
  const handle = await open(filename, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new CatalogError('Only regular files can be read.');
    if (info.size > MAX_FILE_BYTES) throw new CatalogError(`File exceeds ${MAX_FILE_BYTES} bytes.`);
    // Read a bounded buffer, including one extra byte to detect files that grew.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new CatalogError(`File exceeds ${MAX_FILE_BYTES} bytes.`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function parseSkill(id: string, bytes: Buffer): SkillMetadata {
  const text = utf8.decode(bytes).replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new CatalogError('SKILL.md must start with YAML frontmatter.');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length > 0) throw new CatalogError('Invalid YAML frontmatter.');
  const data: unknown = document.toJS({ maxAliasCount: 50 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CatalogError('Frontmatter must be a mapping.');
  }
  const fields = data as Record<string, unknown>;
  if (typeof fields.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name) || fields.name.length > 64) {
    throw new CatalogError('name must be 1–64 lowercase letters, digits, or hyphens, without consecutive hyphens.');
  }
  if (typeof fields.description !== 'string' || !fields.description.trim() || fields.description.length > 1024) {
    throw new CatalogError('description must be a non-empty string of at most 1024 characters.');
  }
  const metadata = fields.metadata as Record<string, unknown> | undefined;
  return {
    id,
    name: fields.name,
    description: fields.description.trim(),
    ...(typeof metadata?.version === 'string' ? { version: metadata.version } : {}),
    ...(typeof fields.compatibility === 'string' ? { compatibility: fields.compatibility } : {}),
    digest: digest(bytes),
  };
}

function publicError(error: unknown): string {
  if (error instanceof CatalogError) return error.message;
  if (error instanceof Error && 'code' in error) return `Filesystem operation failed (${String(error.code)}).`;
  return 'Could not read skill content.';
}

export class SkillCatalog {
  constructor(readonly directory: string) {}

  private async root(): Promise<string> {
    try {
      const root = await realpath(path.resolve(this.directory));
      if (!(await lstat(root)).isDirectory()) throw new CatalogError('Skills path must be a directory.');
      return root;
    } catch (error) {
      throw new CatalogError(`Cannot open skills directory: ${publicError(error)}`);
    }
  }

  async scan(): Promise<CatalogSnapshot> {
    const root = await this.root();
    const snapshot: CatalogSnapshot = { skills: [], diagnostics: [] };
    const pending = [''];
    while (pending.length) {
      const relative = pending.pop()!;
      const directory = await containedPath(root, relative ? relative.split('/') : []);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        snapshot.diagnostics.push({ path: relative || '.', message: publicError(error) });
        continue;
      }
      for (const entry of entries) {
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) pending.push(entryPath);
        if (entry.isFile() && entry.name === 'SKILL.md') {
          try {
            const filename = await containedPath(root, entryPath.split('/'));
            snapshot.skills.push(parseSkill(relative || '.', await readBytes(filename)));
          } catch (error) {
            snapshot.diagnostics.push({ path: entryPath, message: publicError(error) });
          }
        }
      }
    }
    snapshot.skills.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    snapshot.diagnostics.sort((a, b) => a.path.localeCompare(b.path));
    return snapshot;
  }

  async search(query: string): Promise<CatalogSnapshot> {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new CatalogError('Search query must not be empty.');
    const snapshot = await this.scan();
    snapshot.skills = snapshot.skills.filter(skill => {
      const searchable = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
      return terms.every(term => searchable.includes(term));
    });
    return snapshot;
  }

  private async skillDirectory(id: string): Promise<{ root: string; directory: string }> {
    const root = await this.root();
    const directory = await containedPath(root, id === '.' ? [] : segments(id));
    // A group directory is not a skill unless it contains a valid manifest.
    const manifest = await containedPath(directory, ['SKILL.md']);
    parseSkill(id, await readBytes(manifest));
    return { root, directory };
  }

  async getSkill(id: string) {
    try {
      const { directory } = await this.skillDirectory(id);
      const bytes = await readBytes(await containedPath(directory, ['SKILL.md']));
      const skill = parseSkill(id, bytes);
      const files: string[] = [];
      const pending = [''];
      while (pending.length) {
        const relative = pending.pop()!;
        const folder = await containedPath(directory, relative ? relative.split('/') : []);
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) pending.push(entryPath);
          if (entry.isFile()) files.push(entryPath);
        }
      }
      return { skill, content: utf8.decode(bytes), files: files.sort() };
    } catch (error) {
      throw new CatalogError(`Cannot load skill: ${publicError(error)}`);
    }
  }

  async readFile(id: string, filePath: string) {
    try {
      const parts = segments(filePath);
      const { directory } = await this.skillDirectory(id);
      const bytes = await readBytes(await containedPath(directory, parts));
      const common = { id, path: filePath, digest: digest(bytes), size: bytes.length };
      try {
        const content = utf8.decode(bytes);
        if (content.includes('\0')) throw new Error('Binary data');
        return { ...common, encoding: 'utf-8', content };
      } catch {
        return { ...common, encoding: 'base64', content: bytes.toString('base64') };
      }
    } catch (error) {
      throw new CatalogError(`Cannot read skill file: ${publicError(error)}`);
    }
  }
}
