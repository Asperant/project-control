import { errorCodeStatus, type ErrorCode } from '@project-control/contracts';

/**
 * The only error type routes are allowed to throw deliberately.
 *
 * Anything else that escapes a handler is treated as an unexpected fault and is
 * reported to the client as a bare `internal_error` — the real message stays in
 * the server log. That split is what keeps stack traces and driver errors (which
 * routinely contain connection strings) out of HTTP responses.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly fields?: Array<{ path: string; message: string }>;
  /** Detail recorded in the log/audit trail but never sent to the client. */
  readonly internalDetail?: string;
  readonly confirmation?: { kind: 'incomplete_acceptance' | 'incomplete_dependencies'; count: number };

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      fields?: Array<{ path: string; message: string }>;
      internalDetail?: string;
      cause?: unknown;
      confirmation?: { kind: 'incomplete_acceptance' | 'incomplete_dependencies'; count: number };
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = errorCodeStatus[code];
    if (options.fields) this.fields = options.fields;
    if (options.internalDetail) this.internalDetail = options.internalDetail;
    if (options.confirmation) this.confirmation = options.confirmation;
  }
}

/**
 * Authentication failures deliberately collapse to one message.
 *
 * "No such user" and "wrong password" must be indistinguishable, otherwise the
 * login endpoint becomes an account-enumeration oracle.
 */
export const AUTH_FAILURE_MESSAGE = 'Invalid email or password.';

export const unauthorized = (internalDetail?: string): AppError =>
  new AppError('unauthorized', AUTH_FAILURE_MESSAGE, internalDetail ? { internalDetail } : {});

export const forbidden = (message = 'Forbidden.'): AppError => new AppError('forbidden', message);

export const notFound = (message = 'Not found.'): AppError => new AppError('not_found', message);

export const badRequest = (message: string): AppError => new AppError('bad_request', message);

export const serviceUnavailable = (message: string, internalDetail?: string): AppError =>
  new AppError('service_unavailable', message, internalDetail ? { internalDetail } : {});
