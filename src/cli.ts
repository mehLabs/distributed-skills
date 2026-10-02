#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { SkillCatalog } from './catalog.js';
import { createHttpService } from './http.js';
import { createServer } from './server.js';
import { Authentication } from './auth.js';
import { loadConfiguration } from './config.js';

const help = `distributed-skills-mcp

Usage: distributed-skills-mcp [options]

  --skills-dir PATH    Skills directory (recursive). Defaults to bundled examples.
                      Also configurable with SKILLS_DIR.
  --config PATH        JSON configuration (default: skills-mcp.config.json in cwd,
                      when present). Also configurable with SKILLS_MCP_CONFIG.
  --transport TYPE    stdio (default) or http (Streamable HTTP).
  --host HOST         HTTP listen address (default: 127.0.0.1).
  --port PORT         HTTP listen port (default: 3000).
  --allowed-hosts CSV Allowed HTTP Host hostnames, without ports.
                      Default: localhost,127.0.0.1,[::1].
  --check             Validate the catalog, print JSON, and exit.
  --help              Show this help.

HTTP environment variables:
  SKILLS_MCP_TOKEN           Optional shared bearer token (never pass it as a CLI argument).
                            Used only when no configuration file is loaded.
  SKILLS_MCP_ALLOWED_ORIGINS Optional comma-separated browser Origin hostnames.
                            Browser origins are rejected by default.
  SKILLS_MCP_ACCESS_TOKEN    User access token for authenticated stdio connections.
`;

async function main() {
  const { values } = parseArgs({
    options: {
      'skills-dir': { type: 'string' },
      config: { type: 'string' },
      transport: { type: 'string', default: 'stdio' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '3000' },
      'allowed-hosts': { type: 'string' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const directory = path.resolve(values['skills-dir'] ?? process.env.SKILLS_DIR ?? fileURLToPath(new URL('../skills/', import.meta.url)));
  const catalog = new SkillCatalog(directory);
  const initial = await catalog.scan();
  const config = await loadConfiguration(values.config ?? process.env.SKILLS_MCP_CONFIG);
  if (values.check) {
    process.stdout.write(`${JSON.stringify(initial, null, 2)}\n`);
    if (initial.diagnostics.length) process.exitCode = 1;
    return;
  }
  if (values.transport !== 'stdio' && values.transport !== 'http') throw new Error('--transport must be stdio or http.');
  const authentication = config ? new Authentication(config.authentication) : undefined;
  for (const diagnostic of initial.diagnostics) console.error(`${diagnostic.path}: ${diagnostic.message}`);
  console.error(`Loaded ${initial.skills.length} skills from ${directory}.`);

  if (values.transport === 'stdio') {
    await serveStdio(() => createServer(catalog, {
      authInfo: authentication?.info(),
      authorize: authentication?.config.enabled ? async () => { await authentication.verify(process.env.SKILLS_MCP_ACCESS_TOKEN); } : undefined,
    }));
    return;
  }
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port!) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535.');
  }
  const csv = (value: string | undefined) => value?.split(',').map(item => item.trim()).filter(Boolean);
  const service = createHttpService(catalog, {
    allowedHosts: csv(values['allowed-hosts']),
    allowedOrigins: csv(process.env.SKILLS_MCP_ALLOWED_ORIGINS),
    authentication,
    token: config ? undefined : process.env.SKILLS_MCP_TOKEN,
  });
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(port, values.host, () => {
      service.server.removeListener('error', reject);
      resolve();
    });
  });
  console.error(`MCP endpoint listening at http://${values.host}:${port}/mcp`);
  const shutdown = () => {
    service.server.close(() => { void service.handler.close(); });
    service.server.closeIdleConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Server failed to start.');
  process.exitCode = 1;
});
