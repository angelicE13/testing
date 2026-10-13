import cron from 'node-cron';
import { runDueReports } from './reports.js';

/**
 * One job at 12:00 AM every day (in the user's time zone). On Mondays it produces the weekly
 * report, on the 1st the monthly one, and on 1 Jan/Apr/Jul/Oct the quarterly one —
 * runDueReports works out which periods have just finished.
 */
export function startScheduler(store, config, log = console) {
  const run = async (reason) => {
    try {
      const created = await runDueReports(store, config);
      for (const r of created) log.info(`[reports] ${reason}: generated ${r.period_type} ${r.label}`);
    } catch (err) {
      log.error('[reports] generation failed', err);
    }
  };
  const task = cron.schedule('0 0 * * *', () => run('scheduled'), { timezone: config.timezone });
  run('startup catch-up');
  return { stop: () => task.stop(), run };
}
