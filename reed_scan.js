#!/usr/bin/env node
/**
 * reed_scan.js
 * ---------------------------------------------------------------
 * A SEPARATE data source from job_watch.js — Reed.co.uk's official
 * jobseeker API (https://www.reed.co.uk/developers/jobseeker), one of the
 * largest standalone UK job boards. Same rationale as adzuna_scan.js: a
 * UK-specific, keyword-driven, employer-agnostic search fits this profile
 * far better than job_watch.js's direct-ATS company list.
 *
 * Wired into .github/workflows/scan-uk-boards.yml alongside adzuna_scan.js
 * (every 2 hours — Reed's daily cap is far more generous than Adzuna's,
 * see RATE LIMITS below, but there's no reason to poll faster than the
 * other board source). Can still be run by hand:
 *   node reed_scan.js / npm run scan:ukdesign:reed
 *
 * Usage:
 *   node reed_scan.js                    -> scan once using configs/default/config.json
 *   node reed_scan.js --config=uk-design -> use a different profile
 *   node reed_scan.js --json             -> scan once, print raw JSON
 *   node reed_scan.js --no-telegram
 *   node reed_scan.js --strict            -> hide postings with no disclosed salary
 *   node reed_scan.js --min-salary=70000 --max-age=7
 *   node reed_scan.js --quiet             -> hide the [reed] per-request log lines
 *
 * CREDENTIALS: needs REED_API_KEY — free signup at
 * https://www.reed.co.uk/developers/jobseeker (no card). Reed's API uses
 * HTTP Basic auth with the key AS the username and an empty password —
 * not a bearer token or query param, see fetchReedSearch() below.
 *
 * RATE LIMITS: documented at 1,000 requests/day per key. This profile's
 * short "boardQueries" list (see configs/uk-design/config.json, shared
 * with adzuna_scan.js) makes even hourly runs a small fraction of that;
 * scan-uk-boards.yml runs every 2 hours to match adzuna_scan.js's cadence.
 *
 * NO SCORING: same as adzuna_scan.js — see job_watch.js's SCORING_ENABLED.
 *
 * DATES: Reed returns "date"/"expirationDate" as UK-format DD/MM/YYYY
 * strings (e.g. "02/09/2026") — NOT ISO. new Date() on that string is
 * ambiguous/wrong in Node (parses as MM/DD in some engines), so it's
 * parsed explicitly in parseReedDate() below rather than handed to the
 * generic Date constructor.
 *
 * SALARY: read directly from Reed's own minimumSalary/maximumSalary
 * fields (numeric, no regex extraction needed) when currency is GBP.
 *
 * LOCATION: Reed's locationName is a free-text field (e.g. "London",
 * "South East London", "UK Wide"), normalized into the same shape the
 * other sources use and run through the shared locationAllowed().
 *
 * DEDUP: its own cursor file, <profile folder>/last_scan_reed.json.
 * ---------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const {
  CONFIG, DATA_DIR,
  classifyTrack, scoreJob, locationAllowed,
  REMOTE_INCLUDE_RE, REMOTE_EXCLUDE_RE,
  MIN_SALARY, GOOD_MATCH_THRESHOLD, MAX_AGE_DAYS, EXCLUDED_TITLE_TERMS, CURRENCY_SYMBOL, SCORING_ENABLED,
  formatTelegramMessage, sendTelegramMessage, setApiLogEnabled
} = require('./job_watch.js');

// Same short query list adzuna_scan.js uses — see configs/uk-design/config.json.
const BOARD_QUERIES = CONFIG.boardQueries || ['technical designer', 'retail design manager'];

const REED_API_KEY = process.env.REED_API_KEY;

let RD_LOG_ENABLED = true;
function rdLog(msg) {
  if (RD_LOG_ENABLED) console.error(`[reed ${new Date().toISOString()}] ${msg}`);
}

// =================================================================
// DEDUP CURSOR — same one-timestamp model as the other sources.
// =================================================================
const LAST_SCAN_PATH = path.join(DATA_DIR, 'last_scan_reed.json');

function loadLastScanAt() {
  try { return JSON.parse(fs.readFileSync(LAST_SCAN_PATH, 'utf8')).lastScanAt || null; }
  catch { return null; }
}

function saveLastScanAt(iso) {
  fs.writeFileSync(LAST_SCAN_PATH, JSON.stringify({ lastScanAt: iso }));
}

function isNewSinceCursor(postedOrUpdated, cutoffIso) {
  if (!cutoffIso) return true;
  const t = new Date(postedOrUpdated).getTime();
  if (!Number.isFinite(t)) return true;
  return t > new Date(cutoffIso).getTime();
}

// See the DATES doc note above — "DD/MM/YYYY" only, always zero-padded per
// Reed's own examples, but tolerate 1-2 digit day/month defensively anyway.
function parseReedDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// =================================================================
// FETCH — https://www.reed.co.uk/developers/jobseeker. Basic auth: API
// key as the username, password left empty (verified directly against
// the official docs — NOT a bearer token, NOT a query param).
// =================================================================
const RESULTS_TO_TAKE = 50;

async function fetchReedSearch(query, queryStat) {
  const params = new URLSearchParams({
    keywords: query,
    resultsToTake: String(RESULTS_TO_TAKE)
  });
  const url = `https://www.reed.co.uk/api/1.0/search?${params.toString()}`;
  rdLog(`GET query="${query}" -> ${url}`);
  const res = await fetch(url, {
    headers: { 'Authorization': 'Basic ' + Buffer.from(`${REED_API_KEY}:`).toString('base64') }
  });
  rdLog(`  <- HTTP ${res.status} for "${query}"`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  const results = data.results || [];
  queryStat.count = data.totalResults ?? null;
  rdLog(`  "${query}": ${results.length} returned, ${data.totalResults ?? '?'} total match(es)`);
  return results;
}

// Normalizes one Reed result into the same shape job_watch.js's other
// fetchers produce, so classifyTrack/locationAllowed/scoreJob apply
// unchanged (see hiring_cafe_scan.js's hitToJob for the precedent).
function hitToJob(hit) {
  const title = hit.jobTitle || '';
  const description = hit.jobDescription || '';
  const displayName = hit.locationName || '';
  const isRemoteHint = /\bremote\b/i.test(title) || /\bremote\b/i.test(description) || /\bremote\b/i.test(displayName);
  const location = isRemoteHint ? `Remote, ${displayName || 'UK'}` : displayName;
  const salary = (hit.currency === 'GBP' && hit.minimumSalary && hit.maximumSalary)
    ? { min: Math.round(hit.minimumSalary), max: Math.round(hit.maximumSalary) }
    : null;
  return {
    title,
    company: hit.employerName || 'Unknown',
    url: hit.jobUrl,
    updatedAt: parseReedDate(hit.date) || new Date().toISOString(),
    location,
    description,
    salary
  };
}

async function scanReed(queryStats) {
  const byUrl = new Map();
  for (const query of BOARD_QUERIES) {
    const stat = { query, returned: 0, duplicate: 0, error: null };
    queryStats.push(stat);
    let hits;
    try {
      hits = await fetchReedSearch(query, stat);
    } catch (err) {
      stat.error = err.message;
      console.error(`[reed] "${query}": ${err.message}`);
      continue;
    }
    stat.returned = hits.length;
    for (const hit of hits) {
      const job = hitToJob(hit);
      if (!job.url) continue;
      if (byUrl.has(job.url)) { stat.duplicate++; continue; }
      byUrl.set(job.url, job);
    }
  }
  return [...byUrl.values()];
}

// Same filter pipeline as adzuna_scan.js's filterAndScore().
function filterAndScore(jobs, { minSalary, maxAgeDays, strict }, funnel) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const results = [];
  for (const job of jobs) {
    const trackKey = classifyTrack(job.title);
    if (!trackKey) { funnel.noTrackMatch++; continue; }
    funnel.trackMatched++;

    const titleLower = job.title.toLowerCase();
    if (EXCLUDED_TITLE_TERMS.some(term => titleLower.includes(term))) { funnel.excludedTitle++; continue; }

    const age = Date.now() - new Date(job.updatedAt).getTime();
    if (age > maxAgeMs) { funnel.tooOld++; continue; }

    const { allowed, isRemote } = locationAllowed(job.location);
    if (!allowed) { funnel.badLocation++; continue; }

    if (REMOTE_EXCLUDE_RE.test(titleLower) && !REMOTE_INCLUDE_RE.test(titleLower)) { funnel.titleRegionExcluded++; continue; }

    if (job.salary && job.salary.max < minSalary) { funnel.belowSalary++; continue; }
    if (!job.salary && strict) { funnel.belowSalary++; continue; }

    const score = SCORING_ENABLED
      ? scoreJob(job, trackKey)
      : { matchPct: null, haveTerms: [], haveBonusTerms: [], suggestedSwaps: [] };
    funnel.kept++;
    results.push({
      companyDisplay: job.company,
      source: 'reed',
      isRemote,
      track: CONFIG.tracks[trackKey].label,
      trackKey,
      resumeFile: CONFIG.tracks[trackKey].resumeFile,
      title: job.title,
      location: job.location,
      url: job.url,
      postedOrUpdated: job.updatedAt,
      matchPct: score.matchPct,
      matchedTerms: score.haveTerms,
      bonusTerms: score.haveBonusTerms,
      suggestedSwaps: score.suggestedSwaps,
      salary: job.salary ? `${CURRENCY_SYMBOL}${job.salary.min.toLocaleString()}-${CURRENCY_SYMBOL}${job.salary.max.toLocaleString()}` : 'not listed'
    });
  }
  results.sort((a, b) => {
    if (SCORING_ENABLED && a.matchPct !== b.matchPct) return b.matchPct - a.matchPct;
    if (a.isRemote !== b.isRemote) return a.isRemote ? -1 : 1;
    return new Date(b.postedOrUpdated) - new Date(a.postedOrUpdated);
  });
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const noTelegram = args.includes('--no-telegram');
  const strict = args.includes('--strict');
  if (args.includes('--quiet')) { RD_LOG_ENABLED = false; setApiLogEnabled(false); }
  const minSalaryArg = args.find(a => a.startsWith('--min-salary='));
  const minMatchArg = args.find(a => a.startsWith('--min-match='));
  const maxAgeArg = args.find(a => a.startsWith('--max-age='));
  const minSalary = minSalaryArg ? parseInt(minSalaryArg.split('=')[1], 10) : MIN_SALARY;
  const minMatch = minMatchArg ? parseInt(minMatchArg.split('=')[1], 10) : GOOD_MATCH_THRESHOLD;
  const maxAgeDays = maxAgeArg ? parseFloat(maxAgeArg.split('=')[1]) : MAX_AGE_DAYS;

  if (!REED_API_KEY) {
    console.error('[reed] REED_API_KEY not set — get a free key at https://www.reed.co.uk/developers/jobseeker. Skipping this source.');
    return;
  }

  rdLog(`"${CONFIG.name}": starting scan, ${BOARD_QUERIES.length} quer${BOARD_QUERIES.length === 1 ? 'y' : 'ies'}`);
  const queryStats = [];
  const rawJobs = await scanReed(queryStats);
  rdLog(`${rawJobs.length} unique job(s) collected across all queries; filtering...`);
  const funnel = { noTrackMatch: 0, trackMatched: 0, excludedTitle: 0, tooOld: 0, badLocation: 0, titleRegionExcluded: 0, belowSalary: 0, kept: 0 };
  const results = filterAndScore(rawJobs, { minSalary, maxAgeDays, strict }, funnel);
  rdLog(`filtering done: ${funnel.kept} kept of ${rawJobs.length} raw.`);

  const cutoffIso = loadLastScanAt();
  const newSinceLastScan = results.filter(r => isNewSinceCursor(r.postedOrUpdated, cutoffIso));

  if (jsonOut) {
    console.log(JSON.stringify({
      lastScanAt: cutoffIso, minSalary, minMatch,
      queryStats, funnel, rawJobCount: rawJobs.length,
      currentJobs: results,
      newSinceLastScanUrls: newSinceLastScan.map(j => j.url)
    }, null, 2));
  } else {
    console.log('\nPer-query results (Reed):');
    for (const s of queryStats) {
      if (s.error) { console.log(`  "${s.query}": ERROR — ${s.error}`); continue; }
      console.log(`  "${s.query}": ${s.returned} returned` +
        (s.count != null ? ` (${s.count} total match(es) on Reed)` : '') +
        (s.duplicate ? ` [${s.duplicate} duplicate]` : ''));
    }
    console.log(`  ${rawJobs.length} unique job(s) across all queries.`);

    console.log(`\nFunnel: ${rawJobs.length} raw -> ${funnel.trackMatched} matched a track` +
      ` -> ${funnel.kept} kept (dropped: ${funnel.noTrackMatch} no track match, ` +
      `${funnel.excludedTitle} excluded title, ${funnel.tooOld} too old (>${maxAgeDays}d), ` +
      `${funnel.badLocation} bad location, ${funnel.titleRegionExcluded} title names excluded region, ` +
      `${funnel.belowSalary} below salary floor)`);

    console.log(`\n[reed] Found ${results.length} matching role(s) ` +
      `(min salary floor: ${CURRENCY_SYMBOL}${minSalary.toLocaleString()}, max age: ${maxAgeDays}d):\n`);
    for (const r of results) {
      const hoursAgo = Math.round((Date.now() - new Date(r.postedOrUpdated)) / 3600000);
      console.log(`── ${r.companyDisplay} — ${r.title} [${r.isRemote ? 'REMOTE' : 'hybrid/onsite'}]`);
      console.log(`   Location: ${r.location || 'n/a'} | Salary: ${r.salary} | Posted ${hoursAgo}h ago`);
      console.log(`   Apply: ${r.url}`);
    }
    console.log(`\n${newSinceLastScan.length} of ${results.length} posted/updated since the last Reed scan` +
      (cutoffIso ? ` (${cutoffIso}).` : ' (first scan for this profile).'));
  }

  const telegramConfigured = !!(process.env[CONFIG.telegram.botTokenEnv] && process.env[CONFIG.telegram.chatIdEnv]);
  const statusLog = jsonOut ? console.error : console.log;
  if (!noTelegram && telegramConfigured) {
    const run = { timestamp: new Date().toISOString(), timestampLocal: new Date().toLocaleString() };
    const toSend = SCORING_ENABLED ? newSinceLastScan.filter(j => j.matchPct >= minMatch) : newSinceLastScan;
    let sent = 0;
    for (const job of toSend) {
      const ok = await sendTelegramMessage(formatTelegramMessage(job, run));
      if (ok) sent++;
    }
    if (toSend.length) statusLog(`[Telegram] Sent ${sent}/${toSend.length} Reed alert(s)${SCORING_ENABLED ? ` at/above ${minMatch}% match` : ''}.`);
    saveLastScanAt(run.timestamp);
  } else if (newSinceLastScan.length) {
    const why = noTelegram ? '--no-telegram passed' : `${CONFIG.telegram.botTokenEnv}/${CONFIG.telegram.chatIdEnv} not set`;
    statusLog(`[Telegram disabled: ${why}] Scan cursor not advanced — these will still look new on the next Telegram-enabled run.`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { scanReed, filterAndScore, parseReedDate };
