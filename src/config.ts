import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const endpoint = z.string().url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}, 'Use HTTPS, or HTTP on loopback for development, without URL credentials or fragments.');
const identifier = endpoint.refine(value => URL.canParse(value) && !new URL(value).search, 'Resource and issuer identifiers must not contain a query.');
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const fields = {
  resourceUrl: identifier,
  issuerUrl: identifier,
  loginUrl: endpoint,
  validationUrl: endpoint,
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/)).max(50),
  validationClientIdEnv: envName.optional(),
  validationClientSecretEnv: envName.optional(),
  timeoutMs: z.number().int().min(100).max(30000),
};

export const authenticationSchema = z.discriminatedUnion('enabled', [
  // Keep provider settings when toggling authentication off; no secrets are read.
  z.object(fields).partial().extend({ enabled: z.literal(false) }).strict(),
  z.object({
    ...fields,
    enabled: z.literal(true),
    scopes: fields.scopes.default([]),
    timeoutMs: fields.timeoutMs.default(5000),
  }).strict().refine(value => Boolean(value.validationClientIdEnv) === Boolean(value.validationClientSecretEnv), {
    message: 'Configure both validationClientIdEnv and validationClientSecretEnv, or neither.',
  }),
]);

const schema = z.object({ authentication: authenticationSchema }).strict();
export type AuthenticationConfig = z.infer<typeof authenticationSchema>;
export type Configuration = z.infer<typeof schema>;

export function parseConfiguration(value: unknown): Configuration {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Report field names, not raw values that might contain private configuration.
    throw new Error(`Invalid configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}

export async function loadConfiguration(filename?: string): Promise<Configuration | undefined> {
  const target = filename ?? 'skills-mcp.config.json';
  let content: string;
  try {
    content = await readFile(path.resolve(target), 'utf8');
  } catch (error) {
    if (!filename && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('Cannot read the configuration file.');
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Configuration must be valid JSON.');
  }
  return parseConfiguration(value);
}
