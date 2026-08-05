import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { fingerprint, generateToken, hashToken } from './tokens.js';

export type SessionRecord = {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  csrfTokenHash: string;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'operator' | 'viewer';
  createdAt: Date;
  lastLoginAt: Date | null;
};

export type IssuedSession = {
  session: SessionRecord;
  /** Returned to the caller once, set as the cookie value, never stored. */
  token: string;
  /** Returned to the caller once, echoed back in the x-csrf-token header. */
  csrfToken: string;
};

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  /**
   * Creates a session and returns the raw tokens exactly once.
   *
   * Only hashes are persisted, so a database dump (which `backup_reader` can
   * produce, and which lands in Google Drive) contains nothing replayable.
   */
  async issue(userId: string, userAgent: string | undefined): Promise<IssuedSession> {
    const token = generateToken();
    const csrfToken = generateToken();
    const expiresAt = new Date(Date.now() + this.config.session.absoluteTtlSeconds * 1000);

    const session = await withTransaction(this.db, async (client) => {
      const { rows } = await client.query<{
        id: string;
        user_id: string;
        created_at: Date;
        last_seen_at: Date;
        expires_at: Date;
        csrf_token_hash: string;
      }>(
        `INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at, user_agent_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, created_at, last_seen_at, expires_at, csrf_token_hash`,
        [userId, hashToken(token), hashToken(csrfToken), expiresAt, fingerprint(userAgent)],
      );
      const row = rows[0];
      if (!row) throw new Error('Session insert returned no row.');

      await client.query(
        `UPDATE users
            SET last_login_at = now(), failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [userId],
      );

      return {
        id: row.id,
        userId: row.user_id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        csrfTokenHash: row.csrf_token_hash,
      } satisfies SessionRecord;
    });

    return { session, token, csrfToken };
  }

  /**
   * Resolves a cookie token to a live session plus its user.
   *
   * Returns null for every failure mode — unknown token, revoked, past absolute
   * expiry, idle too long, or a deactivated user — so callers cannot accidentally
   * distinguish them and turn the difference into an oracle.
   *
   * Touches `last_seen_at` on success, which is what makes the idle timeout a
   * sliding window.
   */
  async resolve(token: string): Promise<{ session: SessionRecord; user: AuthenticatedUser } | null> {
    if (token.length === 0 || token.length > 256) return null;

    const idleCutoff = `${this.config.session.idleTtlSeconds} seconds`;

    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      csrf_token_hash: string;
      email: string;
      display_name: string;
      role: 'admin' | 'operator' | 'viewer';
      user_created_at: Date;
      last_login_at: Date | null;
    }>(
      `UPDATE sessions s
          SET last_seen_at = now()
         FROM users u
        WHERE s.token_hash = $1
          AND s.user_id = u.id
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.last_seen_at > now() - $2::interval
          AND u.is_active
      RETURNING s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.csrf_token_hash,
                u.email, u.display_name, u.role,
                u.created_at AS user_created_at, u.last_login_at`,
      [hashToken(token), idleCutoff],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      session: {
        id: row.id,
        userId: row.user_id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        csrfTokenHash: row.csrf_token_hash,
      },
      user: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        createdAt: row.user_created_at,
        lastLoginAt: row.last_login_at,
      },
    };
  }

  /** Idempotent: revoking an unknown or already-revoked session is a no-op. */
  async revokeByToken(token: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return rowCount ?? 0;
  }

  /**
   * Deletes sessions that can no longer authenticate anyone.
   *
   * Kept conservative (7 days past expiry) so the audit trail can still be
   * correlated with recent session ids.
   */
  async purgeExpired(): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM sessions
        WHERE expires_at < now() - interval '7 days'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
    );
    return rowCount ?? 0;
  }
}
