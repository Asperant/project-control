import { useId, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api-client';
import type { AuthSessionResponse } from '@project-control/contracts';

/**
 * Login screen.
 *
 * The form posts credentials and nothing else; it never stores the password,
 * never retries automatically, and shows the server's own generic failure
 * message rather than inventing a more specific one (which would undo the
 * server's deliberate refusal to distinguish "no such user" from "wrong
 * password").
 */
export function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (session: AuthSessionResponse) => void;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [connectivityIssue, setConnectivityIssue] = useState(false);
  const [busy, setBusy] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    setRequestId(null);
    setConnectivityIssue(false);

    try {
      const session = await api.login(email, password);
      // Clear the password from component state the moment it is no longer
      // needed, so it does not sit in a React fibre for the rest of the session.
      setPassword('');
      onAuthenticated(session);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setConnectivityIssue(caught.isConnectivityFailure);
        setError(caught.message);
        setRequestId(caught.requestId ?? null);
      } else {
        setError('An unexpected error occurred.');
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <main className="login-card">
        <h1>Project Control</h1>
        <p className="subtitle">Sign in to the operator panel.</p>

        {error && (
          <div
            id={errorId}
            className={`alert ${connectivityIssue ? 'alert-warn' : 'alert-error'}`}
            role="alert"
          >
            {error}
            {requestId && (
              <p className="hint">
                Request ID: <code>{requestId}</code>
              </p>
            )}
            {connectivityIssue && (
              <p className="hint">
                Check the stack with <code>./pcctl status</code> on the host.
              </p>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor={emailId}>Email address</label>
            <input
              id={emailId}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              required
              autoFocus
              disabled={busy}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? errorId : undefined}
            />
          </div>

          <div className="field">
            <label htmlFor={passwordId}>Password</label>
            <input
              id={passwordId}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={error ? errorId : undefined}
            />
          </div>

          <button type="submit" className="primary" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="hint">
          Accounts are created only on the host with <code>./pcctl create-admin</code>. There is no
          self-service registration and no default account.
        </p>
      </main>
    </div>
  );
}
