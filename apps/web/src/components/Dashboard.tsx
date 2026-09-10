import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type {
  ArtifactSelfTestResponse,
  AuthSessionResponse,
  SystemStatusResponse,
} from '@project-control/contracts';
import { ApiError, api } from '../api-client';
import { StatusBadge } from './StatusBadge';
import { ErrorAlert } from './ErrorAlert';
import { useApiErrorHandler } from '../hooks/useApiErrorHandler';
import { ProjectsRoot } from './projects/ProjectsRoot';
import { ProjectSwitcher } from './projects/ProjectSwitcher';
import { AutomationView } from './automation/AutomationView';
import { GlobalSearch } from './search/GlobalSearch';
import { GlobalTimelineView } from './timeline/GlobalTimelineView';

const POLL_INTERVAL_MS = 15_000;

/**
 * Per-route `document.title` for screen readers and browser tabs alike. Kept
 * to a per-section title rather than plumbing project names through here —
 * see the route-change effect below for why per-project titles aren't worth
 * the extra wiring.
 */
function titleForPath(pathname: string): string {
  const section =
    pathname.startsWith('/timeline') ? 'Activity'
    : pathname.startsWith('/automation') ? 'Automation'
    : pathname.startsWith('/system') ? 'System'
    : pathname.startsWith('/projects/new') ? 'New Project'
    : /^\/projects\/[^/]+\/rescan/.test(pathname) ? 'Rescan'
    : /^\/projects\/[^/]+\/roadmap/.test(pathname) ? 'Roadmap'
    : /^\/projects\/[^/]+\/memory/.test(pathname) ? 'Memory'
    : /^\/projects\/[^/]+\/agent-runs/.test(pathname) ? 'Agent Runs'
    : /^\/projects\/[^/]+\/resume/.test(pathname) ? 'Resume'
    : /^\/projects\/[^/]+\/development/.test(pathname) ? 'Development'
    : /^\/projects\/[^/]+\/timeline/.test(pathname) ? 'Project Timeline'
    : /^\/projects\/[^/]+/.test(pathname) ? 'Project'
    : pathname.startsWith('/projects') ? 'Projects'
    : null;
  return section ? `Project Control — ${section}` : 'Project Control';
}

const TOP_TABS = [
  { path: '/projects', label: 'Projects' },
  { path: '/timeline', label: 'Activity' },
  { path: '/automation', label: 'Automation' },
  { path: '/system', label: 'System' },
] as const;

/**
 * Panel shell: real routes for every top-level section (see main.tsx's
 * BrowserRouter), plus session details, project switcher, global search, and
 * sign-out in the header.
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
  const location = useLocation();
  const canWriteProjects = session.user.role === 'admin' || session.user.role === 'operator';
  const canWriteAutomation = session.user.role === 'admin' || session.user.role === 'operator';
  const isAdmin = session.user.role === 'admin';

  // Client-side routing swaps whole screens without a page load, which gives
  // a screen-reader user no signal that anything changed. Set a per-route
  // title and move focus to the main region on every navigation — but not
  // on first mount, where that would steal focus from wherever the browser
  // naturally put it.
  const isFirstRender = useRef(true);
  useEffect(() => {
    document.title = titleForPath(location.pathname);
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    document.getElementById('main-content')?.focus();
  }, [location.pathname]);

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>

      <header className="app-header">
        <h1>Project Control</h1>

        <nav className="tab-nav" aria-label="Sections">
          {TOP_TABS.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={location.pathname.startsWith(item.path) ? 'tab-active' : ''}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <GlobalSearch onSessionExpired={onSessionExpired} />
        <ProjectSwitcher />

        <div className="spacer" />

        <div className="session-info">
          <span>
            Signed in as <strong>{session.user.displayName}</strong> ({session.user.role})
          </span>
          <SignOutButton onSignedOut={onSignedOut} />
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects/*" element={<ProjectsRoot canWrite={canWriteProjects} onSessionExpired={onSessionExpired} />} />
          <Route path="/timeline" element={<GlobalTimelineView onSessionExpired={onSessionExpired} />} />
          <Route path="/automation" element={<AutomationView isAdmin={isAdmin} canWrite={canWriteAutomation} onSessionExpired={onSessionExpired} />} />
          <Route path="/system" element={<SystemPanel session={session} onSessionExpired={onSessionExpired} />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </main>
    </>
  );
}

function SignOutButton({ onSignedOut }: { onSignedOut: () => void }): React.JSX.Element {
  const [signingOut, setSigningOut] = useState(false);
  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await api.logout();
    } finally {
      onSignedOut();
    }
  }
  return (
    <button type="button" onClick={() => void handleSignOut()} disabled={signingOut}>
      {signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

/** The original Stage 1 system-health view, unchanged apart from losing its own header/sign-out (now shared above). */
function SystemPanel({
  session,
  onSessionExpired,
}: {
  session: AuthSessionResponse;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const { error, setError, handleError } = useApiErrorHandler(onSessionExpired, 'Unable to load system status.');
  const [loading, setLoading] = useState(true);
  const [selfTest, setSelfTest] = useState<ArtifactSelfTestResponse | null>(null);
  const [selfTestError, setSelfTestError] = useState<string | null>(null);
  const [selfTestRequestId, setSelfTestRequestId] = useState<string | null>(null);
  const [selfTestBusy, setSelfTestBusy] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const next = await api.systemStatus(signal);
        setStatus(next);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        // An expired session must bounce the user to the login screen rather
        // than leaving a dashboard that silently stops updating.
        handleError(caught);
      } finally {
        setLoading(false);
      }
    },
    [handleError, setError],
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
    setSelfTestRequestId(null);
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
        setSelfTestRequestId(caught.requestId ?? null);
      } else {
        setSelfTestError('The self-test could not be started.');
      }
    } finally {
      setSelfTestBusy(false);
    }
  }

  const expires = new Date(session.session.expiresAt);

  return (
    <>
      {status && (
        <p className="hint" style={{ margin: '0 0 1rem' }}>
          Overall status: <StatusBadge status={status.overall} /> · session expires{' '}
          <span title={expires.toISOString()}>{expires.toLocaleString()}</span>
        </p>
      )}

      {error && (
          <div className="alert alert-error" role="alert">
            {error.message}
            {error.requestId && (
              <p className="hint">
                Request ID: <code>{error.requestId}</code>
              </p>
            )}
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

            <ErrorAlert error={selfTestError} requestId={selfTestRequestId} />

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
    </>
  );
}
