import {
  artifactSelfTestResponseSchema,
  authSessionResponseSchema,
  errorResponseSchema,
  logoutResponseSchema,
  systemStatusResponseSchema,
  type ArtifactSelfTestResponse,
  type AuthSessionResponse,
  type ErrorCode,
  type SystemStatusResponse,
} from '@project-control/contracts';

/**
 * Control API client.
 *
 * Everything goes through `/api`, a same-origin path that Caddy proxies. There
 * is no configurable base URL and no cross-origin request anywhere in the panel:
 * the browser only ever talks to the host it loaded the page from, which is what
 * lets the session cookie be `SameSite=Strict`.
 *
 * Responses are parsed with the shared contract schemas rather than cast. A
 * backend that returns an unexpected shape produces a clean error here instead
 * of an undefined-property crash three components deep.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network_error' | 'malformed_response',
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the user needs to sign in again. */
  get isAuthFailure(): boolean {
    return this.code === 'unauthorized';
  }

  /** True when the API could not be reached at all (Caddy or API down). */
  get isConnectivityFailure(): boolean {
    return this.code === 'network_error' || this.code === 'service_unavailable';
  }
}

/**
 * The CSRF token lives in a module variable, not localStorage or sessionStorage.
 *
 * Web storage is readable by any script on the origin, which would hand the
 * token to an XSS payload — exactly the attack the token is meant to survive.
 * Keeping it in memory means a page reload loses it, so the panel re-fetches it
 * from `/api/auth/me` on mount.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
};

async function request<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  // Only state-changing requests carry the token; sending it on GETs would put
  // it in more places than necessary for no benefit.
  if (method !== 'GET' && csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      // Required for the session cookie on same-origin requests when the
      // request is issued by fetch rather than by navigation.
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      'network_error',
      'Cannot reach the Control API. The backend may be starting, stopped, or unreachable through Caddy.',
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      'malformed_response',
      `The server returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
        parsed.data.requestId,
      );
    }
    throw new ApiError(
      'malformed_response',
      `Request failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  try {
    return schema.parse(payload);
  } catch {
    throw new ApiError(
      'malformed_response',
      'The server response did not match the expected shape.',
      response.status,
    );
  }
}

export const api = {
  async login(email: string, password: string): Promise<AuthSessionResponse> {
    const session = await request('/api/auth/login', authSessionResponseSchema, {
      method: 'POST',
      body: { email, password },
    });
    setCsrfToken(session.csrfToken);
    return session;
  },

  async me(signal?: AbortSignal): Promise<AuthSessionResponse> {
    const session = await request(
      '/api/auth/me',
      authSessionResponseSchema,
      signal ? { signal } : {},
    );
    // `/me` mints a fresh CSRF token on every call, which is how the panel
    // recovers a usable token after a reload.
    setCsrfToken(session.csrfToken);
    return session;
  },

  async logout(): Promise<void> {
    try {
      await request('/api/auth/logout', logoutResponseSchema, { method: 'POST' });
    } finally {
      // The local token is discarded even if the server call failed, so the UI
      // cannot be left believing it still holds a valid session.
      setCsrfToken(null);
    }
  },

  systemStatus(signal?: AbortSignal): Promise<SystemStatusResponse> {
    return request('/api/system/status', systemStatusResponseSchema, signal ? { signal } : {});
  },

  artifactSelfTest(): Promise<ArtifactSelfTestResponse> {
    return request('/api/artifacts/self-test', artifactSelfTestResponseSchema, { method: 'POST' });
  },
};
