import { describe, expect, it } from 'vitest';
import { getDb } from '../src/infrastructure/db.ts';

describe('пул PostgreSQL', () => {
  it('без DATABASE_URL пул не создаётся', () => {
    expect(() => getDb('')).toThrow('DATABASE_URL не задан');
  });
});
