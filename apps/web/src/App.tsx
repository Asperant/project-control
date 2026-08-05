import { useCallback, useEffect, useState } from 'react';
import type { AuthSessionResponse } from '@project-control/contracts';
import { ApiError, api, setCsrfToken } from './api-client';
import { LoginScreen } from './components/LoginScreen';
import { Dashboard } from './components/Dashboard';

type AppState =
  | { phase: 'checking' }
  | { phase: 'anonymous'; notice?: string }
  | { phase: 'unreachable'; message: string }
  | { phase: 'authenticated'; session: AuthSessionResponse };

/**
 * Root component and session lifecycle.
 *
 * On mount the panel asks `/api/auth/me`. Three outcomes are distinguished, and
 * the distinction matters operationally:
 *
 *   200        → an existing cookie is still valid; skip the login screen.
 *   401        → not signed in; show the login screen. This is normal, not an
 *                error, and must not look like one.
 *   unreachable→ Caddy or the API is down. Showing "invalid credentials" here
 *                would send the operator hunting for the wrong problem, so this
 *                gets its own screen naming the actual fault.
 */
export function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>({ phase: 'checking' });

  const checkSession = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const session = await api.me(signal);
      setState({ phase: 'authenticated', session });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;

      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) {
          setState({ phase: 'anonymous' });
          return;
        }
        if (caught.isConnectivityFailure) {
          setState({ phase: 'unreachable', message: caught.message });
          return;
        }
        setState({ phase: 'unreachable', message: caught.message });
        return;
      }
      setState({ phase: 'unreachable', message: 'Unable to contact the Control API.' });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    return () => controller.abort();
  }, [checkSession]);

  const handleSignedOut = useCallback(() => {
    setCsrfToken(null);
    setState({ phase: 'anonymous', notice: 'You have been signed out.' });
  }, []);

  const handleSessionExpired = useCallback(() => {
    setCsrfToken(null);
    setState({
      phase: 'anonymous',
      notice: 'Your session expired. Please sign in again.',
    });
  }, []);

  switch (state.phase) {
    case 'checking':
      return (
        <div className="login-wrap">
          <main className="login-card">
            <h1>Project Control</h1>
            <p className="subtitle" role="status">Checking your session…</p>
          </main>
        </div>
      );

    case 'unreachable':
      return (
        <div className="login-wrap">
          <main className="login-card">
            <h1>Backend unreachable</h1>
            <div className="alert alert-error" role="alert">{state.message}</div>
            <p className="hint">
              The browser reached this page, so Caddy is serving static assets, but the Control API
              did not answer. On the host, check:
            </p>
            <p className="hint">
              <code>./pcctl status</code> · <code>./pcctl health</code> ·{' '}
              <code>./pcctl logs control-api</code>
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setState({ phase: 'checking' });
                void checkSession();
              }}
            >
              Retry
            </button>
          </main>
        </div>
      );

    case 'anonymous':
      return (
        <>
          {state.notice && (
            <div className="login-wrap" style={{ minHeight: 'auto', paddingBottom: 0 }}>
              <div className="login-card alert alert-warn" role="status">{state.notice}</div>
            </div>
          )}
          <LoginScreen
            onAuthenticated={(session) => setState({ phase: 'authenticated', session })}
          />
        </>
      );

    case 'authenticated':
      return (
        <Dashboard
          session={state.session}
          onSignedOut={handleSignedOut}
          onSessionExpired={handleSessionExpired}
        />
      );
  }
}
