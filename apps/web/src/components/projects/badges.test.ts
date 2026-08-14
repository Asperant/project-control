import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeTime } from './badges';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "never" for null', () => {
    expect(formatRelativeTime(null)).toBe('never');
  });

  it('returns "just now" for a timestamp seconds ago', () => {
    expect(formatRelativeTime('2026-08-05T11:59:58.000Z')).toBe('just now');
  });

  it('formats minutes ago', () => {
    expect(formatRelativeTime('2026-08-05T11:55:00.000Z')).toBe('5 minutes ago');
  });

  it('formats a singular unit without a trailing "s"', () => {
    expect(formatRelativeTime('2026-08-05T10:00:00.000Z')).toBe('2 hours ago');
    expect(formatRelativeTime('2026-08-05T11:00:00.000Z')).toBe('1 hour ago');
  });

  it('formats days ago', () => {
    expect(formatRelativeTime('2026-08-02T12:00:00.000Z')).toBe('3 days ago');
  });
});
