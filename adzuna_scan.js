#!/usr/bin/env node
/**
 * adzuna_scan.js
 * ---------------------------------------------------------------
 * A SEPARATE data source from job_watch.js — Adzuna's official UK job
 * search API (https://developer.adzuna.com), a broad aggregator pulling
 * from thousands of UK employer career sites and job boards. Unlike
 * job_watch.js's direct-ATS scan (built around Greenhouse/Ashby/Lever/
 * Workday, which skew heavily toward VC-funded US tech companies), this
 * queries the whole UK jobs market by keyword with no company list to
 * maintain — the right shape for a UK-specific, employer-agnostic search.
 *
 * Wired into .github/workflows/scan-uk-boards.yml on its OWN, slower
 * schedule (every 2 hours, not every 15 min like scan.yml) — see the RATE
 * LIMITS note below for why. Can still be run by hand:
 *   node adzuna_scan.js / npm run scan:ukdesign:adzuna
 *
 * Usage:
 *   node adzuna_scan.js                    -> scan once using configs/default/config.json
 *   node adzuna_scan.js --config=uk-design -> use a different profile
 *   node adzuna_scan.js --json             -> scan once, print raw JSON
 *   node adzuna_scan.js --no-telegram
 *   node adzuna_scan.js --strict            -> hide postings with no disclosed salary
 *   node adzuna_scan.js --min-salary=70000 --max-age=7
 *   node adzuna_scan.js --quiet             -> hide the [adzuna] per-request log lines
 *
 * CREDENTIALS: needs ADZUNA_APP_ID and ADZUNA_APP_KEY env vars — free,
 * instant self-serve signup at https://developer.adzuna.com (no card).
 * One account covers every profile, same as the Telegram bot token — only
 * the destination chat differs per profile, not the API credentials.
 *
 * RATE LIMITS: Adzuna's free tier is 250 calls/day AND 2500 calls/month
 * (the monthly cap is the binding one — 2500/30 ≈ 83/day). This profile's
 * "boardQueries" list (kept short — see configs/uk-design/config.json —
 * separate from the longer "discoveryQueries" list hiring_cafe_scan.js
 * uses, which has no such constraint) is sized so that even hourly runs
 * stay well inside both caps; scan-uk-boards.yml runs it every 2 hours to
 * leave headroom for manual/local testing calls on top of the schedule.
 *
 * NO SCORING: this profile searches a small, literal set of job titles —
 * there's nothing to rank by resume/JD keyword overlap (see
 * job_watch.js's SCORING_ENABLED / "scoring": false). Every result that
 * clears the hard filters (track title match, excluded terms, freshness,
 * location, salary floor) gets sent — no percentage score.
 *
 * SALARY: read directly from Adzuna's own salary_min/salary_max fields —
 * no regex extraction needed, these come structured. Adzuna sometimes
 * estimates a salary itself (salary_is_predicted: "1") when the posting
 * doesn't disclose one; a predicted figure is treated the same as "not
 * listed" here (kept unless --strict) rather than hard-filtered on a
 * guess that isn't the employer's own number.
 *
 * LOCATION: Adzuna's location field is structured (area breadcrumb +
 * display_name), not free description text, so it's normalized into the
 * same "Remote, <region>" / "<City>" shape job_watch.js's other fetchers
 * use (see hiring_cafe_scan.js's hitToJob for the precedent) and run
 * through the same locationAllowed() this whole project shares.
 *
 * DEDUP: its own cursor file, <profile folder>/last_scan_adzuna.json.
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

// Separate, shorter query list from DISCOVERY_QUERIES/hiring.cafe's — see
// the RATE LIMITS note above. Falls back to a small built-in default so a
// config that doesn't set "boardQueries" still works.
const BOARD_QUERIES = CONFIG.boardQueries || ['technical designer', 'retail design manager'];

const ADZUNA_COUNTRY = CONFIG.adzunaCountry || 'gb';
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;

let AZ_LOG_ENABLED = true;
function azLog(msg) {
  if (AZ_LOG_ENABLED) console.error(`[adzuna ${new Date().toISOString()}] ${msg}`);
}

// =================================================================
// DEDUP CURSOR — same one-timestamp model as the other sources.
// =================================================================
const LAST_SCAN_PATH = path.join(DATA_DIR, 'last_scan_adzuna.json');

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

// =================================================================
// FETCH — https://developer.adzuna.com/docs/search. content-type=1 asks
// for the full description (default is a short snippet); sort_by=date
// puts newest first so a short results_per_page still surfaces fresh
// postings first. Deliberately NOT passing salary_min to the API — see
// the SALARY doc note above on why the floor check happens client-side
// instead of trusting the API to apply it (predicted-salary ambiguity).
// =================================================================
const RESULTS_PER_PAGE = 50;

async function fetchAdzunaSearch(query, queryStat) {
  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    what: query,
    results_per_page: String(RESULTS_PER_PAGE),
    sort_by: 'date',
    'content-type': '1'
  });
  const url = `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/1?${params.toString()}`;
  azLog(`GET query="${query}" -> ${url.replace(ADZUNA_APP_KEY, '***')}`);
  const res = await fetch(url);
  azLog(`  <- HTTP ${res.status} for "${query}"`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  const results = data.results || [];
  queryStat.count = data.count ?? null;
  azLog(`  "${query}": ${results.length} returned this page, ${data.count ?? '?'} total match(es)`);
  return results;
}

// Normalizes one Adzuna result into the same shape job_watch.js's other
// fetchers produce, so classifyTrack/locationAllowed/scoreJob apply
// unchanged (see hiring_cafe_scan.js's hitToJob for the precedent).
function hitToJob(hit) {
  const title = hit.title || '';
  const description = hit.description || '';
  const areaText = (hit.location?.area || []).join(', ');
  const displayName = hit.location?.display_name || areaText || '';
  const isRemoteHint = /\bremote\b/i.test(title) || /\bremote\b/i.test(description.slice(0, 400)) || /\bremote\b/i.test(displayName);
  const location = isRemoteHint ? `Remote, ${displayName || areaText || 'UK'}` : displayName;
  const salary = (hit.salary_is_predicted !== '1' && hit.salary_min && hit.salary_max)
    ? { min: Math.round(hit.salary_min), max: Math.round(hit.salary_max) }
    : null;
  return {
    title,
    company: hit.company?.display_name || 'Unknown',
    url: hit.redirect_url,
    updatedAt: hit.created || new Date().toISOString(),
    location,
    description,
    salary
  };
}

async function scanAdzuna(queryStats) {
  const byUrl = new Map();
  for (const query of BOARD_QUERIES) {
    const stat = { query, returned: 0, duplicate: 0, error: null };
    queryStats.push(stat);
    let hits;
    try {
      hits = await fetchAdzunaSearch(query, stat);
    } catch (err) {
      stat.error = err.message;
      console.error(`[adzuna] "${query}": ${err.message}`);
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

// Same filter pipeline as hiring_cafe_scan.js's filterAndScore(): track
// match -> excluded title terms -> freshness -> location -> title region
// check -> salary floor -> (optional) score.
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
      source: 'adzuna',
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
  if (args.includes('--quiet')) { AZ_LOG_ENABLED = false; setApiLogEnabled(false); }
  const minSalaryArg = args.find(a => a.startsWith('--min-salary='));
  const minMatchArg = args.find(a => a.startsWith('--min-match='));
  const maxAgeArg = args.find(a => a.startsWith('--max-age='));
  const minSalary = minSalaryArg ? parseInt(minSalaryArg.split('=')[1], 10) : MIN_SALARY;
  const minMatch = minMatchArg ? parseInt(minMatchArg.split('=')[1], 10) : GOOD_MATCH_THRESHOLD;
  const maxAgeDays = maxAgeArg ? parseFloat(maxAgeArg.split('=')[1]) : MAX_AGE_DAYS;

  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error('[adzuna] ADZUNA_APP_ID / ADZUNA_APP_KEY not set — get a free key at https://developer.adzuna.com. Skipping this source.');
    return;
  }

  azLog(`"${CONFIG.name}": starting scan, ${BOARD_QUERIES.length} quer${BOARD_QUERIES.length === 1 ? 'y' : 'ies'}, country "${ADZUNA_COUNTRY}"`);
  const queryStats = [];
  const rawJobs = await scanAdzuna(queryStats);
  azLog(`${rawJobs.length} unique job(s) collected across all queries; filtering...`);
  const funnel = { noTrackMatch: 0, trackMatched: 0, excludedTitle: 0, tooOld: 0, badLocation: 0, titleRegionExcluded: 0, belowSalary: 0, kept: 0 };
  const results = filterAndScore(rawJobs, { minSalary, maxAgeDays, strict }, funnel);
  azLog(`filtering done: ${funnel.kept} kept of ${rawJobs.length} raw.`);

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
    console.log('\nPer-query results (Adzuna):');
    for (const s of queryStats) {
      if (s.error) { console.log(`  "${s.query}": ERROR — ${s.error}`); continue; }
      console.log(`  "${s.query}": ${s.returned} returned` +
        (s.count != null ? ` (${s.count} total match(es) in Adzuna's index)` : '') +
        (s.duplicate ? ` [${s.duplicate} duplicate]` : ''));
    }
    console.log(`  ${rawJobs.length} unique job(s) across all queries.`);

    console.log(`\nFunnel: ${rawJobs.length} raw -> ${funnel.trackMatched} matched a track` +
      ` -> ${funnel.kept} kept (dropped: ${funnel.noTrackMatch} no track match, ` +
      `${funnel.excludedTitle} excluded title, ${funnel.tooOld} too old (>${maxAgeDays}d), ` +
      `${funnel.badLocation} bad location, ${funnel.titleRegionExcluded} title names excluded region, ` +
      `${funnel.belowSalary} below salary floor)`);

    console.log(`\n[adzuna] Found ${results.length} matching role(s) ` +
      `(min salary floor: ${CURRENCY_SYMBOL}${minSalary.toLocaleString()}, max age: ${maxAgeDays}d):\n`);
    for (const r of results) {
      const hoursAgo = Math.round((Date.now() - new Date(r.postedOrUpdated)) / 3600000);
      console.log(`── ${r.companyDisplay} — ${r.title} [${r.isRemote ? 'REMOTE' : 'hybrid/onsite'}]`);
      console.log(`   Location: ${r.location || 'n/a'} | Salary: ${r.salary} | Posted ${hoursAgo}h ago`);
      console.log(`   Apply: ${r.url}`);
    }
    console.log(`\n${newSinceLastScan.length} of ${results.length} posted/updated since the last Adzuna scan` +
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
    if (toSend.length) statusLog(`[Telegram] Sent ${sent}/${toSend.length} Adzuna alert(s)${SCORING_ENABLED ? ` at/above ${minMatch}% match` : ''}.`);
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

module.exports = { scanAdzuna, filterAndScore };
