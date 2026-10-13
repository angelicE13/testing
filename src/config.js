import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env = process.env) {
  const timezone = env.APP_TIMEZONE || 'Australia/Sydney';
  if (!validTimeZone(timezone)) throw new Error(`Invalid APP_TIMEZONE: ${timezone}`);
  const unit = (env.DISTANCE_UNIT || 'km').toLowerCase() === 'mi' ? 'mi' : 'km';
  const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
  return {
    port: Number(env.PORT) || 3000,
    timezone,
    unit,
    dataDir,
    dbFile: path.join(dataDir, 'mileage.db'),
    reportsDir: path.join(dataDir, 'reports'),
    publicDir: path.join(root, 'public'),
    password: env.APP_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
  };
}
