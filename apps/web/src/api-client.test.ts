import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, getCsrfToken, setCsrfToken } from './api-client';

/**
 * These tests pin down the client's security-relevant behaviour: which headers
 * go out, where the CSRF token is kept, and how failures are classified. They
 * stub `fetch` rather than running a browser, because the assertions are about
 * the request the client constructs.
 */

const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });

const validSession = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'admin@example.com',
    displayName: 'Admin',
    role: 'admin',
    createdAt: '2026-08-04T10:00:00.000Z',
    lastLoginAt: null,
  },
  session: {
    id: '00000000-0000-4000-8000-000000000002',
    createdAt: '2026-08-04T10:00:00.000Z',
    expiresAt: '2026-08-04T22:00:00.000Z',
    idleTimeoutSeconds: 3600,
  },
  csrfToken: 'c'.repeat(43),
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Awaits a request that must reject, and returns the ApiError it threw. */
async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setCsrfToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('request construction', () => {
  it('sends credentials same-origin so the session cookie is attached', async () => {
    fetchMock.mockResolvedValue(jsonResponse(validSession));
    await api.me();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('same-origin');
  });

  it('uses a relative /api path, never an absolute cross-origin URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(validSession));
    await api.me();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('/api/')).toBe(true);
    expect(url).not.toMatch(/^https?:/);
  });

  it('refuses to follow redirects', async () => {
    fetchMock.mockResolvedValue(jsonResponse(validSession));
    await api.me();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
  });

  it('does not cache responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse(validSession));
    await api.me();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });
});

describe('CSRF token handling', () => {
  it('stores the token from a login response in memory only', async () => {
    fetchMock.mockResolvedValue(jsonResponse(validSession));
    await api.login('admin@example.com', 'a-password-value');

    expect(getCsrfToken()).toBe(validSession.csrfToken);
    // Web storage must not be touched: it is readable by any script on the page.
    expect(globalThis.localStorage?.getItem?.('csrfToken') ?? null).toBeNull();
  });

  it('sends the token on state-changing requests', async () => {
    fetchMock.mockResolvedValue(jsonResponse(validSession));
    await api.login('admin@example.com', 'a-password-value');

    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        deduplicated: false,
        steps: [],
        totalDurationMs: 5,
      }),
    );
    await api.artifactSelfTest();

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe(validSession.csrfToken);
  });

  it('does not send the token on GET requests', async () => {
    setCsrfToken('t'.repeat(43));
    fetchMock.mockResolvedValue(
      jsonResponse({
        stackVersion: '1.0.0',
        environment: 'production',
        generatedAt: '2026-08-04T12:00:00.000Z',
        overall: 'ok',
        components: [],
      }),
    );
    await api.systemStatus();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('clears the token on logout even when the server call fails', async () => {
    setCsrfToken('t'.repeat(43));
    fetchMock.mockRejectedValue(new TypeError('network down'));

    await expect(api.logout()).rejects.toBeInstanceOf(ApiError);
    expect(getCsrfToken()).toBeNull();
  });

  it('refreshes the token from /api/auth/me', async () => {
    const rotated = { ...validSession, csrfToken: 'r'.repeat(43) };
    fetchMock.mockResolvedValue(jsonResponse(rotated));

    await api.me();
    expect(getCsrfToken()).toBe('r'.repeat(43));
  });
});

describe('error classification', () => {
  it('classifies a transport failure as a connectivity problem, not an auth failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await captureError(api.me());
    expect(error).toBeInstanceOf(ApiError);
    expect(error.isConnectivityFailure).toBe(true);
    expect(error.isAuthFailure).toBe(false);
  });

  it('classifies a 401 as an auth failure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'unauthorized', message: 'Session is invalid.' }, requestId: 'req_abc12345' },
        { status: 401 },
      ),
    );

    const error = await captureError(api.me());
    expect(error.isAuthFailure).toBe(true);
    expect(error.isConnectivityFailure).toBe(false);
    expect(error.requestId).toBe('req_abc12345');
  });

  it('surfaces the server message verbatim for a failed login', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: { code: 'unauthorized', message: 'Invalid email or password.' },
          requestId: 'req_abc12345',
        },
        { status: 401 },
      ),
    );

    const error = await captureError(api.login('a@b.co', 'wrong-password'));
    expect(error.message).toBe('Invalid email or password.');
  });

  it('reports a rate-limit response distinctly', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'rate_limited', message: 'Too many requests. Retry in 60 s.' }, requestId: 'req_abc12345' },
        { status: 429 },
      ),
    );

    const error = await captureError(api.login('a@b.co', 'x'));
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
  });

  it('rejects a well-formed HTTP 200 whose body does not match the contract', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unexpected: 'shape' }));

    const error = await captureError(api.me());
    expect(error.code).toBe('malformed_response');
  });

  it('rejects a non-JSON response', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>gateway error</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const error = await captureError(api.me());
    expect(error.code).toBe('malformed_response');
    expect(error.status).toBe(502);
  });
});
