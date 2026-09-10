/**
 * The `.alert.alert-error` `role="alert"` banner repeated at ~20 call sites,
 * factored into one place. Visually identical to what every screen already
 * rendered by hand; the only addition is an optional request id so an
 * operator hitting a 500 has something to correlate with server logs.
 */
export function ErrorAlert({ error, requestId }: { error: string | null; requestId: string | null }): React.JSX.Element | null {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      {error}
      {requestId && (
        <p className="hint">
          Request ID: <code>{requestId}</code>
        </p>
      )}
    </div>
  );
}
