import crypto from 'node:crypto';

const COOKIE = 'mileage_session';

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

/** Optional single-user password. Disabled when APP_PASSWORD is not set. */
export function createAuth(config) {
  const enabled = Boolean(config.password);
  const secret = config.sessionSecret || crypto.createHash('sha256').update(`mileage:${config.password}`).digest('hex');
  const token = crypto.createHmac('sha256', secret).update('authenticated').digest('hex');

  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const isAuthed = (req) => !enabled || same(parseCookies(req.headers.cookie)[COOKIE] || '', token);

  return {
    enabled,
    isAuthed,
    login(req, res) {
      if (!enabled) return res.json({ authenticated: true });
      if (!same(req.body?.password || '', config.password)) {
        return res.status(401).json({ error: 'Wrong password' });
      }
      res.cookie(COOKIE, token, {
        httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 24 * 3600 * 1000,
      });
      return res.json({ authenticated: true });
    },
    logout(req, res) {
      res.clearCookie(COOKIE);
      res.json({ authenticated: !enabled });
    },
    require(req, res, next) {
      if (isAuthed(req)) return next();
      return res.status(401).json({ error: 'Login required' });
    },
  };
}
