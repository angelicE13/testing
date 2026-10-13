import fs from 'node:fs';
import express from 'express';
import { createAuth } from './auth.js';
import { ValidationError } from './db.js';
import { periodContaining, localDate } from './periods.js';
import { generateReport, runDueReports, summarise, tripsInRange } from './reports.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createApp(store, config) {
  const app = express();
  const auth = createAuth(config);
  app.set('trust proxy', true);
  app.use(express.json({ limit: '100kb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const id = (req) => Number(req.params.id);

  app.get('/api/config', (req, res) => {
    res.json({ unit: config.unit, timezone: config.timezone, authRequired: auth.enabled, authenticated: auth.isAuthed(req) });
  });
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);
  app.use('/api', auth.require);

  // ---- trips ----
  app.get('/api/trips', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const offset = Number(req.query.offset) || 0;
    res.json(store.listTrips({ limit, offset }));
  });

  app.get('/api/trips/active', (req, res) => res.json(store.activeTrip()));

  app.get('/api/odometer/last', (req, res) => {
    const exclude = req.query.exclude ? Number(req.query.exclude) : null;
    res.json({ lastEndOdo: store.lastEndOdo(exclude) });
  });

  app.post('/api/trips', (req, res) => res.status(201).json(store.createTrip(req.body || {})));

  app.get('/api/trips/:id', (req, res) => {
    const trip = store.getTrip(id(req));
    return trip ? res.json(trip) : res.status(404).json({ error: 'Trip not found' });
  });

  app.put('/api/trips/:id', (req, res) => {
    const result = store.updateTrip(id(req), req.body || {});
    return result ? res.json(result) : res.status(404).json({ error: 'Trip not found' });
  });

  app.post('/api/trips/:id/end', (req, res) => {
    const result = store.endTrip(id(req), req.body || {});
    return result ? res.json(result) : res.status(404).json({ error: 'Trip not found' });
  });

  app.delete('/api/trips/:id', (req, res) => {
    return store.deleteTrip(id(req)) ? res.status(204).end() : res.status(404).json({ error: 'Trip not found' });
  });

  // Totals for the week / month / quarter to date (for the home screen).
  app.get('/api/summary', (req, res) => {
    const today = localDate(new Date(), config.timezone);
    const trips = store.allCompletedTrips();
    const out = {};
    for (const type of ['weekly', 'monthly', 'quarterly']) {
      const { start, end } = periodContaining(type, today);
      out[type] = { start, end, ...summarise(tripsInRange(trips, start, end, config.timezone)) };
    }
    res.json(out);
  });

  // ---- reports ----
  const publicReport = ({ csv_path: _c, xlsx_path: _x, ...r }) => r;

  app.get('/api/reports', (req, res) => res.json(store.listReports().map(publicReport)));

  app.post('/api/reports/run', wrap(async (req, res) => {
    res.json((await runDueReports(store, config)).map(publicReport));
  }));

  app.post('/api/reports/custom', wrap(async (req, res) => {
    const { from, to } = req.body || {};
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) {
      return res.status(400).json({ error: 'Choose a valid from/to date range' });
    }
    return res.status(201).json(publicReport(await generateReport(store, config, 'custom', from, to)));
  }));

  app.post('/api/reports/:id/regenerate', wrap(async (req, res) => {
    const r = store.getReport(id(req));
    if (!r) return res.status(404).json({ error: 'Report not found' });
    return res.json(publicReport(await generateReport(store, config, r.period_type, r.period_start, r.period_end)));
  }));

  app.get('/api/reports/:id/download', (req, res) => {
    const r = store.getReport(id(req));
    if (!r) return res.status(404).json({ error: 'Report not found' });
    const file = req.query.format === 'csv' ? r.csv_path : r.xlsx_path;
    if (!fs.existsSync(file)) return res.status(410).json({ error: 'File missing — regenerate the report' });
    return res.download(file);
  });

  // ---- static PWA ----
  app.use(express.static(config.publicDir, { index: 'index.html' }));

  app.use((err, req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
