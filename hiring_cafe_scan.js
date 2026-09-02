#!/usr/bin/env node
/**
 * hiring_cafe_scan.js
 * ---------------------------------------------------------------
 * A SEPARATE data source from job_watch.js — hiring.cafe (an AI-processed
 * job aggregator across 46+ ATS platforms). Reuses the same profile's
 * search criteria (CV tracks, salary/match/age thresholds, excluded title
 * terms, location policy, Telegram destination) by requiring job_watch.js
 * and running the exact same classifyTrack/scoreJob/locationAllowed logic
 * against hiring.cafe's results — same config, same rules, different feed.
 *
 * Wired into .github/workflows/scan.yml as its own step (separate from
 * job_watch.js's ATS scan) — same schedule, same config, own dedup cursor.
 * Can still be run by hand: node hiring_cafe_scan.js / npm run scan:hiringcafe
 *
 * HOW THIS ACTUALLY WORKS (three approaches tried, in order):
 *   1. hiring.cafe's private search API (POST/GET /api/search-jobs) — DEAD
 *      END. Tested directly with their own frontend's exact headers/payload:
 *      401/405 either way. This is bot-gated, not just undocumented.
 *   2. Reading the server-rendered /search?q=... HTML page and pulling
 *      __NEXT_DATA__.props.pageProps.ssrHits out of it — WORKS, but only
 *      honors the bare keyword. Location/workplace-type/sort filters in
 *      that URL are silently ignored server-side, so it samples an
 *      enormous unfiltered pool (millions of jobs) rather than what the
 *      real UI shows for a filtered search — confirmed by comparing
 *      ssrTotalCount (this route: ~9,360 for a bare keyword) against the
 *      real UI's filtered count (2,300) for the same query.
 *   3. THE ONE ACTUALLY USED: the site's own client-side code doesn't call
 *      /api/search-jobs either — it calls Next.js's built-in data route,
 *      /_next/data/<buildId>/index.json?searchState=<url-encoded JSON>,
 *      confirmed via Playwright network capture of a real browser session.
 *      That route is NOT gated (plain HTTP works, verified directly) and
 *      fully honors searchQuery/workplaceTypes/sortBy/locations — verified
 *      to produce the exact same ssrTotalCount/ssrCompanyCount the real,
 *      filtered UI shows. <buildId> changes on every hiring.cafe deploy, so
 *      it's re-resolved from any page load's embedded __NEXT_DATA__.buildId
 *      at the start of each run (see resolveBuildId()).
 *
 * Usage:
 *   node hiring_cafe_scan.js                    -> scan once using configs/default/config.json
 *   node hiring_cafe_scan.js --config=other      -> use a different profile
 *   node hiring_cafe_scan.js --json              -> scan once, print raw JSON
 *   node hiring_cafe_scan.js --no-telegram
 *   node hiring_cafe_scan.js --strict             -> hide postings with no transparent salary
 *   node hiring_cafe_scan.js --min-salary=200000 --min-match=15 --max-age=7
 *   node hiring_cafe_scan.js --quiet              -> hide the [hc] per-request log lines
 *
 * hiring.cafe doesn't expose the raw job description text (it's LLM-
 * processed into structured fields), so the "description" scored against
 * track skill terms here is a synthetic string built from its
 * requirements_summary + technical_tools + role_activities fields, and
 * salary is read directly from its structured compensation fields (only
 * when it flags the listing as having transparent, yearly compensation)
 * rather than regex-parsed out of description text.
 *
 * LOCATION: this profile's target region for hiring.cafe's own location
 * filter comes from the config's "hiringCafeLocation" field (HIRING_CAFE_LOCATION
 * below), defaulting to "United States" if a config omits it — see
 * configs/uk-design/config.json for a non-US example. The broader
 * remote/hybrid ALLOW-list logic (locationAllowed(), reused from
 * job_watch.js) still applies on top of that per-job, same as every other
 * source.
 *
 * DEDUP: its own cursor file, <profile folder>/last_scan_hiringcafe.json —
 * separate from job_watch.js's last_scan.json so the two sources' schedules
 * don't interfere with each other. Same date-based model: a job counts as
 * new if hiring.cafe's estimated_publish_date is after the last run that
 * actually sent Telegram alerts for this source.
 * ---------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const {
  CONFIG, DATA_DIR, DISCOVERY_QUERIES,
  classifyTrack, scoreJob, locationAllowed,
  REMOTE_INCLUDE_RE, REMOTE_EXCLUDE_RE,
  MIN_SALARY, GOOD_MATCH_THRESHOLD, MAX_AGE_DAYS, EXCLUDED_TITLE_TERMS, CURRENCY_SYMBOL, SCORING_ENABLED,
  formatTelegramMessage, sendTelegramMessage, setApiLogEnabled
} = require('./job_watch.js');

// See the LOCATION doc note above. Set per-config as "hiringCafeLocation"
// (full nested shape — verified directly that a partial object, just
// formatted_address/types, silently zeroes out ALL results rather than
// erroring, so don't trim a config's copy of this down even though most of
// it looks redundant). Defaults to this project's original US targeting.
const HIRING_CAFE_LOCATION = CONFIG.hiringCafeLocation || {
  formatted_address: 'United States',
  types: ['country'],
  geometry: { location: { lat: '39.8283', lon: '-98.5795' } },
  id: 'user_country',
  address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
  options: { flexible_regions: ['anywhere_in_continent', 'anywhere_in_world'] }
};

let HC_LOG_ENABLED = true;
function hcLog(msg) {
  if (HC_LOG_ENABLED) console.error(`[hc ${new Date().toISOString()}] ${msg}`);
}

// =================================================================
// DEDUP CURSOR — same one-timestamp model as job_watch.js's last_scan.json,
// kept in its own file so this source's schedule is independent.
// =================================================================
const LAST_SCAN_PATH = path.join(DATA_DIR, 'last_scan_hiringcafe.json');

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
// BUILD ID — Next.js stamps every deploy with a new build id; the data
// route below is namespaced under it. Resolved once per run from any
// page's embedded __NEXT_DATA__ blob (any page works; this uses /search
// with a throwaway query so the fetch itself also sanity-checks the site
// is reachable before we commit to 8 more requests).
// =================================================================
async function resolveBuildId() {
  const url = 'https://hiringcafe.com/search?q=job';
  hcLog(`GET ${url} (resolving current Next.js build id)`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-watch)' } });
  hcLog(`  <- HTTP ${res.status}`);
  if (!res.ok) throw new Error(`Could not load hiringcafe.com to resolve build id: HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found on hiringcafe.com — page structure may have changed.');
  let data;
  try { data = JSON.parse(m[1]); } catch (err) { throw new Error(`__NEXT_DATA__ was not valid JSON: ${err.message}`); }
  if (!data.buildId) throw new Error('__NEXT_DATA__ had no buildId field — page structure may have changed.');
  hcLog(`  build id: ${data.buildId}`);
  return data.buildId;
}

// =================================================================
// FETCH — the real data route the site's own client code calls (see the
// header comment for how this was found). One retry with a freshly
// re-resolved build id if we get a 404, since that's the one expected
// failure mode (hiring.cafe deployed a new build between our buildId
// resolution and this request).
// =================================================================
async function fetchHiringCafeSearch(query, buildId, queryStat) {
  const searchState = {
    searchQuery: query,
    locations: [HIRING_CAFE_LOCATION],
    workplaceTypes: ['Remote', 'Hybrid', 'Onsite'],
    sortBy: 'date',
    dateFetchedPastNDays: 90
  };
  const url = `https://hiringcafe.com/_next/data/${buildId}/index.json?searchState=${encodeURIComponent(JSON.stringify(searchState))}`;
  hcLog(`GET query="${query}" -> ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-watch)', 'Accept': 'application/json' }
  });
  hcLog(`  <- HTTP ${res.status} for "${query}"`);
  if (res.status === 404) {
    queryStat.staleBuildIdRetry = true;
    throw Object.assign(new Error(`HTTP 404 (stale build id?)`), { staleBuildId: true });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const pp = data.pageProps || {};
  queryStat.ssrTotalCount = pp.ssrTotalCount ?? null;
  queryStat.ssrCompanyCount = pp.ssrCompanyCount ?? null;
  const hits = pp.ssrHits || [];
  hcLog(`  "${query}": ${hits.length} returned this page, ${pp.ssrTotalCount ?? '?'} total match(es) across ${pp.ssrCompanyCount ?? '?'} companies`);
  return hits;
}

// job_watch.js's location exclude/include patterns are written for free-text
// country names ("canada", "united kingdom", "europe"...), but hiring.cafe's
// workplace_countries is a list of 2-letter ISO codes ("CA", "GB"...) — a
// bare code like "CA"/"BE" never matches those word-based patterns, which
// would let a Canada/Belgium-only remote role (not open to the US) slip
// through unexcluded. Map codes to the same country/region words the
// default config's patterns already look for, so locationAllowed() sees
// real text instead of opaque codes it can't recognize.
const COUNTRY_CODE_LABELS = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', AU: 'Australia',
  IN: 'India', DE: 'Germany', JP: 'Japan', SG: 'Singapore', BR: 'Brazil',
  MX: 'Mexico', PL: 'Poland', PH: 'Philippines', KR: 'South Korea', TR: 'Turkey',
  FR: 'Europe', ES: 'Europe', IT: 'Europe', NL: 'Europe', IE: 'Europe',
  PT: 'Europe', BE: 'Europe', CH: 'Europe', AT: 'Europe', SE: 'Europe',
  NO: 'Europe', DK: 'Europe', FI: 'Europe', RO: 'Europe', GR: 'Europe',
  CZ: 'Europe', HU: 'Europe', BG: 'Europe', HR: 'Europe', SK: 'Europe',
  SI: 'Europe', LT: 'Europe', LV: 'Europe', EE: 'Europe', UA: 'Europe',
  RS: 'Europe', IS: 'Europe', LU: 'Europe', MT: 'Europe', CY: 'Europe',
  CN: 'APAC', NZ: 'APAC', HK: 'APAC', TW: 'APAC', TH: 'APAC', VN: 'APAC',
  ID: 'APAC', MY: 'APAC', PK: 'APAC', BD: 'APAC', NP: 'APAC', LK: 'APAC',
  AE: 'EMEA', SA: 'EMEA', IL: 'EMEA', ZA: 'EMEA', EG: 'EMEA',
  QA: 'EMEA', KW: 'EMEA', BH: 'EMEA', OM: 'EMEA', JO: 'EMEA', LB: 'EMEA',
  MA: 'EMEA', NG: 'EMEA', KE: 'EMEA', GH: 'EMEA',
  AR: 'LATAM', CL: 'LATAM', CO: 'LATAM', PE: 'LATAM', UY: 'LATAM',
  EC: 'LATAM', VE: 'LATAM', PA: 'LATAM', GT: 'LATAM', CR: 'LATAM'
};
function labelCountryCode(code) { return COUNTRY_CODE_LABELS[code] || code; }

// Normalizes one hiring.cafe hit into the same shape job_watch.js's own
// fetchers produce, so classifyTrack/scoreJob/locationAllowed apply unchanged.
function hitToJob(hit) {
  const v5 = hit.v5_processed_job_data || {};
  const isRemote = v5.workplace_type === 'Remote';
  const location = isRemote
    ? `Remote, ${(v5.workplace_countries || []).map(labelCountryCode).join('/') || 'unspecified'}`
    : (v5.formatted_workplace_location || '');
  const description = [
    v5.requirements_summary || '',
    (v5.technical_tools || []).join(' '),
    (v5.role_activities || []).join(' ')
  ].join(' ').trim();
  const salary = (v5.is_compensation_transparent
    && v5.listed_compensation_frequency === 'Yearly'
    && v5.yearly_min_compensation && v5.yearly_max_compensation)
    ? { min: v5.yearly_min_compensation, max: v5.yearly_max_compensation }
    : null;
  return {
    title: hit.job_information?.title || v5.core_job_title || '',
    company: v5.company_name || hit.attributed_org?.name || hit.attributed_org_card?.name || 'Unknown',
    url: hit.apply_url,
    updatedAt: v5.estimated_publish_date || new Date().toISOString(),
    location,
    isRemote,
    description,
    salary,
    expired: !!hit.is_expired
  };
}

async function scanHiringCafe(queryStats) {
  let buildId = await resolveBuildId();
  const byUrl = new Map();
  for (const query of DISCOVERY_QUERIES) {
    const stat = { query, returned: 0, expired: 0, duplicate: 0, error: null };
    queryStats.push(stat);
    let hits;
    try {
      hits = await fetchHiringCafeSearch(query, buildId, stat);
    } catch (err) {
      if (err.staleBuildId) {
        hcLog(`  build id looks stale, re-resolving and retrying "${query}"...`);
        try {
          buildId = await resolveBuildId();
          hits = await fetchHiringCafeSearch(query, buildId, stat);
        } catch (retryErr) {
          stat.error = retryErr.message;
          console.error(`[hiring.cafe] "${query}": ${retryErr.message}`);
          continue;
        }
      } else {
        stat.error = err.message;
        console.error(`[hiring.cafe] "${query}": ${err.message}`);
        continue;
      }
    }
    stat.returned = hits.length;
    for (const hit of hits) {
      const job = hitToJob(hit);
      if (!job.url) continue;
      if (job.expired) { stat.expired++; continue; }
      if (byUrl.has(job.url)) { stat.duplicate++; continue; }
      byUrl.set(job.url, job);
    }
  }
  return [...byUrl.values()];
}

// Same filter pipeline as job_watch.js's scanAll()'s consider(): track match
// -> excluded title terms -> freshness -> location -> title region check ->
// salary floor -> score. Kept separate (not exported/shared) since the raw
// job shape differs enough between sources that forcing one function to
// handle both would need more branching than duplicating ~25 lines here.
// `funnel` gets populated with per-stage drop counts so you can see WHERE
// candidates get filtered out, not just the final survivor count.
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

    // Titles sometimes carry the region even when location doesn't.
    if (REMOTE_EXCLUDE_RE.test(titleLower) && !REMOTE_INCLUDE_RE.test(titleLower)) { funnel.titleRegionExcluded++; continue; }

    if (job.salary && job.salary.max < minSalary) { funnel.belowSalary++; continue; }
    if (!job.salary && strict) { funnel.belowSalary++; continue; }

    const { matchPct, haveTerms, haveBonusTerms, suggestedSwaps } = scoreJob(job, trackKey);
    funnel.kept++;
    results.push({
      companyDisplay: job.company,
      source: 'hiringcafe',
      isRemote,
      track: CONFIG.tracks[trackKey].label,
      trackKey,
      resumeFile: CONFIG.tracks[trackKey].resumeFile,
      title: job.title,
      location: job.location,
      url: job.url,
      postedOrUpdated: job.updatedAt,
      matchPct,
      matchedTerms: haveTerms,
      bonusTerms: haveBonusTerms,
      suggestedSwaps,
      salary: job.salary ? `${CURRENCY_SYMBOL}${job.salary.min.toLocaleString()}-${CURRENCY_SYMBOL}${job.salary.max.toLocaleString()}` : 'not listed'
    });
  }
  results.sort((a, b) =>
    b.matchPct - a.matchPct || (a.isRemote === b.isRemote ? 0 : a.isRemote ? -1 : 1)
  );
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const noTelegram = args.includes('--no-telegram');
  const strict = args.includes('--strict');
  if (args.includes('--quiet')) { HC_LOG_ENABLED = false; setApiLogEnabled(false); }
  const minSalaryArg = args.find(a => a.startsWith('--min-salary='));
  const minMatchArg = args.find(a => a.startsWith('--min-match='));
  const maxAgeArg = args.find(a => a.startsWith('--max-age='));
  const minSalary = minSalaryArg ? parseInt(minSalaryArg.split('=')[1], 10) : MIN_SALARY;
  // hiring.cafe's synthetic description (built from requirements_summary +
  // technical_tools + role_activities, not the real JD text — see the header
  // note) tends to score lower than a real posting against the same skill
  // list, so a config can set a separate, more lenient floor for this source
  // via "hiringCafeMinMatch" (falls back to the shared minMatch if unset, so
  // existing configs are unaffected).
  const minMatch = minMatchArg ? parseInt(minMatchArg.split('=')[1], 10) : (CONFIG.hiringCafeMinMatch ?? GOOD_MATCH_THRESHOLD);
  const maxAgeDays = maxAgeArg ? parseFloat(maxAgeArg.split('=')[1]) : MAX_AGE_DAYS;

  hcLog(`"${CONFIG.name}": starting scan, ${DISCOVERY_QUERIES.length} quer${DISCOVERY_QUERIES.length === 1 ? 'y' : 'ies'}, target location "${HIRING_CAFE_LOCATION.formatted_address}"`);
  const queryStats = [];
  const rawJobs = await scanHiringCafe(queryStats);
  hcLog(`${rawJobs.length} unique non-expired job(s) collected across all queries; filtering...`);
  const funnel = { noTrackMatch: 0, trackMatched: 0, excludedTitle: 0, tooOld: 0, badLocation: 0, titleRegionExcluded: 0, belowSalary: 0, kept: 0 };
  const results = filterAndScore(rawJobs, { minSalary, maxAgeDays, strict }, funnel);
  hcLog(`filtering done: ${funnel.kept} kept of ${rawJobs.length} raw.`);

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
    console.log('\nPer-query results (hiring.cafe):');
    for (const s of queryStats) {
      if (s.error) { console.log(`  "${s.query}": ERROR — ${s.error}`); continue; }
      const notes = [];
      if (s.expired) notes.push(`${s.expired} expired`);
      if (s.duplicate) notes.push(`${s.duplicate} duplicate`);
      console.log(`  "${s.query}": ${s.returned} returned` +
        (s.ssrTotalCount != null ? ` (${s.ssrTotalCount} total match(es) in ${s.ssrCompanyCount} companies)` : '') +
        (notes.length ? ` [${notes.join(', ')}]` : ''));
    }
    console.log(`  ${rawJobs.length} unique non-expired job(s) across all queries.`);

    console.log(`\nFunnel: ${rawJobs.length} raw -> ${funnel.trackMatched} matched a track` +
      ` -> ${funnel.kept} kept (dropped: ${funnel.noTrackMatch} no track match, ` +
      `${funnel.excludedTitle} excluded title, ${funnel.tooOld} too old (>${maxAgeDays}d), ` +
      `${funnel.badLocation} bad location, ${funnel.titleRegionExcluded} title names excluded region, ` +
      `${funnel.belowSalary} below salary floor)`);

    console.log(`\n[hiring.cafe] Found ${results.length} matching role(s) ` +
      `(min salary floor: ${CURRENCY_SYMBOL}${minSalary.toLocaleString()}, max age: ${maxAgeDays}d):\n`);
    for (const r of results) {
      const hoursAgo = Math.round((Date.now() - new Date(r.postedOrUpdated)) / 3600000);
      console.log(`── ${r.companyDisplay} — ${r.title} [${r.isRemote ? 'REMOTE' : 'hybrid/onsite'}]`);
      console.log(`   Track: ${r.track} | Location: ${r.location || 'n/a'} | Salary: ${r.salary} | Posted ${hoursAgo}h ago${SCORING_ENABLED ? ` | Match: ${r.matchPct}%` : ''}`);
      console.log(`   Apply: ${r.url}`);
      if (SCORING_ENABLED) {
        if (r.matchedTerms && r.matchedTerms.length) console.log(`   Matched: ${r.matchedTerms.join(', ')}`);
        if (r.bonusTerms && r.bonusTerms.length) console.log(`   + Bonus tools: ${r.bonusTerms.join(', ')}`);
      }
    }
    console.log(`\n${newSinceLastScan.length} of ${results.length} posted/updated since the last hiring.cafe scan` +
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
    if (toSend.length) statusLog(`[Telegram] Sent ${sent}/${toSend.length} hiring.cafe alert(s)${SCORING_ENABLED ? ` at/above ${minMatch}% match` : ''}.`);
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

module.exports = { scanHiringCafe, filterAndScore, resolveBuildId };
