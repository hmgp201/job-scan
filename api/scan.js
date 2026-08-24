// Vercel serverless function: runs one job-watch scan per request.
//
// SCHEDULING: vercel.json ships a once-daily Vercel cron as a fallback
// (Hobby plan crons are limited to daily). For every-15-minutes on the free
// tier, point a free external pinger (e.g. cron-job.org) at:
//   https://<your-app>.vercel.app/api/scan?key=<CRON_SECRET>
// On Pro, just change the vercel.json cron schedule to "*/15 * * * *" —
// Vercel's own cron authenticates automatically via the CRON_SECRET header.
//
// STATE: serverless filesystems are wiped between runs, so the alert ledger
// (job_watch_log.csv), run counter, and slug cache are kept as ONE small
// JSON blob in Vercel Blob storage — loaded into /tmp before the scan,
// saved back after. companies.csv deliberately ships read-only with each
// deploy: the repo stays the single source of truth (edit it, push, done).
// First run bootstraps the ledger from the committed job_watch_log.csv so
// previously alerted jobs don't repeat.
//
// ENV VARS (Vercel project settings): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
// CRON_SECRET (any random string), and BLOB_READ_WRITE_TOKEN (added
// automatically when you connect a Blob store to the project).
const fs = require('fs');
const path = require('path');
const { put, head } = require('@vercel/blob');

const DATA_DIR = '/tmp/job-watch-data';
process.env.JOB_WATCH_DATA_DIR = DATA_DIR; // must be set BEFORE requiring job_watch
const { performScan } = require('../job_watch.js');

const STATE_BLOB_PATH = 'job-watch/state.json';
const LEDGER = 'job_watch_log.csv';
const COUNTER = 'run_counter.json';
const SLUG_CACHE = 'slug_cache.json';

// Files bundled with the deploy (see includeFiles in vercel.json).
function findRepoFile(name) {
  const candidates = [
    path.join(process.cwd(), name),
    path.join(__dirname, '..', name)
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function loadState() {
  try {
    const info = await head(STATE_BLOB_PATH); // throws if the blob doesn't exist yet
    const res = await fetch(`${info.url}?ts=${Date.now()}`); // bust any CDN cache
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // first run
  }
}

async function saveState(state) {
  await put(STATE_BLOB_PATH, JSON.stringify(state), {
    access: 'public', // the URL is unguessable; contents are just job-post metadata
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

module.exports = async (req, res) => {
  // Auth: Vercel cron sends "Authorization: Bearer <CRON_SECRET>"; external
  // pingers can use the same header or ?key=<CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const key = (req.query && req.query.key) || '';
    if (auth !== `Bearer ${secret}` && key !== secret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Pull persisted state; bootstrap the ledger from the repo copy on first run.
  const state = await loadState();
  let ledgerCsv = state?.ledgerCsv;
  if (ledgerCsv == null) {
    const repoLedger = findRepoFile(LEDGER);
    if (repoLedger) ledgerCsv = fs.readFileSync(repoLedger, 'utf8');
  }
  if (ledgerCsv != null) fs.writeFileSync(path.join(DATA_DIR, LEDGER), ledgerCsv);
  if (state?.runCounter) fs.writeFileSync(path.join(DATA_DIR, COUNTER), JSON.stringify(state.runCounter));
  if (state?.slugCache) fs.writeFileSync(path.join(DATA_DIR, SLUG_CACHE), JSON.stringify(state.slugCache));

  // companies.csv always comes fresh from the repo.
  const companiesRepo = findRepoFile('companies.csv');
  if (!companiesRepo) {
    return res.status(500).json({ ok: false, error: 'companies.csv missing from bundle — check includeFiles in vercel.json' });
  }
  fs.copyFileSync(companiesRepo, path.join(DATA_DIR, 'companies.csv'));

  let scanError = null;
  try {
    await performScan({}); // defaults: Telegram on, discovery off
  } catch (err) {
    scanError = err;
    console.error('scan failed:', err);
  }

  // Save state even after a partial failure — alerts that DID send are in
  // the ledger and must not repeat.
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  try {
    await saveState({
      ledgerCsv: readIf(path.join(DATA_DIR, LEDGER)) ?? '',
      runCounter: parse(readIf(path.join(DATA_DIR, COUNTER))),
      slugCache: parse(readIf(path.join(DATA_DIR, SLUG_CACHE))),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('state save failed:', err);
    if (!scanError) scanError = err;
  }

  return scanError
    ? res.status(500).json({ ok: false, error: scanError.message })
    : res.status(200).json({ ok: true });
};
