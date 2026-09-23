import { env } from "./config/index.js";
import { startGithubReconcileLoop } from "./github/reconcile.js";
import { logger } from "./infrastructure/logger.js";
import { dbScreenReader } from "./projections/index.js";
import { createRuntimeAccess } from "./process/access.js";
import { createRuntimeDayList } from "./process/day-list.js";
import { listenWebhooks } from "./process/server.js";
import { startStaleScanLoop } from "./process/stale-loop.js";
import { bot, startDailyReportLoop, wireTelegram } from "./telegram/index.js";

async function main(): Promise<void> {
  const access = createRuntimeAccess();
  const dayList = createRuntimeDayList();
  await access.reload();
  await dayList.reload();
  const telegram = bot();
  wireTelegram(telegram, {
    directory: access.directory(),
    identity: access.identity(),
    dayList,
    screens: dbScreenReader(),
  });
  const stopGithub = startGithubReconcileLoop();
  const stopStale = startStaleScanLoop({ bot: telegram, store: dayList });
  const stopReport = startDailyReportLoop({ bot: telegram });
  const port = env().port;
  const server = listenWebhooks({
    bot: telegram,
    port,
    beforeTelegram: async () => {
      await access.reload();
      await dayList.reload();
    },
  });
  logger.info("process.listening", { port });
  const stop = (): void => {
    stopGithub();
    stopStale();
    stopReport();
    server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  logger.error("process.failed", { error: String(error) });
  process.exitCode = 1;
});
