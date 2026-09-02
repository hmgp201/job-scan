#!/usr/bin/env node
/**
 * reed_query.js
 * ---------------------------------------------------------------
 * Standalone Reed API tester — NOT part of the scheduled scan pipeline
 * (that's reed_scan.js, which adds track/location/age/salary filtering
 * and Telegram alerting on top of this same API). This just runs ONE
 * search with the parameters below and prints what comes back, for poking
 * at the API directly: trying a different keyword, checking what a
 * server-side locationName/minimumSalary filter actually returns, seeing
 * the raw fields on a result, etc.
 *
 * Usage: edit the PARAMETERS block below, then:
 *   node reed_query.js
 *   node reed_query.js --raw     -> dump the full raw JSON response instead
 *
 * Needs REED_API_KEY — reads it from a .env file in this folder (KEY=VALUE
 * lines) if present, otherwise from the real environment. Free signup:
 * https://www.reed.co.uk/developers/jobseeker
 *
 * Reed uses HTTP Basic auth: the key AS the username, empty password — not
 * a bearer token or query param (see the Authorization header below).
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
// reed_scan.js sends in production for one query (see its
// fetchReedSearch()); everything past RESULTS_TO_TAKE is a real Reed
// param the production script does NOT use (it does salary/location
// filtering client-side instead — see reed_scan.js's SALARY/LOCATION doc
// notes for why) — set any of them to try server-side filtering.
// Full parameter reference: https://www.reed.co.uk/developers/jobseeker
// =================================================================
const KEYWORDS = 'technical designer';   // keyword search. Production loops this over configs/uk-design/config.json's "boardQueries" (5 terms) — one at a time here.
const RESULTS_TO_TAKE = 50;              // results to return (Reed max is 100). Production default.
const RESULTS_TO_SKIP = 0;               // pagination offset. Production always uses 0.

const LOCATION_NAME = null;              // e.g. 'London' — NOT used in production (whole-UK search, filtered client-side).
const DISTANCE_FROM_LOCATION = null;     // miles, only applies with LOCATION_NAME set (Reed default is 10). NOT used in production.
const MINIMUM_SALARY = null;             // e.g. 65000. NOT used in production — see reed_scan.js's SALARY doc note.
const MAXIMUM_SALARY = null;
const PERMANENT = null;                  // true | false | null(any). NOT used in production.
const CONTRACT = null;
const TEMP = null;
const PART_TIME = null;
const FULL_TIME = null;
const GRADUATE = null;
// =================================================================

const REED_API_KEY = process.env.REED_API_KEY;

async function main() {
  if (!REED_API_KEY) {
    console.error('REED_API_KEY not set — add it to .env or export it. Free key: https://www.reed.co.uk/developers/jobseeker');
    process.exit(1);
  }

  const raw = process.argv.includes('--raw');

  const paramObj = {
    keywords: KEYWORDS,
    resultsToTake: String(RESULTS_TO_TAKE),
    resultsToSkip: String(RESULTS_TO_SKIP)
  };
  if (LOCATION_NAME) paramObj.locationName = LOCATION_NAME;
  if (DISTANCE_FROM_LOCATION != null) paramObj.distanceFromLocation = String(DISTANCE_FROM_LOCATION);
  if (MINIMUM_SALARY != null) paramObj.minimumSalary = String(MINIMUM_SALARY);
  if (MAXIMUM_SALARY != null) paramObj.maximumSalary = String(MAXIMUM_SALARY);
  if (PERMANENT != null) paramObj.permanent = String(PERMANENT);
  if (CONTRACT != null) paramObj.contract = String(CONTRACT);
  if (TEMP != null) paramObj.temp = String(TEMP);
  if (PART_TIME != null) paramObj.partTime = String(PART_TIME);
  if (FULL_TIME != null) paramObj.fullTime = String(FULL_TIME);
  if (GRADUATE != null) paramObj.graduate = String(GRADUATE);

  const params = new URLSearchParams(paramObj);
  const url = `https://www.reed.co.uk/api/1.0/search?${params.toString()}`;
  console.error(`GET ${url}\n`);

  const res = await fetch(url, {
    headers: { 'Authorization': 'Basic ' + Buffer.from(`${REED_API_KEY}:`).toString('base64') }
  });
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
  console.log(`${results.length} result(s) returned, ${data.totalResults ?? '?'} total match(es) on Reed.\n`);
  for (const r of results) {
    const salary = (r.minimumSalary && r.maximumSalary)
      ? `${r.currency || '£'}${Math.round(r.minimumSalary).toLocaleString()}-${Math.round(r.maximumSalary).toLocaleString()}`
      : 'not listed';
    console.log(`── ${r.employerName || 'Unknown'} — ${r.jobTitle}`);
    console.log(`   Location: ${r.locationName || 'n/a'} | Salary: ${salary} | Posted: ${r.date || 'n/a'}`);
    console.log(`   ${r.jobUrl}`);
  }
  console.log(`\n(Run with --raw to see the full unfiltered JSON response instead.)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
