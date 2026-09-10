import type { ServiceScope, ServiceTokenSummary } from '@project-control/contracts';
import type { Db } from '../db/pool.js';
import { generateServiceToken } from './service-tokens.js';
import { hashToken } from './tokens.js';

export type ServiceAccountRecord = {
  id: string;
  key: string;
  displayName: string;
  scopes: ServiceScope[];
  status: 'active' | 'disabled';
};

export type ResolvedServiceToken = {
  account: ServiceAccountRecord;
  token: { id: string; scopes: ServiceScope[]; expiresAt: Date };
};

type TokenRow = {
  id: string;
  account_id: string;
  account_key: string;
  prefix: string;
  scopes: ServiceScope[];
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

function toSummary(row: TokenRow): ServiceTokenSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    accountKey: row.account_key,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Machine identity: service accounts and the Bearer tokens minted for them.
 *
 * Deliberately separate from `SessionStore` rather than a generalisation of
 * it: a service token has no idle timeout, no CSRF pairing and no cookie —
 * conflating the two would mean every session invariant needs a "but not for
 * machines" exception scattered through it.
 */
export class ServiceTokenStore {
  constructor(private readonly db: Db) {}

  /**
   * Upserts an account row from the compiled-in registry. Never touches
   * `status`: an operator-disabled account stays disabled across a redeploy
   * that re-runs this, which is exactly the point of `status` existing
   * outside the registry.
   */
  async ensureAccount(definition: {
    key: string;
    displayName: string;
    scopes: readonly ServiceScope[];
  }): Promise<ServiceAccountRecord> {
    const { rows } = await this.db.query<{
      id: string;
      key: string;
      display_name: string;
      scopes: ServiceScope[];
      status: 'active' | 'disabled';
    }>(
      `INSERT INTO service_accounts (key, display_name, scopes)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET display_name = EXCLUDED.display_name, scopes = EXCLUDED.scopes
       RETURNING id, key, display_name, scopes, status`,
      [definition.key, definition.displayName, definition.scopes],
    );
    const row = rows[0];
    if (!row) throw new Error('service account upsert returned no row.');
    return { id: row.id, key: row.key, displayName: row.display_name, scopes: row.scopes, status: row.status };
  }

  async findAccountByKey(key: string): Promise<ServiceAccountRecord | null> {
    const { rows } = await this.db.query<{
      id: string;
      key: string;
      display_name: string;
      scopes: ServiceScope[];
      status: 'active' | 'disabled';
    }>('SELECT id, key, display_name, scopes, status FROM service_accounts WHERE key = $1', [key]);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, key: row.key, displayName: row.display_name, scopes: row.scopes, status: row.status };
  }

  /**
   * Mints a token and returns the plaintext exactly once. The caller (the
   * `create-service-token` CLI) is responsible for printing it and nothing
   * else — it is never written to a file, a log line or the audit trail.
   */
  async mint(params: {
    accountId: string;
    accountKey: string;
    scopes: readonly ServiceScope[];
    ttlDays: number;
    createdByUserId: string | null;
  }): Promise<{ token: string; summary: ServiceTokenSummary }> {
    const generated = generateServiceToken();
    const { rows } = await this.db.query<Omit<TokenRow, 'account_key'>>(
      `INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6)
       RETURNING id, account_id, prefix, scopes, expires_at, last_used_at, revoked_at, created_at`,
      [params.accountId, generated.tokenHash, generated.prefix, params.scopes, params.ttlDays, params.createdByUserId],
    );
    const row = rows[0];
    if (!row) throw new Error('service token insert returned no row.');
    return { token: generated.token, summary: toSummary({ ...row, account_key: params.accountKey }) };
  }

  /**
   * Resolves a raw Bearer value to its account and token, or null for every
   * failure mode — unknown, revoked, expired, or a disabled account — so a
   * caller cannot turn the difference into an oracle. Touches `last_used_at`
   * on success.
   */
  async resolve(rawToken: string): Promise<ResolvedServiceToken | null> {
    if (rawToken.length === 0 || rawToken.length > 256) return null;

    const { rows } = await this.db.query<{
      token_id: string;
      token_scopes: ServiceScope[];
      expires_at: Date;
      account_id: string;
      account_key: string;
      account_display_name: string;
      account_scopes: ServiceScope[];
    }>(
      `UPDATE service_tokens t
          SET last_used_at = now()
         FROM service_accounts a
        WHERE t.token_hash = $1
          AND t.account_id = a.id
          AND t.revoked_at IS NULL
          AND t.expires_at > now()
          AND a.status = 'active'
      RETURNING t.id AS token_id, t.scopes AS token_scopes, t.expires_at,
                a.id AS account_id, a.key AS account_key, a.display_name AS account_display_name,
                a.scopes AS account_scopes`,
      [hashToken(rawToken)],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      account: {
        id: row.account_id,
        key: row.account_key,
        displayName: row.account_display_name,
        scopes: row.account_scopes,
        status: 'active',
      },
      token: { id: row.token_id, scopes: row.token_scopes, expiresAt: row.expires_at },
    };
  }

  async list(): Promise<ServiceTokenSummary[]> {
    const { rows } = await this.db.query<TokenRow>(
      `SELECT t.id, t.account_id, a.key AS account_key, t.prefix, t.scopes,
              t.expires_at, t.last_used_at, t.revoked_at, t.created_at
         FROM service_tokens t
         JOIN service_accounts a ON a.id = t.account_id
        ORDER BY t.created_at DESC`,
    );
    return rows.map(toSummary);
  }

  async get(id: string): Promise<ServiceTokenSummary | null> {
    const { rows } = await this.db.query<TokenRow>(
      `SELECT t.id, t.account_id, a.key AS account_key, t.prefix, t.scopes,
              t.expires_at, t.last_used_at, t.revoked_at, t.created_at
         FROM service_tokens t
         JOIN service_accounts a ON a.id = t.account_id
        WHERE t.id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toSummary(row) : null;
  }

  /** Idempotent: revoking an already-revoked token succeeds without a second audit-worthy transition. */
  async revoke(id: string): Promise<{ summary: ServiceTokenSummary; alreadyRevoked: boolean } | null> {
    const { rows } = await this.db.query<TokenRow>(
      `UPDATE service_tokens t
          SET revoked_at = now()
         FROM service_accounts a
        WHERE t.id = $1 AND t.account_id = a.id AND t.revoked_at IS NULL
      RETURNING t.id, t.account_id, a.key AS account_key, t.prefix, t.scopes,
                t.expires_at, t.last_used_at, t.revoked_at, t.created_at`,
      [id],
    );
    const row = rows[0];
    if (row) return { summary: toSummary(row), alreadyRevoked: false };

    const existing = await this.get(id);
    if (!existing) return null;
    return { summary: existing, alreadyRevoked: true };
  }
}
