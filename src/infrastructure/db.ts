import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "../config/index.js";
import type { Database } from "./db-schema.js";

export type { Database, EventsTable } from "./db-schema.js";

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
