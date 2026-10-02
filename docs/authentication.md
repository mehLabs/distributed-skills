# Authentication

Distributed Skills is an OAuth resource server. An external identity provider
handles user login and token issuance; the MCP checks tokens using
[OAuth token introspection (RFC 7662)](https://www.rfc-editor.org/rfc/rfc7662).
Authentication is optional and disabled by default.

## Configuration

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

| Field | Purpose |
| --- | --- |
| `enabled` | Required boolean. Set to `false` for anonymous access; other fields may remain in the file. |
| `resourceUrl` | Required when enabled. Public MCP identifier and expected token audience, matched exactly. |
| `issuerUrl` | Required when enabled. OAuth issuer identifier and expected `iss`, matched exactly. |
| `loginUrl` | Required when enabled. Human-facing sign-in or credential acquisition page, discoverable by agents. |
| `validationUrl` | Required when enabled. Server-side token introspection endpoint, not exposed in discovery. |
| `scopes` | Required token scopes, all of which must be present; defaults to `[]`. |
| `validationClientIdEnv` / `validationClientSecretEnv` | Optional pair of environment variable names supplying the MCP's introspection client credentials. Both or neither must be configured. |
| `timeoutMs` | Introspection deadline, including response body. Defaults to 5000; range 100–30000. |

URLs require HTTPS; HTTP loopback URLs are allowed for local development. URLs
with embedded credentials or fragments are rejected. Resource and issuer URLs
also cannot contain query parameters. Unknown fields fail validation to catch
configuration typos. Store actual secrets in environment variables or a secret
manager, outside the skills directory.

Load with `--config PATH`, `SKILLS_MCP_CONFIG`, or the default
`skills-mcp.config.json` in the process working directory, in that order.
Relative paths use that directory. The default file is optional; an explicitly
selected file must exist. Invalid configuration fails startup rather than
falling back to anonymous access. `--check` validates the configuration syntax
and catalog locally; it does not contact the provider or test credentials.

Restart after changing configuration. To disable authentication, change only
`enabled` to `false`; retained provider settings do not trigger validation
requests or require introspection secrets. A loaded configuration takes
precedence over the legacy HTTP `SKILLS_MCP_TOKEN` environment variable.

## Discovering login

An agent can discover authentication without credentials through:

- The `get_auth_info` MCP tool and `skill://auth/info` resource.
- `GET /auth`, returning the same public information.
- OAuth protected-resource metadata at
  `GET /.well-known/oauth-protected-resource/mcp` for a resource URL ending in
  `/mcp`. The path includes the configured resource URL's path. The root
  `GET /.well-known/oauth-protected-resource` is also supported.
- `WWW-Authenticate` on a protected HTTP request rejected with `401` or `403`.

Example tool result:

```json
{
  "enabled": true,
  "mode": "oauth",
  "login_url": "https://identity.example.org/login",
  "resource_url": "https://skills.example.org/mcp",
  "issuer_url": "https://identity.example.org",
  "resource_metadata_url": "https://skills.example.org/.well-known/oauth-protected-resource/mcp",
  "scopes": ["skills:read"],
  "credential": { "type": "bearer", "header": "Authorization", "scheme": "Bearer" },
  "instructions": "..."
}
```

Initialization, ping, tool/resource definitions, and authentication discovery are
public in OAuth mode. They reveal only the server interface and sign-in
instructions. All catalog metadata, diagnostics, manifests, and supporting
files are protected, including `skill://catalog/index`.

The response advertises the issuer using
[OAuth protected-resource metadata (RFC 9728)](https://www.rfc-editor.org/rfc/rfc9728).
The issuer must publish OAuth authorization-server metadata or OIDC discovery
for the MCP client's supported flow, including its authorization and token
endpoints. The `loginUrl` is a human-facing fallback; it does not replace the
authorization endpoint advertised by the issuer. Configure a compatible client
registration mechanism, redirect URIs, scopes, and PKCE at your provider. Request
access tokens for `resourceUrl` using the provider's resource/audience mechanism.
See the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

The MCP client owns the browser login flow, stores the access token, and sends
`Authorization: Bearer <access-token>` on protected requests. Agents should
direct the user to that flow rather than ask for passwords or tokens in chat.
The MCP does not implement an authorization server, token exchange, refresh,
client registration, or a login UI. Hosts differ in their OAuth support.

Behind a reverse proxy, expose `/mcp`, `/auth`, and the advertised metadata path
through HTTPS, forward the Authorization header, and configure allowed Host
headers. `resourceUrl` is the public URL, not an internal proxy address.
Public discovery still uses the existing Host and Origin guards. `/health`
remains public and returns only process health.

## Introspection contract

For each protected request, the MCP sends:

```http
POST /oauth/introspect HTTP/1.1
Content-Type: application/x-www-form-urlencoded
Accept: application/json
Authorization: Basic <encoded introspection client credentials>

token=<url-encoded-access-token>&token_type_hint=access_token
```

The Basic header is included only if the two client environment variables are
configured. Its client ID and secret use the OAuth `client_secret_basic`
encoding. These are **server credentials**, distinct from each user's access
token. Providers requiring another introspection authentication method need
an adapter. Omitting this pair is intended for endpoints protected by another
server-side mechanism, such as a private development network.

Expected successful response:

```json
{
  "active": true,
  "iss": "https://identity.example.org",
  "aud": "https://skills.example.org/mcp",
  "exp": 1893456000,
  "scope": "skills:read",
  "sub": "employee-123"
}
```

This implementation requires `active`, `iss`, `aud`, and `exp` for active tokens,
even though several of those claims are optional in the general RFC 7662
response. Configure your provider's introspection response or an adapter to
include them. `aud` may be a string or array containing the exact resource URL.
`exp` must be an integer Unix timestamp in seconds, in the future. If present,
`nbf` must be an integer timestamp that is no later than the current time.
`scope` is a space-separated string; every configured scope is required. `sub`
is optional. Invalid or revoked credentials should return `{"active": false}`
with HTTP 200. Use an access token; an ID token is not a substitute.

The server does not cache introspection results, so subsequent reads reflect
revocation and expiry. It rejects redirects, limits responses to 64 KiB, and
uses the configured timeout. Provider failures, malformed responses, and
timeouts fail closed without exposing tokens or provider response details.

| HTTP status | Meaning |
| --- | --- |
| `401` | Missing, inactive, expired, wrong-issuer, or wrong-audience credential; sign in or renew credentials. |
| `403` | Active credential lacks required scopes. |
| `503` | Validation service failed, timed out, or returned an unusable response; includes `Retry-After: 5`. |

Auth error bodies include public login instructions. The introspection endpoint,
its client credentials, and user access tokens are not returned to the agent.
There is no per-user filtering: every authorized caller can read the same
configured skills directory.

## Stdio

Stdio has no HTTP OAuth challenge. With authentication enabled, the same tool
and resource expose login instructions, but the client must configure the
user's access token as `SKILLS_MCP_ACCESS_TOKEN` in the server process environment
and reconnect. Each skill read is then checked against the same introspection
contract. Missing or rejected tokens produce MCP errors; tool errors include
public authentication information. The MCP cannot modify its parent client's
environment or start a browser login automatically.

For shared remote deployments, prefer HTTP with a client supporting MCP OAuth.
For ordinary local directories, authentication can remain disabled.
