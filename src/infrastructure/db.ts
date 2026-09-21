import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "../config/index.js";

export type EventsTable = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  actor: unknown;
  subject: unknown;
  payload: unknown;
  causation_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  schema_version: number;
};

export type Database = {
  events: EventsTable;
};

let pool: Pool | undefined;
let db: Kysely<Database> | undefined;

/** Единственный пул PostgreSQL (S-4). */
export function getPool(): Pool {
  pool ??= new Pool({ connectionString: env().databaseUrl });
  return pool;
}

export function getDb(): Kysely<Database> {
  db ??= new Kysely<Database>({
    dialect: new PostgresDialect({ pool: getPool() }),
  });
  return db;
}

export async function closePool(): Promise<void> {
  if (db !== undefined) {
    await db.destroy();
    db = undefined;
    pool = undefined;
    return;
  }
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}
