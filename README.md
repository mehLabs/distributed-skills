# Distributed Skills MCP

Share Agent Skills through a read-only [Model Context Protocol](https://modelcontextprotocol.io/) server.
Organize skills by team, domain, or workflow in as many nested folders as you
need. Agents discover metadata first and retrieve instructions and supporting
files on demand.

MIT licensed: free to use, modify, redistribute, self-host, and use commercially.

**Setting this up for your company?** Follow the
[company setup guide](docs/company-setup.md): run one shared MCP,
configure optional login, add skills in nested folders, and connect employees' agents.

## Quick start

Requires Node.js 22 or later.

```sh
git clone https://github.com/mehLabs/distributed-skills.git
cd distributed-skills
npm ci
npm run build
node dist/cli.js --check
```

Start the server with the bundled example skills over stdio:

```sh
node dist/cli.js
```

Or serve your own directory:

```sh
node dist/cli.js --skills-dir /absolute/path/to/skills
```

On Windows use an absolute Windows path, quoted when it contains spaces.
`--skills-dir` takes precedence over the `SKILLS_DIR` environment variable.
Relative paths are resolved against the process working directory. When neither
is set, the server uses its bundled `skills/` directory, regardless of the
client's working directory.

## Recursive discovery

```text
skills/
├── engineering/
│   └── reviews/
│       └── code-review/
│           ├── SKILL.md
│           └── references/
│               └── checklist.md
└── writing/
    └── change-summary/
        └── SKILL.md
```

Every regular file named exactly `SKILL.md` is considered, at any depth.
Grouping folders do not need manifests. Discovery continues below a skill
directory, so nested skills are also supported. `.git`, `node_modules`, and
`.cache` directories and symbolic links are excluded.

The skill ID is the manifest's parent directory relative to the configured
root, using forward slashes:

- `engineering/reviews/code-review`
- `writing/change-summary`
- `.` when the configured root itself contains `SKILL.md`

Two teams can use the same skill name because their IDs differ. Moving a skill
changes its ID. The `name` should match its immediate folder name, as recommended
by the [Agent Skills specification](https://agentskills.io/specification);
this server uses the path ID for lookup and does not enforce that match.

The catalog is scanned on each list/search call; content is read on demand.
Additions and edits are visible on subsequent calls without a server restart.
This is a live catalog, not a versioned artifact store. Publish updates between
tasks if instructions and references must remain consistent during a task.
Pagination uses sorted IDs and offsets; restart pagination if the catalog changes.

## Skill format

```markdown
---
name: code-review
description: Review code changes when asked to review a patch or pull request.
license: MIT
metadata:
  version: "1.0.0"
---

Review the patch for concrete correctness problems.
Read [the checklist](references/checklist.md) when needed.
```

Required frontmatter fields:

- `name`: 1–64 lowercase letters, digits, and hyphens, with no leading,
  trailing, or consecutive hyphens.
- `description`: a non-empty string of at most 1,024 characters.

Standard optional fields are preserved in the full Markdown returned by
`get_skill`. Catalog metadata also exposes `compatibility` and a string
`metadata.version`, when present. Versions are informational; this release
does not retain historical versions. The catalog `digest` is the SHA-256 of
`SKILL.md` only, not of its entire directory.

Malformed manifests are skipped and returned in `diagnostics`, using relative
paths. An inaccessible or missing configured root fails explicitly. Use
`--check` to print metadata and diagnostics as JSON; it exits with status 1
when any manifest is invalid.

## MCP tools and resources

| Tool | Arguments | Result |
| --- | --- | --- |
| `get_auth_info` | None | Authentication status, login URL, scopes, and credential instructions; public |
| `list_skills` | `offset` (default 0), `limit` (default 50, max 100) | Metadata, `total`, `next_offset`, diagnostics |
| `search_skills` | `query`, optional `offset` and `limit` | Matching metadata with the same pagination |
| `get_skill` | `id` | Skill metadata, complete Markdown in `content`, recursively listed `files` |
| `read_skill_file` | `id`, `path` | Content, `encoding`, size, SHA-256 digest |

Search is a case-insensitive substring match against IDs, names, and descriptions.
Every whitespace-separated query word must match. It is not semantic search,
and it does not search the instructions or supporting files.

Example sequence:

```text
get_auth_info({})
search_skills({"query":"code review"})
get_skill({"id":"engineering/reviews/code-review"})
read_skill_file({"id":"engineering/reviews/code-review","path":"references/checklist.md"})
```

Tool results contain both text JSON and `structuredContent`. Read failures are
reported as MCP tool errors. All tools are annotated as read-only.

The public resource `skill://auth/info` returns the same information as
`get_auth_info`. The resource `skill://catalog/index` returns the entire metadata catalog.
For large catalogs use the paginated tools instead. This release does not
send resource change notifications or implement subscriptions.

## Connect a local MCP client

Configure any stdio-capable MCP client to run the built entrypoint. Replace
the paths below; this repository has not been published to npm, so no registry
package or `npx` installation is required.

```json
{
  "mcpServers": {
    "distributed-skills": {
      "command": "node",
      "args": [
        "/absolute/path/to/distributed-skills/dist/cli.js",
        "--skills-dir",
        "/absolute/path/to/shared-skills"
      ]
    }
  }
}
```

Clients that use different configuration schemas need the same executable
and arguments. For example, Codex uses a TOML MCP entry:

```toml
[mcp_servers.distributed-skills]
command = "node"
args = ["/absolute/path/to/distributed-skills/dist/cli.js", "--skills-dir", "/absolute/path/to/shared-skills"]
```

In JSON on Windows, use forward slashes (`C:/shared/skills`) or escape
backslashes (`C:\\shared\\skills`). Server diagnostics go to stderr;
stdout remains reserved for MCP messages in server mode.

## Share one HTTP server

```sh
node dist/cli.js --transport http --skills-dir /srv/skills --port 3000
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3000/mcp`.
`GET /health` returns a basic process health response, not catalog validation.

HTTP binds to `127.0.0.1` by default. To expose a server behind a reverse proxy:

```sh
node dist/cli.js --transport http --host 0.0.0.0 --allowed-hosts skills.example.org,localhost,127.0.0.1 --skills-dir /srv/skills
```

Configure optional OAuth authentication as described below. Use HTTPS at the
proxy for remote access. Without an authentication configuration or a legacy
`SKILLS_MCP_TOKEN`, callers with access to the endpoint and an allowed Host can
read the catalog anonymously.

`--allowed-hosts` validates the request Host hostname, without ports. It defaults
to `localhost,127.0.0.1,[::1]`; include the hostname forwarded by your proxy.
Browser Origin headers are rejected by default. If your browser-based client
needs them, set `SKILLS_MCP_ALLOWED_ORIGINS` to comma-separated allowed Origin
hostnames. This does not enable CORS; cross-origin browser deployments need
an appropriately configured gateway.

## Optional authentication

Copy [skills-mcp.config.example.json](skills-mcp.config.example.json) to
`skills-mcp.config.json` in the server's working directory. Its default is:

```json
{ "authentication": { "enabled": false } }
```

For OAuth, copy [examples/config/auth.enabled.json](examples/config/auth.enabled.json)
instead, replace the example URLs, and configure the introspection client
credentials through the environment variables named in that file. Start with
an explicit path when the client's working directory is uncertain:

```sh
node dist/cli.js --transport http --config /srv/config/skills-mcp.config.json --skills-dir /srv/skills
```

`--config` takes precedence over `SKILLS_MCP_CONFIG`, then the default file in
the working directory. Setting `authentication.enabled` to `false` disables
authentication while retaining your provider settings. Configuration changes
require a restart. An explicitly selected missing or invalid file fails startup.

Agents can call `get_auth_info` before login to discover `login_url`, the issuer,
required scopes, and credential instructions. HTTP clients also discover the
OAuth issuer through standard protected-resource metadata and a `401`
`WWW-Authenticate` challenge. Catalog metadata, skill instructions, and supporting
files require an active access token when authentication is enabled.

The server uses an external OAuth provider's introspection endpoint; it does not
host a login page or issue tokens. The provider must support the client login
flow and return the required token claims. See [authentication setup and provider
contract](docs/authentication.md) for configuration fields, discovery endpoints,
the introspection request/response, and stdio credentials.

For existing simple deployments, `SKILLS_MCP_TOKEN` still protects all `/mcp`
requests with a shared bearer token **only when no configuration file is loaded**.
A configuration file with `enabled: false` overrides that variable. Keep tokens
in the client configuration or secret manager, never in CLI arguments or chat.
All authorized callers see the same skills directory; this release does not
implement per-user skill filtering or an audit history.

## Optional entry skill for employees

`examples/discover-shared-skills/` contains an installable entry skill that
consults this MCP before starting a work task. Copy that whole directory into
a skill location supported by your client. Configure the MCP connection
separately. The example is outside `skills/` to keep it out of the remote
catalog and avoid recursively routing back to itself.

For clients with persistent instructions, you can add:

> Before starting a work task, use discover-shared-skills to consult applicable
> shared workflows.

Automatic skill activation depends on the model and client. Reading remote
instructions does not install native skills, grant permissions, or guarantee
that every task will use a skill. Enforced discovery requires harness integration.

## File access and scope

- Serve a dedicated, curated skills directory. Every file inside a skill's
  subtree may be readable, including nested skills' files; do not place secrets
  or unrelated private files there.
- Paths are relative to a skill directory. Absolute paths, traversal, Windows
  drive paths, symbolic links, and excluded directories are rejected.
- Each served file, including `SKILL.md`, is limited to 1 MiB. UTF-8 text is
  returned directly; binary files are base64 encoded.
- The server does not install skills, write files, or execute scripts.
- Treat the directory as trusted server-side content. Checks are not a sandbox
  against an attacker concurrently replacing files on the server filesystem.

## Development

```sh
npm ci
npm run dev -- --check
npm run check
npm pack --dry-run
```

Tests cover recursive discovery, grouped duplicate names, malformed manifests,
live updates, supporting files, binary data, traversal, links, limits, actual
stdio connections, public OAuth discovery, introspection, credential revocation,
expiry, audience, issuer, scopes, provider failures, and HTTP request guards. Tests use AAA
(Arrange, Act, Assert). CI runs on Linux and Windows with Node.js 22 and 24.

See [CONTRIBUTING.md](CONTRIBUTING.md). The project and included example skills
are distributed under the [MIT license](LICENSE). Skills you add retain their
own licenses; publishing this server does not publish or relicense private skills.
