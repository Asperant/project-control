import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          // Integration tests share one PostgreSQL schema, so they must not
          // interleave; a single fork keeps the fixtures deterministic.
          pool: 'forks',
          // Vitest 4 moved fork options to the top level.
          maxWorkers: 1,
          minWorkers: 1,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
