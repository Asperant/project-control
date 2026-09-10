import { useCallback, useEffect, useState } from 'react';
import type { ServiceTokenSummary } from '@project-control/contracts';
import { ApiError, api } from '../../api-client';

const formatTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : 'never');

/**
 * Service token administration: list and revoke, both human-only.
 *
 * There is deliberately no "create" button — a token is minted only by
 * `sudo ./pcctl create-service-token`, at a host terminal, because its
 * plaintext exists exactly once and a browser is not a safe place for it to
 * exist even momentarily. See docs/service-accounts.md.
 */
export function ServiceTokensPanel({ onSessionExpired }: { onSessionExpired: () => void }): React.JSX.Element {
  const [tokens, setTokens] = useState<ServiceTokenSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await api.listServiceTokens(signal);
      setTokens(response.tokens);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) { onSessionExpired(); return; }
        setError(caught.message);
      } else {
        setError('Unable to load service tokens.');
      }
    }
  }, [onSessionExpired]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleRevoke(tokenId: string): Promise<void> {
    if (!window.confirm('Revoke this service token? This cannot be undone.')) return;
    setBusyId(tokenId);
    setError(null);
    try {
      await api.revokeServiceToken(tokenId);
      await load();
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) { onSessionExpired(); return; }
        setError(caught.message);
      } else {
        setError('Unable to revoke this token.');
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <article className="card">
      <span className="card-title">Service tokens</span>
      <p className="card-detail">
        Minted only with <code>sudo ./pcctl create-service-token &lt;account-key&gt;</code> — never here.
        The value itself is shown once, at the terminal, and is never stored or displayed anywhere again.
      </p>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {tokens.length === 0 ? (
        <p className="hint">No service tokens have been minted.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Prefix</th>
                <th scope="col">Scopes</th>
                <th scope="col">Status</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const revoked = token.revokedAt !== null;
                const expired = !revoked && new Date(token.expiresAt).getTime() <= Date.now();
                const status = revoked ? 'Revoked' : expired ? 'Expired' : 'Active';
                return (
                  <tr key={token.id}>
                    <td>{token.accountKey}</td>
                    <td><code>{token.prefix}</code></td>
                    <td>{token.scopes.join(', ')}</td>
                    <td>{status}</td>
                    <td>{formatTime(token.lastUsedAt)}</td>
                    <td>{formatTime(token.expiresAt)}</td>
                    <td>
                      {!revoked && (
                        <button
                          type="button"
                          disabled={busyId === token.id}
                          onClick={() => void handleRevoke(token.id)}
                        >
                          {busyId === token.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
