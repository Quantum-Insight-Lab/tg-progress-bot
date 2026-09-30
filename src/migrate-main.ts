import { applyMigrations } from './infrastructure/apply-migrations.ts';
import { withMigrationSql } from './infrastructure/db.ts';

const connectionString = process.env.DATABASE_URL ?? '';
const applied = await withMigrationSql(connectionString, (sql) => applyMigrations(sql));

if (applied.length === 0) {
  console.log('миграции уже применены');
} else {
  for (const name of applied) console.log(name);
}
