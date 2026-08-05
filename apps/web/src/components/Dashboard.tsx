import { useCallback, useEffect, useState } from 'react';
import type {
  ArtifactSelfTestResponse,
  AuthSessionResponse,
  SystemStatusResponse,
} from '@project-control/contracts';
import { ApiError, api } from '../api-client';
import { StatusBadge } from './StatusBadge';

const POLL_INTERVAL_MS = 15_000;

/**
 * System health dashboard.
 *
 * Stage 1 scope: render one card per subsystem, show session details, run the
 * artifact self-test on demand, and sign out. No project management UI — that is
 * explicitly a later stage.
 */
export function Dashboard({
  session,
  onSignedOut,
  onSessionExpired,
}: {
  session: AuthSessionResponse;
  onSignedOut: () => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selfTest, setSelfTest] = useState<ArtifactSelfTestResponse | null>(null);
  const [selfTestError, setSelfTestError] = useState<string | null>(null);
  const [selfTestBusy, setSelfTestBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const next = await api.systemStatus(signal);
        setStatus(next);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof ApiError) {
          // An expired session must bounce the user to the login screen rather
          // than leaving a dashboard that silently stops updating.
          if (caught.isAuthFailure) {
            onSessionExpired();
            return;
          }
          setError(caught.message);
        } else {
          setError('Unable to load system status.');
        }
      } finally {
        setLoading(false);
      }
    },
    [onSessionExpired],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);

    const timer = setInterval(() => {
      // Polling pauses while the tab is hidden: a backgrounded dashboard hitting
      // the API every 15 s for hours is pure waste.
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  async function handleSelfTest(): Promise<void> {
    setSelfTestBusy(true);
    setSelfTestError(null);
    try {
      setSelfTest(await api.artifactSelfTest());
      void refresh();
    } catch (caught) {
      setSelfTest(null);
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) {
          onSessionExpired();
          return;
        }
        setSelfTestError(caught.message);
      } else {
        setSelfTestError('The self-test could not be started.');
      }
    } finally {
      setSelfTestBusy(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await api.logout();
    } finally {
      onSignedOut();
    }
  }

  const expires = new Date(session.session.expiresAt);

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>

      <header className="app-header">
        <h1>Project Control</h1>
        {status && <StatusBadge status={status.overall} />}

        <div className="spacer" />

        <div className="session-info">
          <span>
            Signed in as <strong>{session.user.displayName}</strong> ({session.user.role})
          </span>
          <span title={expires.toISOString()}>
            Session expires {expires.toLocaleString()}
          </span>
          <button type="button" onClick={() => void handleSignOut()} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <main id="main-content">
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
            <p className="hint">
              The panel keeps retrying every {POLL_INTERVAL_MS / 1000} s. If this persists, run{' '}
              <code>./pcctl health</code> on the host.
            </p>
          </div>
        )}

        <section aria-labelledby="components-heading">
          <h2 id="components-heading">System components</h2>

          {loading && !status && <p>Loading system status…</p>}

          {status && (
            <>
              <div className="card-grid">
                {status.components.map((component) => (
                  <article key={component.id} className="card">
                    <div className="card-head">
                      <span className="card-title">{component.label}</span>
                      <StatusBadge status={component.status} />
                    </div>
                    <p className="card-detail">{component.detail}</p>
                    <span className="card-meta">
                      {component.latencyMs !== undefined ? `${component.latencyMs} ms · ` : ''}
                      {new Date(component.checkedAt).toLocaleTimeString()}
                    </span>
                  </article>
                ))}
              </div>
              <p className="hint">
                Stack {status.stackVersion} · {status.environment} · refreshed{' '}
                {new Date(status.generatedAt).toLocaleTimeString()}
              </p>
            </>
          )}
        </section>

        <section aria-labelledby="selftest-heading">
          <h2 id="selftest-heading">Artifact store self-test</h2>

          <article className="card">
            <p className="card-detail">
              Writes a random payload through the real storage path, verifies the SHA-256 round
              trip, proves deduplication, and confirms that path-traversal and size limits are
              enforced.
            </p>

            <div>
              <button
                type="button"
                className="primary"
                onClick={() => void handleSelfTest()}
                disabled={selfTestBusy}
              >
                {selfTestBusy ? 'Running…' : 'Run self-test'}
              </button>
            </div>

            {selfTestError && (
              <div className="alert alert-error" role="alert">{selfTestError}</div>
            )}

            {selfTest && (
              <div role="status">
                <div className={`alert ${selfTest.ok ? 'alert-ok' : 'alert-error'}`}>
                  {selfTest.ok
                    ? `Passed in ${selfTest.totalDurationMs} ms — ${selfTest.sizeBytes} bytes stored`
                    : 'Self-test failed. See the step list below.'}
                </div>
                <p className="card-meta">
                  sha256 <code>{selfTest.sha256}</code>
                </p>
                <ul className="steps">
                  {selfTest.steps.map((step) => (
                    <li key={step.step}>
                      <StatusBadge status={step.ok ? 'ok' : 'down'} />
                      <span className="step-name">{step.step}</span>
                      {!step.ok && <span>{step.detail}</span>}
                      <span className="step-time">{step.durationMs} ms</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        </section>

        <section aria-labelledby="session-heading">
          <h2 id="session-heading">Session</h2>
          <div className="card-grid">
            <article className="card">
              <span className="card-title">Account</span>
              <p className="card-detail">{session.user.email}</p>
              <span className="card-meta">role: {session.user.role}</span>
            </article>
            <article className="card">
              <span className="card-title">Idle timeout</span>
              <p className="card-detail">
                {Math.round(session.session.idleTimeoutSeconds / 60)} minutes of inactivity ends
                this session.
              </p>
              <span className="card-meta">session {session.session.id.slice(0, 8)}…</span>
            </article>
            <article className="card">
              <span className="card-title">Last sign-in</span>
              <p className="card-detail">
                {session.user.lastLoginAt
                  ? new Date(session.user.lastLoginAt).toLocaleString()
                  : 'This is the first sign-in for this account.'}
              </p>
            </article>
          </div>
        </section>
      </main>
    </>
  );
}
