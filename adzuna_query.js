#!/usr/bin/env node
/**
 * adzuna_query.js
 * ---------------------------------------------------------------
 * Standalone Adzuna API tester — NOT part of the scheduled scan pipeline
 * (that's adzuna_scan.js, which adds track/location/age/salary filtering
 * and Telegram alerting on top of this same API). This just runs ONE
 * search with the parameters below and prints what comes back, for poking
 * at the API directly: trying a different keyword, checking what a
 * server-side salary_min actually returns, seeing the raw fields on a
 * result, etc.
 *
 * Usage: edit the PARAMETERS block below, then:
 *   node adzuna_query.js
 *   node adzuna_query.js --raw     -> dump the full raw JSON response instead
 *
 * Needs ADZUNA_APP_ID / ADZUNA_APP_KEY — reads them from a .env file in
 * this folder (KEY=VALUE lines) if present, otherwise from the real
 * environment. Free signup: https://developer.adzuna.com
 * ---------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const val = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch { /* no .env — fine, rely on real env vars */ }
})();

// =================================================================
// PARAMETERS — edit these and rerun. Defaults below match exactly what
// adzuna_scan.js sends in production for one query (see its
// fetchAdzunaSearch()); everything past CONTENT_TYPE is a real Adzuna
// param the production script does NOT use (it does salary/location
// filtering client-side instead — see adzuna_scan.js's SALARY/LOCATION
// doc notes for why) — set any of them to try server-side filtering.
// Full parameter reference: https://developer.adzuna.com/docs/search
// =================================================================
const WHAT = 'technical designer';       // keyword search. Production loops this over configs/uk-design/config.json's "boardQueries" (5 terms) — one at a time here.
const COUNTRY = 'gb';                    // Adzuna country code. Production: configs/uk-design/config.json's "adzunaCountry".
const RESULTS_PER_PAGE = 50;             // results in this page (Adzuna max is 50). Production default.
const PAGE = 1;                          // page number. Production always uses page 1.
const SORT_BY = 'date';                  // 'date' | 'relevance' | 'salary'. Production uses 'date' (newest first).
const CONTENT_TYPE = '1';                // '1' = full job description in the response; omit/null for a short snippet. Production uses full.

const WHERE = null;                      // e.g. 'London' — location text filter. NOT used in production (whole-country search, filtered client-side).
const SALARY_MIN = null;                 // e.g. 65000. NOT used in production — see adzuna_scan.js's SALARY doc note (predicted-salary ambiguity).
const SALARY_MAX = null;
const WHAT_EXCLUDE = null;               // e.g. 'internship' — exclude keyword. NOT used in production.
const FULL_TIME = null;                  // 1 | 0 | null(any). NOT used in production.
const PERMANENT = null;                  // 1 | 0 | null(any). NOT used in production.
// =================================================================

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;

async function main() {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error('ADZUNA_APP_ID / ADZUNA_APP_KEY not set — add them to .env or export them. Free key: https://developer.adzuna.com');
    process.exit(1);
  }

  const raw = process.argv.includes('--raw');

  const paramObj = {
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    what: WHAT,
    results_per_page: String(RESULTS_PER_PAGE),
    sort_by: SORT_BY
  };
  if (CONTENT_TYPE) paramObj['content-type'] = CONTENT_TYPE;
  if (WHERE) paramObj.where = WHERE;
  if (SALARY_MIN != null) paramObj.salary_min = String(SALARY_MIN);
  if (SALARY_MAX != null) paramObj.salary_max = String(SALARY_MAX);
  if (WHAT_EXCLUDE) paramObj.what_exclude = WHAT_EXCLUDE;
  if (FULL_TIME != null) paramObj.full_time = String(FULL_TIME);
  if (PERMANENT != null) paramObj.permanent = String(PERMANENT);

  const params = new URLSearchParams(paramObj);
  const url = `https://api.adzuna.com/v1/api/jobs/${COUNTRY}/search/${PAGE}?${params.toString()}`;
  console.error(`GET ${url.replace(ADZUNA_APP_KEY, '<REDACTED>')}\n`);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`HTTP ${res.status}${body ? ` — ${body}` : ''}`);
    process.exit(1);
  }
  const data = await res.json();

  if (raw) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const results = data.results || [];
  console.log(`${results.length} result(s) returned, ${data.count ?? '?'} total match(es) in Adzuna's index.\n`);
  for (const r of results) {
    const salary = (r.salary_min && r.salary_max)
      ? `£${Math.round(r.salary_min).toLocaleString()}-£${Math.round(r.salary_max).toLocaleString()}${r.salary_is_predicted === '1' ? ' (predicted)' : ''}`
      : 'not listed';
    console.log(`── ${r.company?.display_name || 'Unknown'} — ${r.title}`);
    console.log(`   Location: ${r.location?.display_name || 'n/a'} | Salary: ${salary} | Posted: ${r.created || 'n/a'}`);
    console.log(`   ${r.redirect_url}`);
  }
  console.log(`\n(Run with --raw to see the full unfiltered JSON response instead.)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
