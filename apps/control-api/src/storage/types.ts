import type { Readable } from 'node:stream';

/**
 * Storage abstraction.
 *
 * This platform ships exactly one implementation (`FilesystemArtifactStore`), but the
 * interface is defined in terms a future S3/object-store adapter can satisfy:
 * content-addressed keys, streaming I/O, no filesystem paths in the signatures,
 * and no assumption that `exists` is cheap. That is the whole reason this file
 * is separate from the implementation.
 */

export type StoredArtifact = {
  sha256: string;
  sizeBytes: number;
  /**
   * True when an object with this digest was already present and the incoming
   * bytes were discarded rather than rewritten.
   */
  deduplicated: boolean;
};

export type PutOptions = {
  /** Hard ceiling; the stream is aborted the moment it is exceeded. */
  maxBytes: number;
  /**
   * When supplied, the computed digest must match or the object is rejected and
   * nothing is committed.
   */
  expectedSha256?: string;
};

export interface ArtifactStore {
  /**
   * Streams `source` into the store and returns its digest.
   *
   * Implementations must be atomic: a failure part-way through must leave no
   * partially written object visible.
   */
  put(source: Readable, options: PutOptions): Promise<StoredArtifact>;

  /** Opens a read stream for a stored object. Throws if absent. */
  get(sha256: string): Promise<Readable>;

  exists(sha256: string): Promise<boolean>;

  /** Byte length of a stored object, or null when absent. */
  size(sha256: string): Promise<number | null>;

  /**
   * Reports backing-store health for the readiness probe and status dashboard.
   * Must not throw.
   */
  health(): Promise<{ ok: boolean; detail: string }>;
}

/** Raised when a caller-supplied digest is not a canonical SHA-256. */
export class InvalidDigestError extends Error {
  constructor(value: string) {
    // The offending value is deliberately not interpolated: it is attacker
    // controlled and could contain terminal escapes or path fragments that end
    // up in a log a human later greps.
    super(`Invalid SHA-256 digest (length ${value.length}).`);
    this.name = 'InvalidDigestError';
  }
}

export class ArtifactTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Artifact exceeds the configured maximum of ${maxBytes} bytes.`);
    this.name = 'ArtifactTooLargeError';
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(sha256: string) {
    super(`No artifact stored for digest ${sha256.slice(0, 12)}….`);
    this.name = 'ArtifactNotFoundError';
  }
}

export class DigestMismatchError extends Error {
  constructor() {
    super('Computed digest does not match the expected digest.');
    this.name = 'DigestMismatchError';
  }
}
