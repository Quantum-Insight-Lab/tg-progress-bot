import { Pool } from "pg";
import { env } from "../config/index.js";

let pool: Pool | undefined;

/** Единственный пул PostgreSQL (S-4). */
export function getPool(): Pool {
  pool ??= new Pool({ connectionString: env().databaseUrl });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool === undefined) {
    return;
  }
  await pool.end();
  pool = undefined;
}
