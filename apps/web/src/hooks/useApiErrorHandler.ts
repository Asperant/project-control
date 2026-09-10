import { useCallback, useState } from 'react';
import { ApiError } from '../api-client';

export type ApiErrorState = { message: string; requestId: string | null } | null;

/**
 * The repeated "catch a request failure, show it, bounce to login on an
 * expired session" shape used across nearly every screen. Keeps the
 * `ApiError`'s `requestId` (when the backend sent one) alongside the message
 * it already showed, so an operator hitting a 500 has something to hand to
 * logs instead of just the message. AbortErrors (an in-flight request
 * cancelled by a newer one) are treated as a no-op, matching every call
 * site's existing behaviour.
 */
export function useApiErrorHandler(
  onSessionExpired: () => void,
  defaultFallback = 'The request failed.',
): {
  error: ApiErrorState;
  setError: (message: string | null, requestId?: string | null) => void;
  handleError: (caught: unknown, fallback?: string) => void;
} {
  const [error, setErrorState] = useState<ApiErrorState>(null);

  const setError = useCallback((message: string | null, requestId: string | null = null) => {
    setErrorState(message === null ? null : { message, requestId });
  }, []);

  const handleError = useCallback(
    (caught: unknown, fallback: string = defaultFallback) => {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) {
          onSessionExpired();
          return;
        }
        setErrorState({ message: caught.message, requestId: caught.requestId ?? null });
        return;
      }
      setErrorState({ message: fallback, requestId: null });
    },
    [onSessionExpired, defaultFallback],
  );

  return { error, setError, handleError };
}
