import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadMigrations, runMigrations } from './migrate.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pc-migrations-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadMigrations', () => {
  it('returns migrations sorted by version regardless of directory order', async () => {
    await writeFile(path.join(dir, '0003_third.sql'), 'SELECT 3;');
    await writeFile(path.join(dir, '0001_first.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '0002_second.sql'), 'SELECT 2;');

    const loaded = await loadMigrations(dir);
    expect(loaded.map((m) => m.version)).toEqual(['0001', '0002', '0003']);
    expect(loaded.map((m) => m.name)).toEqual(['first', 'second', 'third']);
  });

  it('computes a stable content checksum', async () => {
    await writeFile(path.join(dir, '0001_alpha.sql'), 'SELECT 1;');
    const [first] = await loadMigrations(dir);
    const [again] = await loadMigrations(dir);
    expect(first?.checksum).toBe(again?.checksum);
    expect(first?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different checksum when the file changes', async () => {
    const file = path.join(dir, '0001_alpha.sql');
    await writeFile(file, 'SELECT 1;');
    const before = (await loadMigrations(dir))[0]?.checksum;
    await writeFile(file, 'SELECT 2;');
    const after = (await loadMigrations(dir))[0]?.checksum;
    expect(before).not.toBe(after);
  });

  it('rejects a .sql file that does not follow the naming convention', async () => {
    await writeFile(path.join(dir, 'oops.sql'), 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toThrow(/does not match/);
  });

  it('ignores non-SQL files such as editor backups', async () => {
    await writeFile(path.join(dir, '0001_alpha.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, 'README.md'), '# notes');
    await writeFile(path.join(dir, '.0001_alpha.sql.swp'), 'junk');

    const loaded = await loadMigrations(dir);
    expect(loaded).toHaveLength(1);
  });

  it('rejects duplicate version numbers', async () => {
    await writeFile(path.join(dir, '0001_alpha.sql'), 'SELECT 1;');
    // A second file with the same numeric prefix but a different name.
    await writeFile(path.join(dir, '0001_beta.sql'), 'SELECT 2;');
    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration version/);
  });

  it('returns an empty list for a directory with no migrations', async () => {
    expect(await loadMigrations(dir)).toEqual([]);
  });
});

describe('repository migrations', () => {
  it('loads the real migration set with unique, ordered versions', async () => {
    const repoMigrations = path.resolve(import.meta.dirname, '../../../../migrations');
    const loaded = await loadMigrations(repoMigrations);

    expect(loaded.length).toBeGreaterThan(0);
    const versions = loaded.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort()).toEqual(versions);
  });

  it('does not contain a literal password or secret in any migration', async () => {
    const repoMigrations = path.resolve(import.meta.dirname, '../../../../migrations');
    const loaded = await loadMigrations(repoMigrations);

    for (const migration of loaded) {
      // Role passwords are set by the init script from secret files, never in SQL.
      expect(migration.sql).not.toMatch(/PASSWORD\s+'[^']+'/i);
      expect(migration.sql).not.toMatch(/ENCRYPTED\s+PASSWORD/i);
    }
  });
});

describe('migration dry-run transaction', () => {
  it('keeps all pending migrations in one transaction before rolling back', async () => {
    await writeFile(path.join(dir, '0001_create.sql'), 'CREATE TABLE dry_run_parent(id int);');
    await writeFile(path.join(dir, '0002_grant.sql'), 'GRANT SELECT ON dry_run_parent TO PUBLIC;');
    const calls:string[]=[];
    const client={query:async(sql:string)=>{calls.push(sql.trim());if(sql.includes('SELECT version, name, checksum'))return {rows:[]};return {rows:[]};}};
    const result=await runMigrations(client as never,{migrationsDir:dir,dryRun:true});
    expect(result.applied).toEqual(['0001','0002']);
    expect(calls.filter((sql)=>sql==='BEGIN')).toHaveLength(1);
    expect(calls.filter((sql)=>sql==='ROLLBACK')).toHaveLength(1);
    expect(calls.indexOf('ROLLBACK')).toBeGreaterThan(calls.indexOf('GRANT SELECT ON dry_run_parent TO PUBLIC;'));
  });
});
