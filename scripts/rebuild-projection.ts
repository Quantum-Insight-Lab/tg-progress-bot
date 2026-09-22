/**
 * Восстанавливает проекцию из журнала: scripts/rebuild-projection.ts <name>
 */
import { closePool } from "../src/infrastructure/db.js";
import {
  isProjectionName,
  PROJECTION_NAMES,
  rebuildProjection,
} from "../src/projections/rebuild.js";

const name = process.argv[2];
if (name === undefined || !isProjectionName(name)) {
  process.stderr.write(
    `проекция: ${PROJECTION_NAMES.join(", ")}\n`,
  );
  process.exitCode = 1;
} else {
  try {
    const result = await rebuildProjection(name);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await closePool();
  }
}
