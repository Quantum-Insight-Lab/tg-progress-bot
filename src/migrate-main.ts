import { applyMigrations } from './infrastructure/apply-migrations.ts';
import { systemClock } from './infrastructure/clock.ts';
import { withMigrationSql } from './infrastructure/db.ts';
import { convertStoredZoneNames } from './infrastructure/zone-names.ts';

const connectionString = process.env.DATABASE_URL ?? '';
const applied = await withMigrationSql(connectionString, async (sql) => {
  const names = await applyMigrations(sql);
  await convertStoredZoneNames(sql, systemClock.now());
  return names;
});

if (applied.length === 0) {
  console.log('миграции уже применены');
} else {
  for (const name of applied) console.log(name);
}
