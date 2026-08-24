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
const { put, head, BlobNotFoundError } = require('@vercel/blob');

const DATA_DIR = '/tmp/job-watch-data';
process.env.JOB_WATCH_DATA_DIR = DATA_DIR; // must be set BEFORE requiring job_watch
const { performScan } = require('../job_watch.js');

const STATE_BLOB_PATH = 'job-watch/state.json';
const LEDGER = 'job_watch_log.csv';
const COUNTER = 'run_counter.json';
const SLUG_CACHE = 'slug_cache.json';

// If two triggers hit /api/scan close together (duplicate cron-job.org jobs,
// a slow-request retry, Vercel's own cron overlapping the external pinger),
// both would otherwise load the same pre-scan ledger and independently
// decide the same jobs are new, double-alerting Telegram. This lock makes
// the second request bail out instead. TTL is maxDuration + a buffer so a
// genuinely still-running scan isn't mistaken for a stale/crashed lock.
const LOCK_TTL_MS = 90 * 1000;

// Files bundled with the deploy (see includeFiles in vercel.json).
function findRepoFile(name) {
  const candidates = [
    path.join(process.cwd(), name),
    path.join(__dirname, '..', name)
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function loadState() {
  console.log('[blob] loadState: head()', STATE_BLOB_PATH);
  let info;
  try {
    info = await head(STATE_BLOB_PATH);
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      console.log('[blob] loadState: not found (first run)');
      return null;
    }
    console.error('[blob] loadState: head() threw', err.name, err.message);
    throw err; // a real failure (bad token, network, etc.) must NOT be mistaken
               // for "first run" — that would silently drop the ledger and
               // re-alert every job on every run. Let the caller fail loudly.
  }
  console.log('[blob] loadState: head() ok', { size: info.size, uploadedAt: info.uploadedAt, cacheControl: info.cacheControl });
  const res = await fetch(`${info.url}?ts=${Date.now()}`); // bust any CDN cache
  console.log('[blob] loadState: fetch status', res.status);
  if (!res.ok) throw new Error(`state blob fetch failed: HTTP ${res.status}`);
  const json = await res.json();
  console.log('[blob] loadState: parsed', {
    ledgerCsvLen: json?.ledgerCsv?.length ?? null,
    hasRunCounter: json?.runCounter != null,
    hasSlugCache: json?.slugCache != null,
    runningSince: json?.runningSince ?? null,
    updatedAt: json?.updatedAt ?? null
  });
  return json;
}

async function saveState(state) {
  console.log('[blob] saveState: put()', {
    ledgerCsvLen: state?.ledgerCsv?.length ?? null,
    hasRunCounter: state?.runCounter != null,
    hasSlugCache: state?.slugCache != null,
    runningSince: state?.runningSince ?? null,
    hasToken: !!process.env.BLOB_READ_WRITE_TOKEN
  });
  try {
    const result = await put(STATE_BLOB_PATH, JSON.stringify(state), {
      access: 'public', // the URL is unguessable; contents are just job-post metadata
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    });
    console.log('[blob] saveState: put() ok', { url: result.url, pathname: result.pathname });
  } catch (err) {
    console.error('[blob] saveState: put() threw', err.name, err.message);
    throw err;
  }
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

  console.log('[scan] invoked', { trigger: req.headers['authorization'] ? 'auth-header' : (req.query?.key ? 'query-key' : 'none') });

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Pull persisted state; bootstrap the ledger from the repo copy on first run.
  let state;
  try {
    state = await loadState();
  } catch (err) {
    console.error('state load failed:', err);
    return res.status(500).json({ ok: false, error: 'state load failed (refusing to scan without the ledger, to avoid re-alerting): ' + err.message });
  }

  // Bail out if another invocation is still (or very recently was) running,
  // rather than racing it on the same ledger. See LOCK_TTL_MS comment above.
  if (state?.runningSince && Date.now() - state.runningSince < LOCK_TTL_MS) {
    console.log('[scan] skipped: lock held', { runningSince: state.runningSince, ageMs: Date.now() - state.runningSince });
    return res.status(200).json({ ok: true, skipped: 'scan already in progress' });
  }
  try {
    await saveState({ ...state, runningSince: Date.now() });
  } catch (err) {
    console.error('lock claim failed:', err);
    return res.status(500).json({ ok: false, error: 'lock claim failed: ' + err.message });
  }

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

  console.log('[scan] done', { ok: !scanError, error: scanError?.message ?? null });
  return scanError
    ? res.status(500).json({ ok: false, error: scanError.message })
    : res.status(200).json({ ok: true });
};
