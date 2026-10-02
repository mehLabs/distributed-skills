import type { AuthenticationConfig } from './config.js';

export interface PublicAuthInfo {
  enabled: boolean;
  mode?: 'oauth' | 'shared-token';
  login_url?: string;
  resource_url?: string;
  issuer_url?: string;
  resource_metadata_url?: string;
  scopes?: string[];
  credential?: { type: 'bearer'; header: 'Authorization'; scheme: 'Bearer' };
  instructions?: string;
}

export class AuthenticationError extends Error {
  constructor(readonly status: 401 | 403 | 503, readonly code: string, message: string) {
    super(message);
  }
}

export interface Principal {
  subject?: string;
  scopes: string[];
  expiresAt: number;
}

export function bearerToken(header?: string): string | undefined {
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header ?? '');
  return match?.[0] === header ? match?.[1] : undefined;
}

export class Authentication {
  private readonly validationAuthorization?: string;

  constructor(readonly config: AuthenticationConfig, environment: NodeJS.ProcessEnv = process.env) {
    if (!config.enabled) return;
    if (config.validationClientIdEnv && config.validationClientSecretEnv) {
      const clientId = environment[config.validationClientIdEnv];
      const secret = environment[config.validationClientSecretEnv];
      if (!clientId || !secret) throw new Error('The configured validation client credentials are missing from the environment.');
      // OAuth client_secret_basic encodes each component before constructing Basic.
      const encode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
      this.validationAuthorization = `Basic ${Buffer.from(`${encode(clientId)}:${encode(secret)}`).toString('base64')}`;
    }
  }

  info(): PublicAuthInfo {
    const config = this.config;
    if (!config.enabled) return { enabled: false };
    return {
      enabled: true,
      mode: 'oauth',
      login_url: config.loginUrl,
      resource_url: config.resourceUrl,
      issuer_url: config.issuerUrl,
      resource_metadata_url: this.metadataUrl(),
      scopes: config.scopes,
      credential: { type: 'bearer', header: 'Authorization', scheme: 'Bearer' },
      instructions: 'Ask the user to sign in through the MCP client OAuth flow or the login URL. The client must store the access token and send it in the Authorization header. Do not request passwords or tokens in chat. For stdio, configure SKILLS_MCP_ACCESS_TOKEN in the server process environment and reconnect.',
    };
  }

  metadataPath(): string | undefined {
    if (!this.config.enabled) return undefined;
    const pathname = new URL(this.config.resourceUrl).pathname.replace(/\/$/, '');
    return `/.well-known/oauth-protected-resource${pathname}`;
  }

  metadataUrl(): string | undefined {
    if (!this.config.enabled) return undefined;
    return new URL(this.metadataPath()!, this.config.resourceUrl).href;
  }

  metadata() {
    if (!this.config.enabled) return undefined;
    return {
      resource: this.config.resourceUrl,
      authorization_servers: [this.config.issuerUrl],
      scopes_supported: this.config.scopes,
      bearer_methods_supported: ['header'],
      resource_name: 'Distributed Skills MCP',
    };
  }

  challenge(error?: AuthenticationError): string {
    if (!this.config.enabled) return 'Bearer';
    const fields = [`resource_metadata=${JSON.stringify(this.metadataUrl())}`];
    if (this.config.scopes.length) fields.push(`scope=${JSON.stringify(this.config.scopes.join(' '))}`);
    if (error?.status === 403) fields.push('error="insufficient_scope"');
    else if (error?.code === 'invalid_token') fields.push('error="invalid_token"');
    return `Bearer ${fields.join(', ')}`;
  }

  async verify(token?: string): Promise<Principal | undefined> {
    const config = this.config;
    if (!config.enabled) return undefined;
    if (!token) throw new AuthenticationError(401, 'authentication_required', 'Sign in to access shared skills.');
    try {
      const response = await fetch(config.validationUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          ...(this.validationAuthorization ? { authorization: this.validationAuthorization } : {}),
        },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Validation service rejected the request.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty validation response.');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 64 * 1024) throw new Error('Validation response too large.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid validation response.');
      const data = payload as Record<string, unknown>;
      if (typeof data.active !== 'boolean') throw new Error('Invalid validation response.');
      if (!data.active) throw new AuthenticationError(401, 'invalid_token', 'The credential is invalid or expired. Sign in again.');
      const audience = typeof data.aud === 'string' ? [data.aud] : data.aud;
      if (!Array.isArray(audience) || !audience.includes(config.resourceUrl) || data.iss !== config.issuerUrl ||
          typeof data.exp !== 'number' || !Number.isSafeInteger(data.exp) || data.exp <= Date.now() / 1000 ||
          (data.nbf !== undefined && (typeof data.nbf !== 'number' || !Number.isSafeInteger(data.nbf) || data.nbf > Date.now() / 1000))) {
        throw new AuthenticationError(401, 'invalid_token', 'The credential is expired or was not issued for this MCP server.');
      }
      if (data.scope !== undefined && typeof data.scope !== 'string') throw new Error('Invalid validation scopes.');
      const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [];
      if (config.scopes.some(scope => !scopes.includes(scope))) {
        throw new AuthenticationError(403, 'insufficient_scope', 'The credential lacks the required scopes.');
      }
      return { ...(typeof data.sub === 'string' ? { subject: data.sub } : {}), scopes, expiresAt: data.exp };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      // Never expose provider responses, request URLs, or credentials in errors.
      throw new AuthenticationError(503, 'validation_unavailable', 'Credential validation is temporarily unavailable.');
    }
  }
}
