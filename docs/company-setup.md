# Using Distributed Skills at your company

Run a single MCP server, add your company's skills to a folder, and connect your
employees' agents to its URL. Sign-in is optional. Organize skills by team or
area, with as many nested folders as you need.

This guide uses HTTP to share one server across employees. You need Node.js 22
or later, npm, and a machine that the clients can reach. The project is MIT
licensed and can be used commercially.

## 1. Install

Clone this repository and enter its directory, or download it from GitHub and
open a terminal in the downloaded directory:

```sh
git clone https://github.com/mehLabs/distributed-skills.git
cd distributed-skills
npm ci
npm run build
```

Run the following commands from that same directory. Installation uses the
repository; it does not require a package published to npm.

## 2. Add your company's skills

Use the repository's `skills/` directory or a directory of your own. Each skill
needs its own folder containing a file named **`SKILL.md`**, with that exact
capitalization.

```text
skills/
└── company/
    ├── engineering/
    │   └── code-review/
    │       ├── SKILL.md
    │       └── references/
    │           └── checklist.md
    └── support/
        └── incident-response/
            ├── SKILL.md
            └── assets/
                └── template.md
```

Grouping folders, such as `company/` or `engineering/`, do not need a `SKILL.md`.
The MCP discovers skills **recursively**, including skills nested inside other
skills. The examples already included in `skills/` are also served if you use
that directory.

To create your first skill, save the following content to
`skills/company/engineering/code-review/SKILL.md`:

```markdown
---
name: code-review
description: Review code changes when the user asks to evaluate a patch or pull request.
---

Review the changes for behavior errors and regressions.
Explain each issue with a concrete example and its impact.
If you find no issues, describe what you checked and what remains unverified.
```

Both frontmatter fields are required:

| Field | What to provide |
| --- | --- |
| `name` | A name of 1–64 characters using lowercase ASCII letters, digits, and hyphens. Use the same name as the skill folder, with no leading, trailing, or consecutive hyphens. |
| `description` | When the agent should use the skill. Between 1 and 1024 characters. |

Write the instructions below the frontmatter in whichever language you prefer.
To add supporting material, place files inside the skill folder and reference
them from the instructions, for example:

```markdown
Before completing the review, read [the checklist](references/checklist.md).
```

This skill's ID is `company/engineering/code-review`. The agent uses that ID to
read its instructions and files. Two teams can have skills with the same name
if their paths differ.

Users with catalog access can read every file inside a skill, so store only
material you intend to share there. Each file is limited to 1 MiB. Symbolic
links and the `.git`, `node_modules`, and `.cache` directories are excluded.
The MCP serves files; included scripts are not executed on the server.

Validate the directory before starting the server:

```sh
node dist/cli.js --skills-dir ./skills --check
```

The output lists skills and their `diagnostics`. If a skill has invalid
frontmatter, fix the indicated file. The command exits with code 1 when there
are diagnostics. An empty directory is valid.

## 3. Start the MCP without sign-in

Copy [skills-mcp.config.example.json](../skills-mcp.config.example.json) to
`skills-mcp.config.json` at the repository root. Its content is:

```json
{
  "authentication": {
    "enabled": false
  }
}
```

Start the server:

```sh
node dist/cli.js --transport http --config ./skills-mcp.config.json --skills-dir ./skills --port 3000
```

The local URL is **`http://127.0.0.1:3000/mcp`**. Keep the process running; stop
it with `Ctrl+C`. With `enabled: false`, any client that can reach the server
and passes the Host restrictions can read the skills.

### Share it with other machines

To accept connections from other machines, change the listening address and
allow the hostname that clients or the proxy will use to access the server:

```sh
node dist/cli.js --transport http --config ./skills-mcp.config.json --skills-dir ./skills --host 0.0.0.0 --port 3000 --allowed-hosts skills.example.org,localhost,127.0.0.1
```

Replace `skills.example.org` with your company's domain. If employees connect
directly using an IP address, add that IP to `--allowed-hosts` as well. This
option accepts comma-separated hostnames or IP addresses, without a protocol
or port.

Deploy using your company's usual infrastructure: a service that keeps the
process running and, for remote access, a proxy with HTTPS. With that domain,
employees connect to **`https://skills.example.org/mcp`**. The command above
starts the HTTP server; configure the domain, HTTPS certificate, and proxy in
your infrastructure.

## 4. Configure optional sign-in

To enable authentication, replace `skills-mcp.config.json` with the content of
[examples/config/auth.enabled.json](../examples/config/auth.enabled.json) and
fill in your OAuth provider's URLs:

```json
{
  "authentication": {
    "enabled": true,
    "resourceUrl": "https://skills.example.org/mcp",
    "issuerUrl": "https://identity.example.org",
    "loginUrl": "https://identity.example.org/login",
    "validationUrl": "https://identity.example.org/oauth/introspect",
    "scopes": ["skills:read"],
    "validationClientIdEnv": "SKILLS_AUTH_CLIENT_ID",
    "validationClientSecretEnv": "SKILLS_AUTH_CLIENT_SECRET",
    "timeoutMs": 5000
  }
}
```

| Option | Value you need |
| --- | --- |
| `resourceUrl` | This MCP's public URL. It must also be the token audience. |
| `issuerUrl` | The identifier of the OAuth provider that issues the tokens. |
| `loginUrl` | The page where employees can sign in or obtain credentials. |
| `validationUrl` | The introspection endpoint that checks tokens. |
| `scopes` | Permissions required to read skills. Use `[]` if no scopes are required. |
| `validationClientIdEnv` / `validationClientSecretEnv` | Names of the environment variables containing the server's introspection client credentials. |

URLs belong in the JSON file; credentials belong in environment variables.
Using the names above, set these two variables in the MCP process environment:

Linux/macOS, using bash:

```sh
export SKILLS_AUTH_CLIENT_ID='introspection-client-id'
export SKILLS_AUTH_CLIENT_SECRET='introspection-client-secret'
```

Windows, using PowerShell:

```powershell
$env:SKILLS_AUTH_CLIENT_ID = 'introspection-client-id'
$env:SKILLS_AUTH_CLIENT_SECRET = 'introspection-client-secret'
```

For a permanent deployment, inject these values through the service or secret
manager that starts the MCP. The server **does not load `.env` files
automatically**. These are server credentials; each employee obtains their own
access token by signing in through their MCP client.

Restart the server using the same command from the previous section. The agent
can call `get_auth_info` without credentials to discover sign-in instructions.
The MCP client manages the session and sends the token when reading skills.
Employees do not need to share their credentials with the agent in chat.

The OAuth provider must support a flow compatible with the MCP client and an
introspection response containing `active`, `iss`, `aud`, `exp`, and the required
scopes. The MCP uses that existing provider for sign-in and token issuance.
The [authentication documentation](authentication.md) describes the full
contract, provider configuration, and endpoints the proxy must expose: `/mcp`,
`/auth`, and the OAuth metadata advertised by the server.

To disable sign-in, change only `enabled` to `false` and restart. You can retain
the URLs and remove the credential environment variables. All authorized users
share the same catalog; there is no per-employee filtering.

## 5. Connect employees' agents

In each tool that supports MCP over **Streamable HTTP**, add a server with
these settings:

| Setting | Value |
| --- | --- |
| Name | `distributed-skills`, or a name of your choice. |
| Transport | Streamable HTTP. |
| URL | `https://skills.example.org/mcp`, replacing the domain. To try it on the same machine, use `http://127.0.0.1:3000/mcp`. |
| Authentication | No credentials when disabled; the client's OAuth flow when enabled. |

The location and format of this configuration depend on the tool. For OAuth,
use a client that supports MCP authentication. Employees connect to the same
server; they do not need to install or run the repository.

To check the connection, ask the agent:

> Call `get_auth_info`, then list the available skills with `list_skills`.
> If necessary, tell me how to sign in through the client.

The agent can then search for and read a skill:

```text
search_skills({"query":"review"})
get_skill({"id":"company/engineering/code-review"})
```

### Consult skills when starting a task

For a reusable entry skill for employees, copy the
[examples/discover-shared-skills](../examples/discover-shared-skills) directory
to a skill location supported by their tool. You can also add this persistent
instruction to the client:

> Before starting a work task, consult the distributed-skills MCP, discover
> whether sign-in is required, and read the applicable skills before acting.

Configure the MCP connection separately. Automatic skill selection depends on
the agent and its tool; reading remote instructions does not install them as
local skills.

## 6. Update and check the service

Add, edit, or remove folders and files inside the skills root. Changes appear
on the next query **without restarting the MCP**. Moving a skill changes its
ID. To use a different root, change `--skills-dir` and restart.

You can use a directory outside the repository to keep internal skills
separate, for example:

```sh
node dist/cli.js --transport http --config ./skills-mcp.config.json --skills-dir /srv/company-skills
```

On Windows, use a path such as `C:/Company/Skills`. Quote paths containing
spaces. You can also set the `SKILLS_DIR` environment variable; `--skills-dir`
takes precedence. For the configuration file, use `SKILLS_MCP_CONFIG`;
`--config` takes precedence. Relative paths are resolved against the process
working directory.

To check the process and public sign-in information from the server machine:

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/auth
```

On Windows, use `curl.exe` if needed. `/health` returns `{"status":"ok"}`;
`/auth` indicates whether sign-in is enabled and how to proceed. To check the
skills themselves, run `--check` with their directory or call `list_skills`
from an MCP client. The `/mcp` endpoint uses the MCP protocol; opening it as a
web page does not verify that the connection works.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| A skill is missing | A file named exactly `SKILL.md`, valid `name` and `description` frontmatter, and a folder inside the served root. Run `--check` for diagnostics. |
| Cannot read the configuration | Check the `--config` path and confirm that the file contains valid JSON. An explicitly selected file must exist. |
| Cannot connect from another machine | Listening address (`--host`), port, firewall, proxy, and domain. `127.0.0.1` accepts only local connections. |
| HTTP 401 when reading skills | Sign in through the client. If already signed in, check token expiry and confirm that its issuer and audience match the JSON configuration. |
| HTTP 403 for Host or Origin | Allow the hostname sent by the client or proxy. For browser clients, check `SKILLS_MCP_ALLOWED_ORIGINS` and the gateway's CORS settings, as described in the [README](../README.md#share-one-http-server). |
| HTTP 403 for scopes | The token must include every configured scope. |
| HTTP 503 when validating credentials | Check the availability and response of `validationUrl`, the timeout, and the server's introspection credentials. |
| Missing credentials at startup | Set both variables named in `validationClientIdEnv` and `validationClientSecretEnv` in the process environment. |

For other connection modes, available tools, and catalog details, see the
[README](../README.md). For identity provider integration, see
[Authentication](authentication.md).
