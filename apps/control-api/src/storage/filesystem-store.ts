import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import {
  ArtifactNotFoundError,
  ArtifactTooLargeError,
  DigestMismatchError,
  InvalidDigestError,
  type ArtifactStore,
  type PutOptions,
  type StoredArtifact,
} from './types.js';

/**
 * Content-addressed store on the host filesystem.
 *
 * Layout:  <root>/objects/<first two hex chars>/<full sha256>
 *          <root>/temporary/<random>.part      (staging area)
 *
 * The two-character fan-out keeps any single directory well under the point
 * where ext4 directory lookups degrade, while remaining trivially predictable
 * for backup and verification tooling.
 *
 * ## Why paths here are safe
 *
 * The object path is derived *solely* from a validated SHA-256 digest — 64
 * characters matching `^[0-9a-f]{64}$`. A caller-supplied filename never
 * participates in path construction; it is metadata stored in PostgreSQL only.
 * Traversal is therefore not "filtered", it is structurally impossible: there is
 * no input to the path builder that can contain `/`, `..`, a NUL byte, or a
 * drive letter and still pass validation.
 *
 * `resolveObjectPath` additionally re-checks that the constructed path stays
 * under the objects root, which catches a future refactor that reintroduces
 * caller-controlled path segments.
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type FilesystemArtifactStoreOptions = {
  /** Deployment artifact root, e.g. /srv/project-control/data/artifacts. */
  root: string;
  maxBytes: number;
};

export class FilesystemArtifactStore implements ArtifactStore {
  private readonly objectsRoot: string;
  private readonly temporaryRoot: string;
  private readonly maxBytes: number;

  constructor(options: FilesystemArtifactStoreOptions) {
    const root = path.resolve(options.root);
    this.objectsRoot = path.join(root, 'objects');
    this.temporaryRoot = path.join(root, 'temporary');
    this.maxBytes = options.maxBytes;
  }

  /** Creates the directory skeleton. Safe to call repeatedly. */
  async initialise(): Promise<void> {
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o750 });
    await mkdir(this.temporaryRoot, { recursive: true, mode: 0o750 });
  }

  /**
   * Maps a digest to its on-disk path.
   *
   * Exported behaviour is deliberately strict: anything that is not a canonical
   * lowercase 64-char hex digest is rejected before it touches the filesystem.
   */
  resolveObjectPath(sha256: string): string {
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      throw new InvalidDigestError(String(sha256));
    }

    const shard = sha256.slice(0, 2);
    const candidate = path.join(this.objectsRoot, shard, sha256);

    // Defence in depth: the digest pattern already makes this unreachable, but a
    // future change that widens the input must fail loudly rather than escape.
    const normalised = path.resolve(candidate);
    const prefix = this.objectsRoot + path.sep;
    if (!normalised.startsWith(prefix)) {
      throw new InvalidDigestError(sha256);
    }
    return normalised;
  }

  async put(source: Readable, options: PutOptions): Promise<StoredArtifact> {
    const limit = Math.min(options.maxBytes, this.maxBytes);
    await this.initialise();

    if (options.expectedSha256 !== undefined && !SHA256_PATTERN.test(options.expectedSha256)) {
      throw new InvalidDigestError(options.expectedSha256);
    }

    const stagingPath = path.join(this.temporaryRoot, `${randomBytes(16).toString('hex')}.part`);
    const hasher = createHash('sha256');
    let bytesWritten = 0;

    // O_EXCL: refuse to reuse an existing staging file. The name is random, so a
    // collision means something else is writing there and we must not clobber it.
    const handle = await open(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o640);

    try {
      const sink = createWriteStream('', { fd: handle.fd, autoClose: false });

      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            bytesWritten += chunk.length;
            if (bytesWritten > limit) {
              // Abort as soon as the limit is crossed rather than after the
              // whole body has been buffered — that is the difference between a
              // rejected upload and a disk-exhaustion vector.
              throw new ArtifactTooLargeError(limit);
            }
            hasher.update(chunk);
            yield chunk;
          }
        },
        sink,
      );

      // Durability: the bytes must be on the platter before the rename makes
      // them reachable, otherwise a crash can publish a truncated object.
      await handle.sync();
      await handle.close();

      const sha256 = hasher.digest('hex');

      if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
        throw new DigestMismatchError();
      }

      const destination = this.resolveObjectPath(sha256);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });

      // Deduplication: identical content is written once. Checked before the
      // rename so the existing (already verified) object is never disturbed.
      if (await this.exists(sha256)) {
        await rm(stagingPath, { force: true });
        return { sha256, sizeBytes: bytesWritten, deduplicated: true };
      }

      // rename(2) within one filesystem is atomic: readers see either no object
      // or the complete object, never a partial one.
      await rename(stagingPath, destination);
      await this.fsyncDirectory(path.dirname(destination));

      return { sha256, sizeBytes: bytesWritten, deduplicated: false };
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(stagingPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get(sha256: string): Promise<Readable> {
    const objectPath = this.resolveObjectPath(sha256);
    await this.assertRegularFile(objectPath, sha256);
    return createReadStream(objectPath);
  }

  async exists(sha256: string): Promise<boolean> {
    const objectPath = this.resolveObjectPath(sha256);
    try {
      // lstat, not stat: a symlink placed in the object tree must be treated as
      // "not a stored object" rather than silently followed to an arbitrary file.
      const info = await lstat(objectPath);
      return info.isFile();
    } catch {
      return false;
    }
  }

  async size(sha256: string): Promise<number | null> {
    const objectPath = this.resolveObjectPath(sha256);
    try {
      const info = await lstat(objectPath);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.initialise();
      await access(this.objectsRoot, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
      await access(this.temporaryRoot, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
      const info = await stat(this.objectsRoot);
      return {
        ok: true,
        detail: `Object store writable (mode ${(info.mode & 0o777).toString(8)}).`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'Artifact store unavailable.',
      };
    }
  }

  /**
   * Rejects anything that is not a plain file — notably symlinks, which would
   * otherwise let a writer with access to the object tree redirect a read to
   * `/etc/shadow` or a secret file.
   */
  private async assertRegularFile(objectPath: string, sha256: string): Promise<void> {
    let info;
    try {
      info = await lstat(objectPath);
    } catch {
      throw new ArtifactNotFoundError(sha256);
    }
    if (info.isSymbolicLink()) {
      throw new ArtifactNotFoundError(sha256);
    }
    if (!info.isFile()) {
      throw new ArtifactNotFoundError(sha256);
    }
  }

  /**
   * fsyncs a directory so the rename itself is durable.
   * Best-effort: some filesystems reject O_RDONLY fsync on directories.
   */
  private async fsyncDirectory(dir: string): Promise<void> {
    try {
      const handle = await open(dir, fsConstants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Non-fatal: the file data is already synced; only the directory entry's
      // durability across a power loss is affected.
    }
  }

  /** Removes stale staging files left behind by a crash. */
  async sweepTemporary(olderThanMs = 6 * 60 * 60 * 1000): Promise<number> {
    const { readdir } = await import('node:fs/promises');
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.temporaryRoot);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - olderThanMs;
    for (const entry of entries) {
      if (!entry.endsWith('.part')) continue;
      const full = path.join(this.temporaryRoot, entry);
      try {
        const info = await lstat(full);
        // `<=`, not `<`: with a zero cutoff the caller means "sweep everything",
        // and a file written in the same millisecond as the cutoff would
        // otherwise survive — a real (if small) source of never-collected
        // staging files, and a flaky assertion.
        if (info.isFile() && info.mtimeMs <= cutoff) {
          await rm(full, { force: true });
          removed += 1;
        }
      } catch {
        // Raced with another sweep; nothing to do.
      }
    }
    return removed;
  }
}
