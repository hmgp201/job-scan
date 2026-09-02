#!/usr/bin/env node
/**
 * job_watch.js
 * ---------------------------------------------------------------
 * Polls company ATS APIs directly (Greenhouse, Ashby, Lever) so you:
 *   1. See postings the moment they go live (before LinkedIn/Indeed re-post them)
 *   2. Always get the canonical "apply on company site" link
 *   3. Get a keyword-match score + exact-term swap suggestions per CV track,
 *      WITHOUT rewriting sentences (so it never reads as AI-tailored)
 *
 * Usage:
 *   node job_watch.js                    -> scan once using configs/default/config.json
 *   node job_watch.js --config=other      -> scan once using configs/other/config.json
 *   node job_watch.js --json             -> scan once, print raw JSON
 *   node job_watch.js --min-salary=200000 -> override the config's salary floor
 *   node job_watch.js --strict           -> hide postings that don't list a salary at all
 *   node job_watch.js --watch=1800       -> re-scan every 1800s (30 min), only alert on NEW postings
 *   node job_watch.js --min-match=50     -> only send Telegram alerts for jobs at/above this match %
 *   node job_watch.js --max-age=7        -> override the config's freshness window
 *   node job_watch.js --quiet            -> hide per-request API logs (they go
 *                                           to stderr; stdout/--json stay clean)
 *
 * CONFIG FILES (configs/<profile>/config.json): a config is everything that
 * makes one search distinct — CV tracks (title keywords + skill terms per
 * track), the seed company list, salary/match/age thresholds, excluded title
 * terms, and which Telegram bot/chat env vars to use. This lets the same
 * script run more than one independent search (different CVs, different
 * companies, alerting to different Telegram chats) without them sharing
 * state — each profile's config.json and all the state files it generates
 * live together in one folder under configs/. See the CONFIG FILE section
 * below (~line 130) for the file format and how to add a new one.
 *
 * HARD FILTERS (set per-config; see configs/default/config.json):
 *   - Postings older than maxAgeDays are dropped.
 *   - Titles containing excludedTitleTerms (marketing etc.) are dropped.
 *   - Location must be remote-in-target-region OR hybrid/onsite in one of the
 *     config's listed cities (set per-config as "location"; defaults to US
 *     remote / Washington DC / Richmond VA if omitted — see locationAllowed()).
 *     The same excluded-region check also runs against the TITLE (e.g. a
 *     "Solutions Engineer - EMEA" or "AE, LATAM" title is dropped even if the
 *     location field itself is ambiguous or just says "Remote").
 *     Remote sorts above hybrid everywhere.
 *
 *   node job_watch.js --add-company="Second Nature"
 *       -> auto-resolves the company's Greenhouse/Ashby/Lever board slug and
 *          saves it to this config's companies.csv. No more hunting for slugs
 *          by hand. Repeatable flag. If auto-resolution picks the wrong board
 *          (or finds several), force it:
 *   node job_watch.js --add-company="Second Nature" --ats=greenhouse --slug=secondnature
 *
 *   Workday doesn't fit that auto-guess (its "site" code is arbitrary — e.g.
 *   Nike's is "nke", not "nike"), so force it with the full board URL once
 *   you have one (find it via --careers-url below, or by watching a
 *   company's careers page redirect to *.myworkdayjobs.com):
 *   node job_watch.js --add-company="Nike" --ats=workday --slug="https://nike.wd1.myworkdayjobs.com/nke"
 *
 *   node job_watch.js --add-company="Retool" --careers-url="https://retool.com/careers"
 *       -> for companies NOT on a supported ATS: scrape their own careers
 *          page, no AI involved. Detection cascade: (1) embedded known-ATS
 *          board hiding in the HTML (Greenhouse/Lever/Ashby/Workday/
 *          Workable/Recruitee/SmartRecruiters/Rippling -> their public JSON
 *          APIs — this is how most Workday boards get found in practice: a
 *          company's own careers page is a thin marketing shell over a
 *          myworkdayjobs.com tenant, and even a client-side-rendered shell
 *          usually leaks one absolute job link to it in the initial HTML),
 *          (2) schema.org JobPosting JSON-LD blocks, (3) job-link URL
 *          pattern grouping. Limitation: pages with NO such link anywhere in
 *          the initial HTML can't be scraped this way — the add command
 *          tests the page and tells you what it found before saving.
 *
 *   THE COMPANY LIST LIVES ONLY IN <profile folder>/companies.csv — created
 *   empty (header-only) on first run for a new profile; populate it with
 *   --add-company / --careers-url / hand-editing. Columns: Name,ATS,Slug,
 *   URL,AddedAt,Via — edit it by hand freely. ATS is greenhouse|ashby|lever
 *   (uses Slug) or custom|workday (uses URL — any
 *   https://<tenant>.<dc>.myworkdayjobs.com/<site> board URL for workday).
 *
 *   NOTE: this is a one-way notifier, not a chat bot — it only SENDS
 *   Telegram messages. It runs as a scheduled GitHub Actions cron job with
 *   no long-running process to receive replies, so there's no way to manage
 *   the company list from Telegram; use --add-company / --careers-url or
 *   edit companies.csv directly instead.
 *
 *   node job_watch.js --discover         -> ALSO run an open-discovery pass over
 *          the Remotive and The Muse public aggregator APIs. Broader net, lower
 *          precision: surfaces roles at companies NOT on your list. Hits go
 *          through the exact same track/salary/match pipeline. Any discovered
 *          company whose job clears --min-match gets its ATS slug auto-resolved
 *          and added to this config's companies.csv for direct tracking going
 *          forward (disable that with --no-autoadd). Works with --watch too.
 *
 * SALARY FILTERING: pulls the range straight out of the job description text
 * (most US states legally require this). A posting is dropped only if its
 * OWN stated maximum is below your floor. If no range is listed at all, the
 * posting is still shown (flagged "not listed") unless you pass --strict —
 * plenty of legitimate $180k+ roles simply don't disclose in the JD.
 *
 * DEDUPLICATION is date-based, not a per-job ledger: last_scan.json holds one
 * timestamp — the start of the last run that actually sent Telegram alerts.
 * Each run fetches ALL jobs meeting the criteria and prints them; a job goes
 * to Telegram only if the ATS reports it posted/updated after that timestamp
 * (or there's no timestamp yet, e.g. the first run for this profile). The
 * timestamp only advances once a run actually attempts to send (i.e. not
 * --no-telegram), so a disabled/misconfigured Telegram doesn't cause jobs to
 * be silently skipped once it's fixed. Works the same for --watch and
 * scheduled runs. See the DEDUP CURSOR section below for the trade-off this
 * makes vs. remembering every job ever seen.
 *
 * SCHEDULING: .github/workflows/scan.yml runs `node job_watch.js --config=...`
 * per configured search every 15 minutes via GitHub Actions cron (plus a
 * separate hiring_cafe_scan.js step, same schedule, own dedup cursor — see
 * that file's header), then commits any changed state files back to the
 * repo so each config's scan cursor persists between runs. Set each
 * config's Telegram env vars (default.json uses
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID; a second config would use whatever
 * botTokenEnv/chatIdEnv names it declares, e.g. TELEGRAM_BOT_TOKEN_OTHER) as
 * repo secrets (Settings -> Secrets and variables -> Actions). Trigger a run
 * manually from the Actions tab (workflow_dispatch) to test without waiting
 * for the schedule.
 *
 * TELEGRAM ALERTS: each config names two env vars under "telegram" (default:
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — set them before running:
 *   <botTokenEnv>  -> from @BotFather on Telegram (message it "/newbot")
 *   <chatIdEnv>    -> message your new bot once, then visit
 *                     https://api.telegram.org/bot<TOKEN>/getUpdates
 *                     and copy the "chat":{"id": ...} value
 * Only NEW postings that meet --min-match get pushed — this keeps the chat
 * to genuinely good matches, not every posting found.
 *
 * Requires: Node 18+ (built-in fetch). No npm install needed.
 * ---------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

// Load .env sitting next to this script (KEY=VALUE / KEY="VALUE" lines) so
// TELEGRAM_* work without exporting them in the shell. Real env vars win.
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
// CONFIG FILE / PROFILE FOLDER — a "profile" is one self-contained folder
// under configs/ holding config.json (everything that makes one search
// distinct: CV tracks, salary/match/age thresholds, location policy, and
// which Telegram bot/chat the alerts go to — deliberately NOT the company
// list, see COMPANY LIST below) PLUS every state file that config generates
// (companies.csv, last_scan.json, slug_cache.json). Anything that's the
// same for every profile (this script, .env, package.json, the GitHub
// Actions workflow) stays at the repo root, not duplicated per profile —
// only what's unique to a search lives in its folder.
//
//   node job_watch.js --config=default              (-> configs/default/config.json)
//   node job_watch.js --config=configs/default       (same, explicit)
//   node job_watch.js --config=configs/default/config.json  (fully explicit)
//   node job_watch.js                                (defaults to configs/default/config.json)
//
// To run a second, independent search: `mkdir configs/other-search`, copy
// configs/default/config.json into it and edit its "tracks"/thresholds/
// "location" (a candidate based somewhere else should set "location" to
// their own target region/cities — see LOCATION POLICY below), and point
// its "telegram.botTokenEnv"/"telegram.chatIdEnv" at a different pair of env
// var names (e.g. TELEGRAM_BOT_TOKEN_OTHER) whose actual values you set in
// .env locally and as separate GitHub Actions secrets — the config file
// itself never holds a real token, only the name of the env var to read.
// That folder's companies.csv gets created empty on first run — populate it
// with --add-company / --careers-url / hand-editing, same as any profile.
// =================================================================
function resolveConfigPath(raw) {
  if (!raw) return path.join(__dirname, 'configs', 'default', 'config.json');
  if (raw.endsWith('.json')) return path.resolve(__dirname, raw); // explicit file
  if (raw.includes('/')) return path.resolve(__dirname, raw, 'config.json'); // explicit folder
  return path.join(__dirname, 'configs', raw, 'config.json'); // shorthand: profile name
}

function loadConfig() {
  const arg = process.argv.find(a => a.startsWith('--config='));
  const configPath = resolveConfigPath(arg ? arg.split('=').slice(1).join('=') : null);
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch { throw new Error(`Config file not found: ${configPath}`); }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (err) { throw new Error(`Config file ${configPath} is not valid JSON: ${err.message}`); }
  if (!cfg.tracks || !Object.keys(cfg.tracks).length) throw new Error(`Config file ${configPath} needs a non-empty "tracks" object.`);
  cfg._path = configPath;
  cfg.name = cfg.name || path.basename(path.dirname(configPath));
  cfg.telegram = cfg.telegram || {};
  cfg.telegram.botTokenEnv = cfg.telegram.botTokenEnv || 'TELEGRAM_BOT_TOKEN';
  cfg.telegram.chatIdEnv = cfg.telegram.chatIdEnv || 'TELEGRAM_CHAT_ID';
  return cfg;
}

const CONFIG = loadConfig();
console.error(`[config] Using "${CONFIG.name}" (${CONFIG._path}) — Telegram via ${CONFIG.telegram.botTokenEnv}/${CONFIG.telegram.chatIdEnv}`);

// Where state files live (companies.csv, last_scan.json, slug_cache.json):
// always the same folder the active config.json itself lives in, so a
// profile's config and its state travel together. JOB_WATCH_DATA_DIR still
// overrides this, e.g. for tests.
const DATA_DIR = process.env.JOB_WATCH_DATA_DIR || path.dirname(CONFIG._path);

// =================================================================
// API REQUEST LOGGING
// Every outbound HTTP request (ATS boards, discovery APIs, slug probes,
// Telegram) is logged to STDERR with a sequence number, status, and
// latency — so you can see exactly which requests happen and whether
// they're working. stdout stays clean, so --json is still parseable.
// Disable with --quiet. Telegram tokens are redacted from logged URLs.
// =================================================================
let API_LOG_ENABLED = true; // main() flips this off when --quiet is passed
const apiStats = { total: 0, failed: 0 };
let apiSeq = 0;

// For other scripts that require() this file (e.g. hiring_cafe_scan.js) and
// want their own --quiet to also quiet the shared fetch-logging wrapper below.
function setApiLogEnabled(v) { API_LOG_ENABLED = v; }

function apiLog(msg) {
  if (API_LOG_ENABLED) console.error(`[api ${new Date().toISOString()}] ${msg}`);
}

function redactUrl(url) {
  return String(url)
    .replace(/\/bot[^/]+\//, '/bot<TOKEN>/')
    // Generic credential-bearing query params (Adzuna's app_key, Reed's key=
    // if ever passed that way, any future source's api_key/token/secret) —
    // app_id/client_id etc are left alone since those aren't secret on their
    // own. Caught in practice: Adzuna's app_key was logged here in full
    // before this existed.
    .replace(/([?&](?:\w*(?:api|app)[_-]?key|\w*access[_-]?token|\btoken|\bsecret|\bpassword)=)[^&]+/gi, '$1<REDACTED>');
}

const rawFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const id = ++apiSeq;
  apiStats.total++;
  const method = opts?.method || 'GET';
  const shown = redactUrl(url);
  const t0 = Date.now();
  apiLog(`#${id} -> ${method} ${shown}`);
  try {
    const res = await rawFetch(url, opts);
    if (!res.ok) apiStats.failed++;
    apiLog(`#${id} <- HTTP ${res.status}${res.ok ? '' : ` ${res.statusText}`} in ${Date.now() - t0}ms  ${shown}`);
    return res;
  } catch (err) {
    apiStats.failed++;
    apiLog(`#${id} <- NETWORK ERROR (${err.message}) in ${Date.now() - t0}ms  ${shown}`);
    throw err;
  }
};

// =================================================================
// 1. CV TRACKS — keywords pulled directly from each resume's SKILLS section,
//    diffed against each job description. A config can define as many tracks
//    as it wants (this project's default has three); see configs/default/config.json.
// =================================================================
const TRACKS = CONFIG.tracks;

// Common synonym pairs: [job-description phrasing, your resume phrasing]
// When a JD uses the left term and you only have the right term (or vice versa),
// the tool flags it as a 1-word/1-phrase swap — never a rewrite.
const SYNONYMS = CONFIG.synonyms || [];

// Minimum acceptable base salary. Many states (CA, CO, NY, WA, IL, etc.)
// legally require salary ranges in postings, so this is extracted straight
// from the job description text — no external salary API needed.
// Set per-config as "minSalary"; override at runtime with --min-salary=200000
const MIN_SALARY = CONFIG.minSalary ?? 180000;

// Minimum keyword-match % for a job to be "good enough" to push to Telegram
// (and, with --discover, to auto-add the company for direct tracking).
// NOTE ON SCALE: the score is (CORE skill terms found in the JD) / (the
// track's core skill-term list — see scoreJob()), so even excellent fits
// often score well under 100% — a JD never mentions every term on the list.
// Calibrated 2026-08-29, after splitting skillTerms into core/bonus, against
// a full scan (70 matching roles: median 9%, top quartile 12%, top decile
// 16%, max 36%). Recalibrate per-config against a full scan of your own
// results if you edit a track's core list size.
// Set per-config as "minMatch"; override at runtime with --min-match=15
const GOOD_MATCH_THRESHOLD = CONFIG.minMatch ?? 5;

// A config for a literal, small set of job titles (rather than a broad,
// fuzzy "similar roles" search) has no real use for a resume/JD keyword-
// overlap score — every title in the search IS the target, there's nothing
// to rank by fit. Set per-config as "scoring": false to turn the whole
// skillTerms/matchPct/minMatch machinery off: classifyTrack (title match)
// and the hard filters (age/location/salary/excluded terms) still apply,
// every job that clears them gets sent, and Telegram messages/console
// output drop the Match/Matched/Bonus lines. Defaults to on (true) so
// existing configs are unaffected.
const SCORING_ENABLED = CONFIG.scoring !== false;

// Ignore postings older than this many days (based on the ATS's own
// posted/updated timestamp). Set per-config as "maxAgeDays"; override at
// runtime with --max-age=7
const MAX_AGE_DAYS = CONFIG.maxAgeDays ?? 3;

// Display-only symbol for salary output. Set per-config as "currencySymbol"
// (e.g. "£" for a GBP-targeted config) — extractSalaryRange() below matches
// both $ and £ regardless of this setting; it only controls how MIN_SALARY
// and extracted ranges are printed.
const CURRENCY_SYMBOL = CONFIG.currencySymbol || '$';

// Titles containing any of these are dropped no matter what track they'd
// otherwise match (e.g. "Strategy & Operations Lead, Enterprise Marketing").
// Set per-config as "excludedTitleTerms".
const EXCLUDED_TITLE_TERMS = CONFIG.excludedTitleTerms || [];

// LOCATION POLICY (set per-config as "location"; see configs/default/config.json):
// remote roles are allowed if they name/imply the config's target region (or
// say nothing at all — kept for manual vetting) and don't name an excluded
// region (e.g. "Remote - EMEA" dropped for a US-targeted config); hybrid/
// onsite roles are allowed only in the config's listed cities. A config that
// omits "location" gets this project's original policy (US remote, or
// hybrid/onsite in Washington DC / Richmond VA) as the default. Remote roles
// sort above hybrid ones in output and alerts. remoteExcludePattern/
// remoteIncludePattern also get checked against the job TITLE (see the
// consider() pipeline below) — some postings only name their region there
// ("Solutions Engineer - EMEA", "AE, LATAM") rather than in location.
const LOCATION_CONFIG = CONFIG.location || {};
const REMOTE_INCLUDE_RE = new RegExp(
  LOCATION_CONFIG.remoteIncludePattern ||
  'united states|\\bus\\b|\\busa\\b|north america|americas|worldwide|anywhere|global', 'i');
const REMOTE_EXCLUDE_RE = new RegExp(
  LOCATION_CONFIG.remoteExcludePattern ||
  'emea|europe|apac|latam|mena|\\bcanada\\b|\\buk\\b|united kingdom|\\bireland\\b|\\bfrance\\b|\\bgermany\\b|\\bspain\\b|\\bitaly\\b|\\bportugal\\b|netherlands|\\bbelgium\\b|switzerland|\\baustria\\b|\\bsweden\\b|\\bnorway\\b|\\bdenmark\\b|\\bfinland\\b|\\bpoland\\b|\\bromania\\b|\\bgreece\\b|czech republic|czechia|\\bhungary\\b|\\bbulgaria\\b|\\bcroatia\\b|\\bslovakia\\b|\\bslovenia\\b|lithuania|\\blatvia\\b|\\bestonia\\b|\\bukraine\\b|\\bserbia\\b|\\biceland\\b|luxembourg|\\bmalta\\b|\\bcyprus\\b|\\bturkey\\b|\\baustralia\\b|new zealand|\\bchina\\b|\\bjapan\\b|south korea|\\bkorea\\b|\\bindia\\b|singapore|hong kong|\\btaiwan\\b|thailand|vietnam|indonesia|malaysia|philippines|pakistan|bangladesh|\\bnepal\\b|sri lanka|united arab emirates|\\buae\\b|saudi arabia|\\bksa\\b|\\bisrael\\b|\\bqatar\\b|\\bkuwait\\b|bahrain|\\boman\\b|\\bjordan\\b|lebanon|\\begypt\\b|south africa|nigeria|\\bkenya\\b|morocco|\\bghana\\b|\\bmexico\\b|\\bbrazil\\b|argentina|\\bchile\\b|colombia|\\bperu\\b|ecuador|venezuela|uruguay|costa rica|\\bpanama\\b|guatemala', 'i');
const HYBRID_ONSITE_ALLOWED = (LOCATION_CONFIG.hybridOnsiteAllowed
  || ['washington, dc', 'washington, d.c.', ', dc', 'richmond, va', 'richmond, virginia']
).map(s => s.toLowerCase());

function locationAllowed(loc) {
  const l = (loc || '').toLowerCase();
  if (!l) return { allowed: true, isRemote: false }; // not stated — keep, vet manually
  const isRemote = /\bremote\b|work from home|distributed|\banywhere\b/.test(l);
  if (isRemote) {
    if (REMOTE_EXCLUDE_RE.test(l) && !REMOTE_INCLUDE_RE.test(l)) return { allowed: false, isRemote: true };
    return { allowed: true, isRemote: true };
  }
  return { allowed: HYBRID_ONSITE_ALLOWED.some(needle => l.includes(needle)), isRemote: false };
}

// =================================================================
// 2. COMPANY LIST — companies.csv, in this profile's folder, is the ONE
//    place tracked companies live — not the config, not any other file.
//    A brand-new profile starts with an empty (header-only) CSV; populate
//    it with --add-company / --careers-url / hand-editing.
//    Columns: Name,ATS,Slug,URL,AddedAt,Via
//      ATS 'greenhouse'|'ashby'|'lever' use Slug; ATS 'custom' (a careers
//      page to scrape without AI — see fetchCustom below) or 'workday' (any
//      https://<tenant>.<dc>.myworkdayjobs.com/<site> board URL — see
//      fetchWorkday below) use URL instead.
// =================================================================
const COMPANIES_CSV_PATH = path.join(DATA_DIR, 'companies.csv');
const COMPANIES_CSV_HEADER = 'Name,ATS,Slug,URL,AddedAt,Via\n';

// 'custom' and 'workday' both key off URL instead of Slug.
function usesUrlColumn(ats) { return ats === 'custom' || ats === 'workday'; }

function companyKey(c) {
  return usesUrlColumn(c.ats) ? `${c.ats}:${c.url}` : `${c.ats}:${c.slug}`;
}

function companyCsvRow(c) {
  return [c.name, c.ats, c.slug || '', c.url || '', c.addedAt || '', c.via || '']
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

function ensureCompaniesCsv() {
  if (!fs.existsSync(COMPANIES_CSV_PATH)) fs.writeFileSync(COMPANIES_CSV_PATH, COMPANIES_CSV_HEADER);
}

function getAllCompanies() {
  ensureCompaniesCsv();
  const lines = fs.readFileSync(COMPANIES_CSV_PATH, 'utf8').split('\n');
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const c = {
      name: f[idx.Name], ats: (f[idx.ATS] || '').toLowerCase(),
      slug: f[idx.Slug] || '', url: f[idx.URL] || '',
      addedAt: f[idx.AddedAt] || '', via: f[idx.Via] || ''
    };
    if (!c.name || !c.ats) continue;
    if (usesUrlColumn(c.ats) ? !c.url : !c.slug) continue;
    if (seen.has(companyKey(c))) continue;
    seen.add(companyKey(c));
    out.push(c);
  }
  return out;
}

// Appends one company row to companies.csv (name kept from the old
// extras-file era — every call site funnels through here).
function saveExtraCompany(entry) {
  ensureCompaniesCsv();
  if (getAllCompanies().some(c => companyKey(c) === companyKey(entry))) return false; // already tracked
  fs.appendFileSync(COMPANIES_CSV_PATH,
    companyCsvRow({ ...entry, addedAt: new Date().toISOString(), via: entry.via || 'manual' }) + '\n');
  return true;
}

// =================================================================
// 2c. SLUG RESOLVER — turn a plain company name into its ATS board slug
//     by probing the same public endpoints the scanners use.
// =================================================================
function normName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugCandidates(name) {
  const cleaned = name.toLowerCase()
    .replace(/,?\s+(inc|llc|corp|co|labs|technologies|technology|software|hq)\.?$/i, '')
    .trim();
  const words = cleaned.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];
  const joined = words.join('');
  const hyphen = words.join('-');
  // Covers the naming patterns in the wild: 'personahq', 'tryfinch', 'merge-api'
  return [...new Set([joined, hyphen, `${joined}hq`, `try${joined}`, `${joined}-api`])];
}

async function probeGreenhouse(slug) {
  const rootRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
  if (!rootRes.ok) return null;
  const root = await rootRes.json();
  const jobsRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  if (!jobsRes.ok) return null;
  const jobs = await jobsRes.json();
  return { ats: 'greenhouse', slug, jobCount: (jobs.jobs || []).length, boardName: root.name || null };
}

async function probeAshby(slug) {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.jobs)) return null;
  return { ats: 'ashby', slug, jobCount: data.jobs.length, boardName: data.name || null };
}

async function probeLever(slug) {
  const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!Array.isArray(data)) return null;
  return { ats: 'lever', slug, jobCount: data.length, boardName: null };
}

const PROBES = { greenhouse: probeGreenhouse, ashby: probeAshby, lever: probeLever };
// Workday isn't in PROBES proper: resolveCompany()'s auto-guessing below only
// tries PROBES against slugCandidates() (company-name-derived slugs), which
// doesn't work for Workday — its site name is an arbitrary short code (Nike's
// is "nke", not "nike"/"nikeinc") that can't be derived from the company
// name. A Workday board can only be added once you have its real board URL
// (from --careers-url embedded-detection, or by hand) — see
// addCompanyByName()'s forced path and probeWorkday() in section 3a below.

// Returns hits sorted best-first: name-verified boards, then by job count.
// nameVerified: true (board name matches), false (board exists but the name
// DOESN'T match — almost certainly a different company), null (ATS doesn't
// expose a board name, so it can't be checked automatically).
async function resolveCompany(name) {
  const probes = [];
  for (const slug of slugCandidates(name)) {
    probes.push(probeGreenhouse(slug), probeAshby(slug), probeLever(slug));
  }
  const settled = await Promise.all(probes.map(p => p.catch(() => null)));
  const hits = [];
  const seen = new Set();
  for (const h of settled) {
    if (!h || h.jobCount === 0) continue;
    const key = `${h.ats}:${h.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (h.boardName) {
      const a = normName(name), b = normName(h.boardName);
      h.nameVerified = a.includes(b) || b.includes(a);
    } else {
      h.nameVerified = null;
    }
    hits.push(h);
  }
  hits.sort((a, b) =>
    (b.nameVerified === true) - (a.nameVerified === true) ||
    (b.nameVerified !== false) - (a.nameVerified !== false) ||
    b.jobCount - a.jobCount
  );
  return hits;
}

function boardUrl(hit) {
  if (hit.ats === 'greenhouse') return `https://job-boards.greenhouse.io/${hit.slug}`;
  if (hit.ats === 'ashby') return `https://jobs.ashbyhq.com/${hit.slug}`;
  if (hit.ats === 'workday') return hit.slug; // slug IS the full board URL for workday
  return `https://jobs.lever.co/${hit.slug}`;
}

// =================================================================
// 3. ATS FETCHERS — public, unauthenticated endpoints
// =================================================================
async function fetchGreenhouse(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Greenhouse ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    company: slug,
    ats: 'greenhouse',
    title: j.title,
    url: j.absolute_url,
    updatedAt: j.updated_at,
    location: j.location?.name || '',
    description: stripHtml(j.content || '')
  }));
}

async function fetchAshby(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ashby ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    company: slug,
    ats: 'ashby',
    title: j.title,
    url: j.jobUrl || j.applyUrl,
    updatedAt: j.publishedAt || j.updatedAt,
    location: j.location || '',
    description: stripHtml(j.descriptionHtml || j.description || '')
  }));
}

async function fetchLever(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Lever ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (data || []).map(j => ({
    company: slug,
    ats: 'lever',
    title: j.text,
    url: j.hostedUrl,
    updatedAt: new Date(j.createdAt).toISOString(),
    location: j.categories?.location || '',
    description: stripHtml(j.descriptionPlain || j.description || '')
  }));
}

// =================================================================
// SALARY EXTRACTION
// Pulls a $min-$max range out of the raw job description text.
// Handles common formats:
//   "$180,000 - $220,000"   "$180k-$220k"   "$180,000-$220,000 USD"
//   "180,000 to 220,000"    "USD 180,000-220,000"
// Returns { min, max } in dollars, or null if no range/figure was found.
// =================================================================
function extractSalaryRange(text) {
  if (!text) return null;

  // Normalize: strip commas inside numbers so regex is simpler, keep $ and k
  const cleaned = text.replace(/(\d),(\d{3})/g, '$1$2');

  const patterns = [
    // $180,000 - $220,000  /  $180000-$220000  /  with "to"
    /\$\s?(\d{2,3}(?:\.\d+)?)\s?(k|000)?\s?(?:-|–|—|to)\s?\$?\s?(\d{2,3}(?:\.\d+)?)\s?(k|000)?/i,
    // 180,000 - 220,000 USD  (no leading $)
    /(\d{2,3})(?:,?000)?\s?(k)?\s?(?:-|–|—|to)\s?(\d{2,3})(?:,?000)?\s?(k)?\s?(?:USD|usd)/,
    // £35,000 - £45,000  /  £35000-£45000  /  with "to" (GBP-targeted configs)
    /£\s?(\d{2,3}(?:\.\d+)?)\s?(k|000)?\s?(?:-|–|—|to)\s?£?\s?(\d{2,3}(?:\.\d+)?)\s?(k|000)?/i,
    // 35,000 - 45,000 GBP  (no leading £)
    /(\d{2,3})(?:,?000)?\s?(k)?\s?(?:-|–|—|to)\s?(\d{2,3})(?:,?000)?\s?(k)?\s?(?:GBP|gbp)/,
  ];

  for (const re of patterns) {
    const m = cleaned.match(re);
    if (m) {
      const toDollars = (numStr, unit) => {
        let n = parseFloat(numStr);
        if (unit && unit.toLowerCase() === 'k') n *= 1000;
        else if (n < 1000) n *= 1000; // bare "180" almost always means $180k in this context
        return Math.round(n);
      };
      const min = toDollars(m[1], m[2]);
      const max = toDollars(m[3], m[4]);
      if (min > 20000 && max >= min) return { min, max }; // sanity floor to avoid false positives
    }
  }
  return null;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const FETCHERS = { greenhouse: fetchGreenhouse, ashby: fetchAshby, lever: fetchLever };

// =================================================================
// 3a. CUSTOM CAREERS-PAGE SCRAPING (no AI) — for companies that aren't on
// Greenhouse/Ashby/Lever but have their own careers page (Retool, n8n...).
// Deterministic three-stage cascade:
//   1. EMBEDDED ATS DETECTION — most "own" careers pages actually embed a
//      known ATS; the HTML contains its board URL, and from there we use
//      that ATS's public JSON API (structured data, zero guessing).
//   2. JSON-LD — pages embedding schema.org/JobPosting blocks for Google
//      Jobs give us machine-readable title/url/location/date.
//   3. LINK-PATTERN HEURISTIC — collect anchors whose URLs look like job
//      links, group by shared URL path, take the largest group (listing
//      pages are repetitive, so the structure IS the signal).
// Jobs matching a track then get their detail page fetched (capped) so
// salary extraction and keyword matching still work.
// =================================================================
function absUrl(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

function detectEmbeddedAts(rawHtml) {
  // Board URLs are often buried in JSON blobs with escaped slashes
  // (jobs.ashbyhq.com/n8n or jobs.lever.co\/acme) — normalize first.
  const html = rawHtml.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
  let m;
  if ((m = html.match(/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\/?(?:js)?\?(?:for|token)=)?([A-Za-z0-9_-]+)/))) {
    if (!['embed', 'v1'].includes(m[1])) return { ats: 'greenhouse', slug: m[1] };
  }
  if ((m = html.match(/boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/))) return { ats: 'greenhouse', slug: m[1] };
  if ((m = html.match(/jobs\.lever\.co\/([A-Za-z0-9_-]+)/))) return { ats: 'lever', slug: m[1] };
  if ((m = html.match(/(?:jobs|api)\.ashbyhq\.com\/(?:posting-api\/job-board\/)?([A-Za-z0-9_%.-]+)/))) return { ats: 'ashby', slug: decodeURIComponent(m[1]) };
  if ((m = html.match(/apply\.workable\.com\/(?:api\/v\d\/widget\/accounts\/)?([a-z0-9-]+)/i))) return { ats: 'workable', slug: m[1] };
  if ((m = html.match(/([a-z0-9-]+)\.recruitee\.com/i))) return { ats: 'recruitee', slug: m[1] };
  if ((m = html.match(/(?:careers|jobs|api)\.smartrecruiters\.com\/(?:v1\/companies\/)?([A-Za-z0-9]+)/))) return { ats: 'smartrecruiters', slug: m[1] };
  if ((m = html.match(/ats\.rippling\.com\/([a-z0-9-]+)/i))) return { ats: 'rippling', slug: m[1] };
  // Some frameworks (Svelte/Next "public env") bake the board name into a
  // JSON config blob instead of a full board URL, e.g.
  // "PUBLIC_GREENHOUSE_BOARD":"block" — no greenhouse.io URL anywhere in the
  // page at all (seen on block.xyz, which renders its list client-side).
  if ((m = html.match(/"[A-Z0-9_]*GREENHOUSE_BOARD[A-Z0-9_]*"\s*:\s*"([A-Za-z0-9_-]+)"/))) return { ats: 'greenhouse', slug: m[1] };
  if ((m = html.match(/"[A-Z0-9_]*LEVER_(?:SITE|BOARD|SLUG)[A-Z0-9_]*"\s*:\s*"([A-Za-z0-9_-]+)"/))) return { ats: 'lever', slug: m[1] };
  if ((m = html.match(/"[A-Z0-9_]*ASHBY_(?:JOB_BOARD|BOARD|ORG|SLUG)[A-Z0-9_]*"\s*:\s*"([A-Za-z0-9_%.-]+)"/))) return { ats: 'ashby', slug: decodeURIComponent(m[1]) };
  // Workday: most enterprise/retail career sites are a thin marketing shell
  // over a myworkdayjobs.com tenant — even when the shell itself renders
  // client-side, it's common to find at least one absolute job/apply link to
  // that tenant baked into the initial HTML (SEO previews, "recently posted"
  // widgets, canonical tags). One such link is enough: it carries the
  // tenant + datacenter + site triple fetchWorkday() needs, so hand back
  // the canonical board URL (not a bare slug) as the "slug".
  if ((m = html.match(/https?:\/\/([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[a-z0-9_.%-]+)/i))) {
    const parsed = parseWorkdayUrl(`https://${m[1]}`);
    if (parsed) return { ats: 'workday', slug: `https://${parsed.tenant}.${parsed.dc}.myworkdayjobs.com/${parsed.site}` };
  }
  return null;
}

// Extracts {tenant, dc, site} from any myworkdayjobs.com URL — the browser
// URL and the wday/cxs API URL both encode the same triple, just with
// different path shapes (an optional locale segment like "en-US" before the
// site name, or "wday/cxs/<tenant>/<site>/..." for the API itself).
function parseWorkdayUrl(url) {
  try {
    const u = new URL(url);
    const m = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (!m) return null;
    const [, tenant, dc] = m;
    const parts = u.pathname.split('/').filter(Boolean);
    const cxsIdx = parts.indexOf('cxs');
    const site = cxsIdx >= 0 ? parts[cxsIdx + 2] : parts.find(p => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
    if (!site) return null;
    return { tenant: tenant.toLowerCase(), dc: dc.toLowerCase(), site };
  } catch { return null; }
}

// Workday's list endpoint only gives human text ("Posted Today", "Posted 3
// Days Ago", "Posted 30+ Days Ago") — approximate it into an ISO date so the
// usual maxAgeDays filter still works before a detail fetch (which DOES
// carry a real startDate) happens. Unknown formats are kept, not dropped —
// same "don't silently drop on missing data" policy as extractSalaryRange.
function parseWorkdayPostedOn(text) {
  const now = Date.now();
  if (!text) return new Date(now).toISOString();
  if (/today/i.test(text)) return new Date(now).toISOString();
  if (/yesterday/i.test(text)) return new Date(now - 86400000).toISOString();
  const m = text.match(/(\d+)\+?\s*Days?\s*Ago/i);
  if (m) return new Date(now - parseInt(m[1], 10) * 86400000).toISOString();
  return new Date(now).toISOString();
}

const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_MAX_JOBS = 400; // safety cap for very large boards
const WORKDAY_DETAIL_FETCH_CAP = 10; // same spirit as CUSTOM_DETAIL_FETCH_CAP below

async function fetchWorkdayList(tenant, dc, site) {
  const jobs = [];
  let offset = 0;
  // Termination is driven by page length, NOT the response's "total" field —
  // verified directly against a real tenant (Chanel's) that reports the
  // correct total on the FIRST page only and total:0 on every page after,
  // while jobPostings keeps coming back full. Trusting "total" there would
  // stop pagination after just one page. A short/empty page is the reliable
  // "no more results" signal for offset-based pagination regardless.
  while (offset < WORKDAY_MAX_JOBS) {
    const res = await fetch(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText: '' })
    });
    if (!res.ok) throw new Error(`Workday ${tenant}/${site}: HTTP ${res.status}`);
    const data = await res.json();
    const postings = data.jobPostings || [];
    for (const p of postings) {
      // A handful of postings (confidential reqs, seen in practice on large
      // multi-brand tenants like Richemont's) come back with only a
      // bulletFields req id — no title, no externalPath. Nothing to show or
      // link to, so skip rather than push a broken job downstream.
      if (!p.title || !p.externalPath) continue;
      jobs.push({
        title: p.title,
        url: `https://${tenant}.${dc}.myworkdayjobs.com/en-US/${site}${p.externalPath}`,
        updatedAt: parseWorkdayPostedOn(p.postedOn),
        location: p.locationsText || '',
        description: '',
        _externalPath: p.externalPath
      });
    }
    offset += WORKDAY_PAGE_SIZE;
    if (postings.length < WORKDAY_PAGE_SIZE) break; // short page — that was the last one
  }
  return jobs;
}

async function fetchWorkdayDetail(tenant, dc, site, externalPath) {
  const res = await fetch(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${externalPath}`);
  if (!res.ok) return null;
  const data = await res.json();
  const info = data.jobPostingInfo || {};
  return { description: stripHtml(info.jobDescription || ''), startDate: info.startDate || null };
}

// Direct Workday ATS fetcher (companies.csv: ATS=workday, URL=any
// https://<tenant>.<dc>.myworkdayjobs.com/<site> board URL). The list
// endpoint has no description text and only an approximate posted date, so —
// same pattern as fetchCustom's track-matched detail-fetch below — a capped
// number of track-matched jobs get their detail page fetched for the real
// description and startDate before scoring/salary extraction run.
async function fetchWorkday(url) {
  const parsed = parseWorkdayUrl(url);
  if (!parsed) throw new Error(`Not a myworkdayjobs.com board URL: ${url}`);
  const { tenant, dc, site } = parsed;
  const jobs = await fetchWorkdayList(tenant, dc, site);
  let enriched = 0;
  for (const j of jobs) {
    if (enriched >= WORKDAY_DETAIL_FETCH_CAP) break;
    if (!classifyTrack(j.title)) continue;
    enriched++;
    const detail = await fetchWorkdayDetail(tenant, dc, site, j._externalPath).catch(() => null);
    if (detail) {
      j.description = detail.description;
      if (detail.startDate) j.updatedAt = new Date(detail.startDate + 'T00:00:00Z').toISOString();
    }
  }
  for (const j of jobs) delete j._externalPath;
  return jobs;
}

// Verifies a Workday board is live (used by --add-company --ats=workday
// --slug=<board URL>, and by the discovery-time slug resolver). Mirrors
// probeGreenhouse/probeAshby/probeLever's {ats, slug, jobCount, boardName,
// nameVerified} shape, but Workday's list endpoint doesn't expose a company
// display name to check against, so nameVerified is always null (same as
// Ashby/Lever above) — eyeball the board before trusting an auto-add.
async function probeWorkday(url) {
  const parsed = parseWorkdayUrl(url);
  if (!parsed) return null;
  const { tenant, dc, site } = parsed;
  const res = await fetch(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' })
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || typeof data.total !== 'number') return null;
  return { ats: 'workday', slug: `https://${tenant}.${dc}.myworkdayjobs.com/${site}`, jobCount: data.total, boardName: null };
}

// Mini-fetchers for ATSs we only reach via embedded detection.
async function fetchWorkable(slug) {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Workable ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    title: j.title,
    url: j.url || `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
    updatedAt: j.published_on || j.created_at || new Date().toISOString(),
    location: [j.city, j.state_region ?? j.region, j.country].filter(Boolean).join(', ') + (j.telecommuting || j.remote ? ' (Remote)' : ''),
    description: stripHtml(j.description || '')
  }));
}

async function fetchRecruitee(slug) {
  const url = `https://${slug}.recruitee.com/api/offers/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Recruitee ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.offers || []).map(j => ({
    title: j.title,
    url: j.careers_url || `https://${slug}.recruitee.com/o/${j.slug}`,
    updatedAt: j.created_at || new Date().toISOString(),
    location: `${j.location || ''}${j.remote ? ' (Remote)' : ''}`,
    description: stripHtml(j.description || '')
  }));
}

async function fetchSmartRecruiters(company) {
  const url = `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SmartRecruiters ${company}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.content || []).map(j => ({
    title: j.name,
    url: `https://jobs.smartrecruiters.com/${company}/${j.id}`,
    updatedAt: j.releasedDate || new Date().toISOString(),
    location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', ') + (j.location?.remote ? ' (Remote)' : ''),
    description: '' // filled from the detail page for track-matched jobs
  }));
}

async function fetchRippling(slug) {
  const url = `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Rippling ${slug}: HTTP ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : data.jobs || []).map(j => ({
    title: j.name || j.title,
    url: j.url,
    updatedAt: new Date().toISOString(), // Rippling doesn't expose a date
    location: (j.workLocation?.label) || (j.locations || []).map(l => l.label || l.name).join('; ') || '',
    description: ''
  }));
}

const EMBEDDED_ATS_FETCHERS = {
  greenhouse: fetchGreenhouse, ashby: fetchAshby, lever: fetchLever,
  workable: fetchWorkable, recruitee: fetchRecruitee,
  smartrecruiters: fetchSmartRecruiters, rippling: fetchRippling,
  workday: fetchWorkday // detectEmbeddedAts hands back the full board URL as "slug" for this one
};

function extractJsonLdJobs(html, baseUrl) {
  const jobs = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      nodes.push(n);
      walk(n['@graph']); walk(n.itemListElement); walk(n.item);
    };
    walk(data);
    for (const n of nodes) {
      if (![].concat(n['@type'] || []).includes('JobPosting')) continue;
      const loc = [].concat(n.jobLocation || []).map(l => [l.address?.addressLocality, l.address?.addressRegion, l.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean).join('; ');
      const remote = n.jobLocationType === 'TELECOMMUTE' ? (loc ? loc + ' (Remote)' : 'Remote') : loc;
      jobs.push({
        title: n.title || n.name || '',
        url: absUrl(n.url || baseUrl, baseUrl),
        updatedAt: n.datePosted || new Date().toISOString(),
        location: remote,
        description: stripHtml(String(n.description || ''))
      });
    }
  }
  return jobs.filter(j => j.title);
}

// Explicit chrome/nav phrases that share a URL path prefix with real job
// links often enough to win the "biggest group" grouping below (category
// filters, locale switchers, section headers) — seen in practice grouping
// alongside genuine listings on several real career sites during testing
// (e.g. "Life at M&S" / "Our Teams" / "Early Careers" all under
// marksandspencer.com/careers/...). Matched against the FULL anchor text.
const NAV_CHROME_TEXT_RE = new RegExp('^(' + [
  'skip to [a-z ]+', 'back to top', 'return to filters?', 'back to search results?',
  'search(?: \\d+)? (?:jobs?|roles?|positions?|openings?|results?)', '\\d+\\+?\\s*(?:jobs?|roles?|positions?|openings?|results?)',
  'view all(?: jobs?| roles?)?', 'see all', 'apply(?: now| here)?', 'register',
  'sign ?in', 'log ?in', 'learn more', 'read more', 'find out more', 'explore(?: careers?)?',
  'get started', 'our teams?', 'life at [a-z&.\\s]+', 'early careers?', 'working here',
  'about us', 'our culture', 'our values', 'our story', 'why join us', 'meet (?:the|our) team',
  'benefits', 'diversity(?: ?(?:and|&) ?inclusion)?', 'sustainability', 'link to [a-z\\s]+ page',
  'home', 'menu', 'contact us', 'faqs?', '[a-z]+ \\([a-z\\s]+\\)' // locale switcher e.g. "Deutsch (Deutschland)"
].join('|') + ')$', 'i');

// Prefix-style chrome, tested separately since these lead into free text that
// a full-string denylist can't anticipate (an employee's name and role, an
// arbitrary date) — "Meet our People: Katy Wright, Digital Coordinator" is an
// employee spotlight page, not a job posting, even though it reads like one.
const NAV_CHROME_PREFIX_RE = /^(meet (?:our|the) (?:people|team)\b|[a-z\s]+ jobs? [a-z]+ \d{1,2},? \d{4}$)/i;

// Positive signal that a candidate actually reads like a job posting rather
// than nav chrome that slipped past the denylist above (a category name, a
// department link, etc.) — real postings overwhelmingly carry at least one
// of: a digit (req id, hours, a date), a seniority/function word, an
// employment-type word, or a trailing "City, Country"/"Remote" location.
const JOB_TITLE_SIGNAL_RE = /\d|\b(senior|junior|lead|head|manager|director|assistant|associate|specialist|engineer|coordinator|executive|analyst|officer|consultant|supervisor|representative|technician|designer|developer|administrator|architect|strategist|planner|scientist|apprentice|intern|full[\s-]?time|part[\s-]?time|contract|permanent|temporary|remote|hybrid|freelance)\b/i;

function extractJobLinks(html, baseUrl) {
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const cands = [];
  for (const [, href, inner] of anchors) {
    const text = stripHtml(inner).trim();
    if (text.length < 5 || text.length > 90) continue;
    if (NAV_CHROME_TEXT_RE.test(text) || NAV_CHROME_PREFIX_RE.test(text) || !JOB_TITLE_SIGNAL_RE.test(text)) continue;
    const url = absUrl(href, baseUrl);
    if (!url || !/^https?:/.test(url)) continue;
    if (!/(job|career|position|opening|opportunit|vacanc|role|gh_jid|lever|ashby|workable|recruitee)/i.test(url)) continue;
    if (/(privacy|login|signup|about|blog|press|contact|benefit|culture|faq|mailto|#$)/i.test(url)) continue;
    cands.push({ url, text });
  }
  // Group by shared URL path prefix; the biggest group is the job list.
  const groups = new Map();
  for (const c of cands) {
    const u = new URL(c.url);
    const key = u.hostname + u.pathname.replace(/[^/]*$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  let best = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  // Below this, it's not a confident "found a job list" signal — a couple of
  // survivors that happen to share a URL prefix is exactly what a handful of
  // stray nav links looks like too. Report no jobs rather than 1-2 guesses.
  if (best.length < 3) return [];
  const seen = new Set();
  return best
    .filter(c => c.url !== baseUrl && !seen.has(c.url) && seen.add(c.url))
    .map(c => {
      // Scraped link text often has the location glued onto the title
      // ("Solutions Architect San Francisco, United States") — split a
      // trailing "City, Country/State" or "Remote" suffix into location
      // so the remote/DC-Richmond filter still applies.
      let title = c.text, location = '';
      const locMatch = c.text.match(/^(.*)\s+((?:[A-Z][a-zA-Z.]+\s){0,2}[A-Z][a-zA-Z.]+,\s*(?:United States|United Kingdom|USA|UK|Canada|Germany|France|Ireland|Spain|Portugal|Netherlands|Australia|Japan|Singapore|India|Brazil|Mexico|[A-Z]{2})|Remote(?:\s*\([^)]*\))?)$/);
      if (locMatch && locMatch[1].length >= 5) { title = locMatch[1].replace(/[,\s–-]+$/, ''); location = locMatch[2]; }
      return { title, url: c.url, updatedAt: new Date().toISOString(), location, description: '' };
    });
}

const CUSTOM_DETAIL_FETCH_CAP = 10; // detail pages fetched per company per scan

// Arbitrary third-party marketing pages (unlike the known ATS APIs above)
// can be slow or simply never respond — seen hanging a scan indefinitely
// against a real company's careers page during testing. Everything in this
// function that fetches one uses this timeout so one bad page can't eat the
// whole run's CI budget.
const CUSTOM_FETCH_TIMEOUT_MS = 15000;

async function fetchCustom(co) {
  const res = await fetch(co.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-watch)' },
    signal: AbortSignal.timeout(CUSTOM_FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`careers page ${co.url}: HTTP ${res.status}`);
  const html = await res.text();

  let method = null, jobs = [];
  const emb = detectEmbeddedAts(html);
  if (emb && EMBEDDED_ATS_FETCHERS[emb.ats]) {
    try {
      jobs = await EMBEDDED_ATS_FETCHERS[emb.ats](emb.slug);
      if (jobs.length) method = `embedded ${emb.ats}/${emb.slug}`;
    } catch { /* fall through to the next stage */ }
  }
  if (!method) {
    jobs = extractJsonLdJobs(html, co.url);
    if (jobs.length) method = 'json-ld';
  }
  if (!method) {
    jobs = extractJobLinks(html, co.url);
    method = jobs.length ? 'link-heuristic' : 'none';
  }

  // Track-matched jobs without a description get their detail page fetched
  // so salary extraction and keyword scoring still work.
  let enriched = 0;
  for (const j of jobs) {
    if (j.description || enriched >= CUSTOM_DETAIL_FETCH_CAP) continue;
    if (!classifyTrack(j.title)) continue;
    try {
      const r = await fetch(j.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-watch)' },
        signal: AbortSignal.timeout(CUSTOM_FETCH_TIMEOUT_MS)
      });
      if (r.ok) { j.description = stripHtml(await r.text()); enriched++; }
    } catch { /* leave description empty */ }
  }

  return { method, jobs };
}

// =================================================================
// 3b. OPEN DISCOVERY — free aggregator APIs that index across companies
//     you haven't listed. Broader net, lower precision; everything found
//     here still flows through the same track/salary/match pipeline.
//     Remotive: keyword search over remote jobs.
//     The Muse: category browse across thousands of company boards.
// =================================================================
// Set per-config as "discoveryQueries"/"museCategories"; default here is this
// project's original TPM/ops-focused search.
const DISCOVERY_QUERIES = CONFIG.discoveryQueries || [
  'technical program manager', 'solutions engineer', 'sales engineer',
  'customer success manager', 'implementation engineer', 'support manager',
  'workflow automation', 'internal tools'
];

const MUSE_CATEGORIES = CONFIG.museCategories || [
  'Project Management', 'Account Management', 'Customer Service',
  'Business Operations', 'Sales'
];
const MUSE_PAGES_PER_CATEGORY = 2;

async function fetchRemotive(query) {
  const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Remotive "${query}": HTTP ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    source: 'remotive',
    companyName: j.company_name,
    title: j.title,
    url: j.url,
    updatedAt: j.publication_date,
    location: j.candidate_required_location || '',
    // Remotive sometimes puts the range in its own `salary` field rather than
    // the description, so feed both to the extractor.
    description: `${stripHtml(j.description || '')} ${j.salary || ''}`.trim()
  }));
}

async function fetchMuse(category, page) {
  const url = `https://www.themuse.com/api/public/jobs?category=${encodeURIComponent(category)}&page=${page}&descending=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Muse "${category}" p${page}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(j => ({
    source: 'themuse',
    companyName: j.company?.name,
    title: j.name,
    url: j.refs?.landing_page,
    updatedAt: j.publication_date,
    location: (j.locations || []).map(l => l.name).join('; '),
    description: stripHtml(j.contents || '')
  }));
}

async function discoverJobs(errors) {
  const tasks = [
    ...DISCOVERY_QUERIES.map(q => fetchRemotive(q).catch(err => { errors.push(`discovery ${err.message}`); return []; })),
  ];
  for (const cat of MUSE_CATEGORIES) {
    for (let page = 1; page <= MUSE_PAGES_PER_CATEGORY; page++) {
      tasks.push(fetchMuse(cat, page).catch(err => { errors.push(`discovery ${err.message}`); return []; }));
    }
  }
  const batches = await Promise.all(tasks);
  const byUrl = new Map();
  for (const job of batches.flat()) {
    if (job.url && job.companyName && !byUrl.has(job.url)) byUrl.set(job.url, job);
  }
  return [...byUrl.values()];
}

// Minimal parser for our own CSV format (quoted fields, "" escapes) —
// used by companies.csv.
function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { fields.push(cur); cur = ''; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

// =================================================================
// DEDUP CURSOR — last_scan.json holds a single timestamp: the start of the
// last run that actually sent Telegram alerts. A job counts as "new" if its
// ATS-reported posted/updated timestamp is after that cursor (or the cursor
// doesn't exist yet, e.g. the very first run for this profile) — no per-job
// ledger, nothing to prune. The cursor only advances on a real (non
// --no-telegram) run, so a misconfigured/disabled Telegram doesn't cause
// jobs to be silently skipped once it's fixed.
//
// Trade-off worth knowing: a job posted before the cursor that this profile
// is only NOW able to see for the first time (e.g. a company just added via
// --add-company, or a one-off send failure) won't be flagged as new, since
// dedup is purely date-based rather than "have we ever alerted this exact
// posting." That's the intentional simplification here — no per-job history
// is kept at all.
// =================================================================
const LAST_SCAN_PATH = path.join(DATA_DIR, 'last_scan.json');

function loadLastScanAt() {
  try { return JSON.parse(fs.readFileSync(LAST_SCAN_PATH, 'utf8')).lastScanAt || null; }
  catch { return null; } // first run for this profile
}

function saveLastScanAt(iso) {
  fs.writeFileSync(LAST_SCAN_PATH, JSON.stringify({ lastScanAt: iso }));
}

// A job is "new" if its own posted/updated timestamp is unparseable (kept,
// same conservative call the old ledger pruning made) or falls after cutoff.
function isNewSinceCursor(postedOrUpdated, cutoffIso) {
  if (!cutoffIso) return true; // no prior scan for this profile — everything counts as new
  const t = new Date(postedOrUpdated).getTime();
  if (!Number.isFinite(t)) return true;
  return t > new Date(cutoffIso).getTime();
}

// =================================================================
// TELEGRAM
// =================================================================
async function sendTelegramMessage(text) {
  const token = process.env[CONFIG.telegram.botTokenEnv];
  const chatId = process.env[CONFIG.telegram.chatIdEnv];
  if (!token || !chatId) {
    console.error(`[Telegram] ${CONFIG.telegram.botTokenEnv} / ${CONFIG.telegram.chatIdEnv} not set — skipping alert. See header comment for setup.`);
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] send failed: HTTP ${res.status} ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Telegram] send error: ${err.message}`);
    return false;
  }
}

function formatTelegramMessage(job, run) {
  const hoursAgo = Math.round((Date.now() - new Date(job.postedOrUpdated)) / 3600000);
  const sourceTag = job.source ? ` (via ${job.source} discovery)` : '';
  const locTag = job.isRemote ? '🏠 Remote' : '🏢 Hybrid';
  const runLine = run ? `\n<i>${escapeHtml(run.timestampLocal)}</i>` : '';
  if (!SCORING_ENABLED) {
    return (
      `<b>${escapeHtml(job.companyDisplay)}</b> — ${escapeHtml(job.title)} [${locTag}]${sourceTag}\n` +
      `Track: ${escapeHtml(job.track)}\n` +
      `Salary: ${escapeHtml(job.salary)} | Posted ${hoursAgo}h ago\n` +
      `${job.url}${runLine}`
    );
  }
  const swaps = job.suggestedSwaps.length
    ? `\nSwap: ${job.suggestedSwaps.map(s => `"${s.youHaveAs}"→"${s.jdUsesPhrase}"`).join(', ')}`
    : '';
  const matched = (job.matchedTerms || []).length
    ? `\nMatched: ${job.matchedTerms.map(escapeHtml).join(', ')}`
    : '';
  const bonus = (job.bonusTerms || []).length
    ? `\n+ Bonus tools: ${job.bonusTerms.map(escapeHtml).join(', ')}`
    : '';
  return (
    `<b>${escapeHtml(job.companyDisplay)}</b> — ${escapeHtml(job.title)} [${locTag}]${sourceTag}\n` +
    `Track: ${escapeHtml(job.track)}\n` +
    `Match: ${job.matchPct}% | Salary: ${escapeHtml(job.salary)} | Posted ${hoursAgo}h ago\n` +
    `${job.url}${matched}${bonus}${swaps}${runLine}`
  );
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =================================================================
// 4. MATCHING LOGIC
// =================================================================
function classifyTrack(title) {
  const t = title.toLowerCase();
  let best = null, bestHits = 0;
  for (const [key, track] of Object.entries(TRACKS)) {
    const hits = track.titleKeywords.filter(k => t.includes(k)).length;
    if (hits > bestHits) { bestHits = hits; best = key; }
  }
  return bestHits > 0 ? best : null;
}

// Each track's skillTerms is { core: [...], bonus: [...] }. matchPct is
// scored against core only — terms a third-party JD in this field would
// plausibly use (generic skills, near-universal platforms) — so the
// percentage stays meaningful. bonus holds specific tools/vendors (n8n,
// Chargebee, La Growth Machine...) that only a company using that exact
// tool would mention; those matches are reported separately, not folded
// into the denominator, since one candidate's whole toolset is never going
// to appear verbatim in someone else's job posting.
function scoreJob(job, trackKey) {
  const track = TRACKS[trackKey];
  const descLower = job.description.toLowerCase();
  // A "scoring": false config (see SCORING_ENABLED above) has no reason to
  // define skillTerms on its tracks — tolerate it missing entirely rather
  // than requiring every config to carry a dead field.
  const coreTerms = (track.skillTerms && track.skillTerms.core) || [];
  const bonusTerms = (track.skillTerms && track.skillTerms.bonus) || [];
  const allTerms = [...coreTerms, ...bonusTerms];

  const haveTerms = coreTerms.filter(term => descLower.includes(term.toLowerCase()));
  const haveBonusTerms = bonusTerms.filter(term => descLower.includes(term.toLowerCase()));

  // Find JD terms you don't literally have but DO have via synonym —
  // these are your safe, non-obvious keyword swaps.
  const suggestedSwaps = [];
  for (const [jdTerm, resumeTerm] of SYNONYMS) {
    if (descLower.includes(jdTerm) && allTerms.includes(resumeTerm)) {
      suggestedSwaps.push({ jdUsesPhrase: jdTerm, youHaveAs: resumeTerm });
    }
  }

  // crude "required skills" extraction: lines/sentences containing
  // requirement signal words, scanned for terms you're missing entirely
  const requirementSignals = ['required', 'must have', 'requirements', 'qualifications', 'you have', 'you bring'];
  const hasRequirementsSection = requirementSignals.some(s => descLower.includes(s));

  const matchPct = coreTerms.length
    ? Math.round((haveTerms.length / coreTerms.length) * 100)
    : 0;

  return {
    matchPct,
    haveTerms,
    haveBonusTerms,
    suggestedSwaps,
    hasRequirementsSection
  };
}

// =================================================================
// 5. MAIN SCAN
// =================================================================
async function scanAll(opts = {}) {
  const minSalary = opts.minSalary ?? MIN_SALARY;
  const strict = opts.strict ?? false; // if true, drop postings with no salary listed at all
  const discover = opts.discover ?? false;
  const maxAgeDays = opts.maxAgeDays ?? MAX_AGE_DAYS;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  const companies = getAllCompanies();
  const results = [];
  const errors = [];
  const feedStats = []; // per-feed funnel: returned -> track match -> filters -> kept
  let droppedForSalary = 0;
  let unlistedSalaryCount = 0;
  let droppedForAge = 0;
  let droppedForLocation = 0;
  let droppedForExcludedTitle = 0;

  const newFeedStat = (feed) => {
    const s = { feed, returned: 0, trackMatched: 0, excludedTitle: 0, tooOld: 0, badLocation: 0, belowSalary: 0, kept: 0 };
    feedStats.push(s);
    return s;
  };

  // One pipeline for both passes: classify -> exclusions -> age -> location
  // -> salary floor -> score -> collect. `stat` is this feed's funnel counters.
  const consider = (job, companyDisplay, source, stat) => {
    const trackKey = classifyTrack(job.title);
    if (!trackKey) return; // not a role we care about
    stat.trackMatched++;

    const titleLower = job.title.toLowerCase();
    if (EXCLUDED_TITLE_TERMS.some(term => titleLower.includes(term))) {
      droppedForExcludedTitle++;
      stat.excludedTitle++;
      return;
    }

    // Freshness: the ATS's own timestamp must be within the window.
    // (Invalid/missing dates are kept rather than silently dropped.)
    const age = Date.now() - new Date(job.updatedAt).getTime();
    if (age > maxAgeMs) {
      droppedForAge++;
      stat.tooOld++;
      return;
    }

    const { allowed, isRemote } = locationAllowed(job.location);
    if (!allowed) {
      droppedForLocation++;
      stat.badLocation++;
      return;
    }

    // Titles sometimes carry the region even when the location field doesn't
    // ("Enterprise AE, LATAM", "Solutions Engineer - EMEA", a role scoped to
    // "APAC"): apply the same excluded-region check to the title as to
    // location, using this config's remoteExcludePattern/remoteIncludePattern.
    if (REMOTE_EXCLUDE_RE.test(titleLower) && !REMOTE_INCLUDE_RE.test(titleLower)) {
      droppedForLocation++;
      stat.badLocation++;
      return;
    }

    const salary = extractSalaryRange(job.description);

    if (salary && salary.max < minSalary) {
      droppedForSalary++;
      stat.belowSalary++;
      return; // range's own ceiling is below your floor -> definitely skip
    }
    if (!salary) {
      unlistedSalaryCount++;
      if (strict) { stat.belowSalary++; return; } // --strict: only confirmed ranges
    }
    stat.kept++;

    const { matchPct, haveTerms, haveBonusTerms, suggestedSwaps } = scoreJob(job, trackKey);
    results.push({
      companyDisplay,
      source, // undefined for direct-ATS, 'remotive' / 'themuse' for discovery
      isRemote,
      track: TRACKS[trackKey].label,
      trackKey,
      resumeFile: TRACKS[trackKey].resumeFile,
      title: job.title,
      location: job.location,
      url: job.url,
      postedOrUpdated: job.updatedAt,
      matchPct,
      matchedTerms: haveTerms,
      bonusTerms: haveBonusTerms,
      suggestedSwaps,
      salary: salary ? `${CURRENCY_SYMBOL}${salary.min.toLocaleString()}-${CURRENCY_SYMBOL}${salary.max.toLocaleString()}` : 'not listed'
    });
  };

  const directPass = Promise.all(companies.map(async (co) => {
    const label = usesUrlColumn(co.ats) ? `${co.name} (${co.ats}: ${co.url})` : `${co.name} (${co.ats}/${co.slug})`;
    const stat = newFeedStat(label);
    try {
      let jobs;
      if (co.ats === 'custom') {
        const scraped = await fetchCustom(co);
        stat.method = scraped.method;
        jobs = scraped.jobs;
      } else if (co.ats === 'workday') {
        jobs = await fetchWorkday(co.url);
      } else {
        const fetcher = FETCHERS[co.ats];
        if (!fetcher) throw new Error(`Unknown ATS: ${co.ats}`);
        jobs = await fetcher(co.slug);
      }
      stat.returned = jobs.length;
      for (const job of jobs) consider(job, co.name, undefined, stat);
    } catch (err) {
      stat.error = err.message;
      errors.push(`${label}: ${err.message}`);
    }
  }));

  // Open-discovery pass: aggregator hits at companies NOT already tracked
  // directly (tracked ones are covered by the pass above with canonical URLs).
  const discoveryPass = discover
    ? discoverJobs(errors).then(rawJobs => {
        const stat = newFeedStat('discovery (remotive + themuse, deduped)');
        stat.returned = rawJobs.length;
        stat.skippedAlreadyTracked = 0;
        const trackedNames = new Set(companies.map(c => normName(c.name)));
        for (const job of rawJobs) {
          if (trackedNames.has(normName(job.companyName))) { stat.skippedAlreadyTracked++; continue; }
          consider(job, job.companyName, job.source, stat);
        }
      })
    : Promise.resolve();

  await Promise.all([directPass, discoveryPass]);

  // best match % first; remote breaks ties, then recency
  results.sort((a, b) => {
    if (a.matchPct !== b.matchPct) return b.matchPct - a.matchPct;
    if (a.isRemote !== b.isRemote) return a.isRemote ? -1 : 1;
    return new Date(b.postedOrUpdated) - new Date(a.postedOrUpdated);
  });

  return {
    results, errors, feedStats, droppedForSalary, unlistedSalaryCount,
    droppedForAge, droppedForLocation, droppedForExcludedTitle,
    minSalary, strict, maxAgeDays
  };
}

function printFeedStats(feedStats) {
  console.log('\nPer-feed API results (returned -> matched a track -> kept after filters):');
  for (const s of feedStats) {
    if (s.error) {
      console.log(`  ${s.feed}: ERROR — ${s.error}`);
      continue;
    }
    const drops = [];
    if (s.excludedTitle) drops.push(`${s.excludedTitle} excluded-title`);
    if (s.tooOld) drops.push(`${s.tooOld} too old`);
    if (s.badLocation) drops.push(`${s.badLocation} location`);
    if (s.belowSalary) drops.push(`${s.belowSalary} salary`);
    if (s.skippedAlreadyTracked) drops.push(`${s.skippedAlreadyTracked} already tracked directly`);
    console.log(`  ${s.feed}: ${s.returned} returned, ${s.trackMatched} matched, ${s.kept} kept` +
      (s.method ? ` [via ${s.method}]` : '') +
      (drops.length ? ` (dropped: ${drops.join(', ')})` : ''));
  }
  const t = feedStats.reduce((a, s) => ({
    returned: a.returned + (s.returned || 0),
    matched: a.matched + (s.trackMatched || 0),
    kept: a.kept + (s.kept || 0)
  }), { returned: 0, matched: 0, kept: 0 });
  console.log(`  TOTAL: ${t.returned} returned, ${t.matched} matched, ${t.kept} kept`);
}

function printTable(results, meta) {
  console.log(`\nFound ${results.length} matching roles (min salary floor: ${CURRENCY_SYMBOL}${meta.minSalary.toLocaleString()}, max age: ${meta.maxAgeDays}d, remote-in-region or approved hybrid/onsite cities only — see this config's "location"):\n`);
  if (meta.droppedForSalary) {
    console.log(`(Filtered out ${meta.droppedForSalary} posting(s) below the floor.)`);
  }
  if (meta.droppedForAge) {
    console.log(`(Filtered out ${meta.droppedForAge} posting(s) older than ${meta.maxAgeDays} days.)`);
  }
  if (meta.droppedForLocation) {
    console.log(`(Filtered out ${meta.droppedForLocation} posting(s) outside this config's allowed remote region / hybrid-onsite cities.)`);
  }
  if (meta.droppedForExcludedTitle) {
    console.log(`(Filtered out ${meta.droppedForExcludedTitle} posting(s) with excluded title terms, e.g. marketing.)`);
  }
  if (meta.unlistedSalaryCount && !meta.strict) {
    console.log(`(${meta.unlistedSalaryCount} posting(s) below have no salary listed — shown anyway, worth vetting before applying. Use --strict to hide these.)\n`);
  }
  for (const r of results) {
    const hoursAgo = Math.round((Date.now() - new Date(r.postedOrUpdated)) / 3600000);
    console.log(`── ${r.companyDisplay} — ${r.title} [${r.isRemote ? 'REMOTE' : 'hybrid/onsite'}]${r.source ? ` [discovered via ${r.source}]` : ''}`);
    console.log(`   Track: ${r.track} (use ${r.resumeFile})`);
    console.log(`   Location: ${r.location || 'n/a'} | Salary: ${r.salary} | Posted/updated: ${hoursAgo}h ago${SCORING_ENABLED ? ` | Match: ${r.matchPct}%` : ''}`);
    console.log(`   Apply direct: ${r.url}`);
    if (SCORING_ENABLED) {
      if (r.matchedTerms && r.matchedTerms.length) {
        console.log(`   Matched: ${r.matchedTerms.join(', ')}`);
      }
      if (r.bonusTerms && r.bonusTerms.length) {
        console.log(`   + Bonus tools: ${r.bonusTerms.join(', ')}`);
      }
      if (r.suggestedSwaps.length) {
        console.log(`   Keyword swaps to make: ${r.suggestedSwaps.map(s => `"${s.youHaveAs}" -> "${s.jdUsesPhrase}"`).join(', ')}`);
      }
    }
    console.log('');
  }
}

// =================================================================
// 6. COMPANY ADDING — manual (--add-company) and discovery auto-add
// =================================================================

// Cache of company-name -> resolution outcome so discovery auto-add doesn't
// re-probe the same (often unresolvable) names on every scan.
const RESOLVE_CACHE_PATH = path.join(DATA_DIR, 'slug_cache.json');

function loadResolveCache() {
  try { return JSON.parse(fs.readFileSync(RESOLVE_CACHE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveResolveCache(cache) {
  fs.writeFileSync(RESOLVE_CACHE_PATH, JSON.stringify(cache, null, 2));
}

function describeHit(h) {
  const verified = h.nameVerified === true ? 'name verified'
    : h.nameVerified === false ? `NAME MISMATCH: board says "${h.boardName}"`
    : 'name not exposed by this ATS — eyeball the board';
  return `${h.ats}/${h.slug} — ${h.jobCount} open job(s), ${verified} -> ${boardUrl(h)}`;
}

// Interactive path for --add-company="Name". Adds the best hit unless it
// looks like a different company, in which case it shows what it found and
// how to force the right one.
async function addCompanyByName(name, forced) {
  if (forced) {
    // Workday isn't in PROBES (see the comment above it) — --slug= carries
    // the full myworkdayjobs.com board URL instead of a short slug for this
    // one ATS, and the hit gets saved into the URL column, not Slug.
    const probe = forced.ats === 'workday' ? probeWorkday : PROBES[forced.ats];
    if (!probe) { console.error(`Unknown ATS "${forced.ats}" — use greenhouse | ashby | lever | workday.`); return; }
    const hit = await probe(forced.slug).catch(() => null);
    if (!hit) { console.error(`No live ${forced.ats} board at slug "${forced.slug}".`); return; }
    const entry = hit.ats === 'workday'
      ? { name, ats: 'workday', url: hit.slug, via: 'manual' }
      : { name, ats: hit.ats, slug: hit.slug, via: 'manual' };
    const added = saveExtraCompany(entry);
    console.log(added ? `Added ${name}: ${describeHit(hit)}` : `${name} (${hit.ats}/${hit.slug}) is already tracked.`);
    return;
  }

  console.log(`Resolving "${name}" (trying ${slugCandidates(name).join(', ')} on all three ATSs)...`);
  const hits = await resolveCompany(name);
  if (!hits.length) {
    console.log(`  No live board found. If you know the board, force it:\n` +
      `  node job_watch.js --add-company="${name}" --ats=<greenhouse|ashby|lever> --slug=<slug>\n` +
      `  node job_watch.js --add-company="${name}" --ats=workday --slug=<https://tenant.dcN.myworkdayjobs.com/site>\n` +
      `  Or, if they have their own careers page, scrape it directly (no AI — this also auto-detects an\n` +
      `  embedded Workday, Greenhouse, Ashby, Lever, Workable, Recruitee, SmartRecruiters or Rippling board):\n` +
      `  node job_watch.js --add-company="${name}" --careers-url="https://..."`);
    return;
  }
  const best = hits[0];
  if (best.nameVerified === false) {
    console.log(`  Found board(s), but the name doesn't match — NOT adding automatically:`);
    hits.forEach(h => console.log(`    ${describeHit(h)}`));
    console.log(`  If one of these is right, force it with --ats= and --slug=.`);
    return;
  }
  const added = saveExtraCompany({ name, ats: best.ats, slug: best.slug, via: 'manual' });
  console.log(added ? `  Added: ${describeHit(best)}` : `  Already tracked: ${best.ats}/${best.slug}`);
  for (const alt of hits.slice(1)) console.log(`  (also found: ${describeHit(alt)})`);
}

// Shared by CLI --careers-url and Telegram /addpage: test-scrape the page,
// report what was found and how, save only if jobs were actually detected.
async function addCustomCompany(name, pageUrl) {
  let parsed;
  try { parsed = new URL(pageUrl); } catch { return { ok: false, message: `"${pageUrl}" is not a valid URL.` }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, message: `"${pageUrl}" must be an http(s) URL.` };

  let scraped;
  try { scraped = await fetchCustom({ name, url: pageUrl }); }
  catch (err) { return { ok: false, message: `Could not fetch ${pageUrl}: ${err.message}` }; }

  const { method, jobs } = scraped;
  if (!jobs.length) {
    return {
      ok: false,
      message: `Fetched ${pageUrl} but found no jobs (no embedded ATS, no JSON-LD JobPosting data, no job-like link pattern). ` +
        `The page may load its listings with client-side JavaScript, which this scraper can't see. Not added.`
    };
  }
  const sample = jobs.slice(0, 3).map(j => j.title).join(' | ');
  const added = saveExtraCompany({ name, ats: 'custom', slug: '', url: pageUrl, via: 'careers-page' });
  return {
    ok: true,
    message: added
      ? `Added ${name} as a custom careers page: ${jobs.length} job(s) detected via ${method} (e.g. ${sample}). Scraped on every scan from now on.`
      : `${name} (${pageUrl}) is already tracked.`
  };
}

// After a --discover scan: promising discovered companies get their ATS slug
// resolved and saved, so future scans track them directly. Conservative on
// purpose — only adds boards whose name checks out (or Greenhouse-verified).
const AUTOADD_MAX_PER_RUN = 8;

async function autoAddDiscoveredCompanies(newJobs, minMatch) {
  const names = [...new Set(
    newJobs.filter(j => j.source && (!SCORING_ENABLED || j.matchPct >= minMatch)).map(j => j.companyDisplay)
  )];
  if (!names.length) return;

  const cache = loadResolveCache();
  let probed = 0;
  const added = [];
  for (const name of names) {
    const key = normName(name);
    if (key in cache) continue; // already resolved (or failed) on a past run
    if (probed >= AUTOADD_MAX_PER_RUN) break; // stay polite to the ATS APIs
    probed++;
    const hits = await resolveCompany(name).catch(() => []);
    const best = hits[0];
    if (best && best.nameVerified !== false) {
      cache[key] = { ats: best.ats, slug: best.slug, resolvedAt: new Date().toISOString() };
      if (saveExtraCompany({ name, ats: best.ats, slug: best.slug, via: 'discovery' })) {
        added.push(`${name} (${best.ats}/${best.slug})`);
      }
    } else {
      cache[key] = { unresolved: true, resolvedAt: new Date().toISOString() };
    }
  }
  saveResolveCache(cache);
  if (added.length) {
    // stderr so --json stdout stays parseable
    console.error(`[Auto-add] Now tracking directly: ${added.join(', ')} — saved to companies.csv.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const strict = args.includes('--strict');
  const noTelegram = args.includes('--no-telegram');
  const discover = args.includes('--discover');
  const noAutoAdd = args.includes('--no-autoadd');
  if (args.includes('--quiet')) API_LOG_ENABLED = false;
  const watchArg = args.find(a => a.startsWith('--watch='));
  const minSalaryArg = args.find(a => a.startsWith('--min-salary='));
  const minMatchArg = args.find(a => a.startsWith('--min-match='));
  const maxAgeArg = args.find(a => a.startsWith('--max-age='));
  const minSalary = minSalaryArg ? parseInt(minSalaryArg.split('=')[1], 10) : MIN_SALARY;
  const minMatch = minMatchArg ? parseInt(minMatchArg.split('=')[1], 10) : GOOD_MATCH_THRESHOLD;
  const maxAgeDays = maxAgeArg ? parseFloat(maxAgeArg.split('=')[1]) : MAX_AGE_DAYS;

  // --add-company mode: resolve slug(s), save, exit. No scan.
  const addCompanyNames = args.filter(a => a.startsWith('--add-company=')).map(a => a.split('=').slice(1).join('='));
  if (addCompanyNames.length) {
    const atsArg = args.find(a => a.startsWith('--ats='));
    const slugArg = args.find(a => a.startsWith('--slug='));
    const careersArg = args.find(a => a.startsWith('--careers-url='));
    if (careersArg && addCompanyNames.length === 1) {
      const { message } = await addCustomCompany(addCompanyNames[0], careersArg.split('=').slice(1).join('='));
      console.log(message);
    } else {
      const forced = atsArg && slugArg && addCompanyNames.length === 1
        ? { ats: atsArg.split('=')[1], slug: slugArg.split('=')[1] }
        : null;
      for (const name of addCompanyNames) await addCompanyByName(name, forced);
    }
    console.log(`\nTracking ${getAllCompanies().length} companies total.`);
    return;
  }

  const scanOpts = { jsonOut, strict, noTelegram, discover, noAutoAdd, minSalary, minMatch, maxAgeDays };
  const runOnce = () => performScan(scanOpts);

  if (watchArg) {
    const intervalSec = parseInt(watchArg.split('=')[1], 10) || 1800;
    console.log(`Watching ${getAllCompanies().length} companies every ${intervalSec}s${discover ? ' + open discovery (Remotive, The Muse)' : ''}. Ctrl+C to stop.`);
    // Never let two scans overlap if one run takes longer than intervalSec.
    let scanning = false;
    const safeScan = async () => {
      if (scanning) return;
      scanning = true;
      try { await runOnce(); } finally { scanning = false; }
    };
    await safeScan(); // first run only alerts on jobs posted since the last scan cursor
    setInterval(safeScan, intervalSec * 1000);
  } else {
    await runOnce();
  }
}

// One complete scan cycle: fetch -> filter -> print -> alert -> record.
// Exported for reuse outside the CLI paths above, which all call this too.
async function performScan(opts = {}) {
  const {
    jsonOut = false,
    strict = false,
    noTelegram = false,
    discover = false,
    noAutoAdd = false,
    minSalary = MIN_SALARY,
    minMatch = GOOD_MATCH_THRESHOLD,
    maxAgeDays = MAX_AGE_DAYS
  } = opts;
  {
    const run = {
      timestamp: new Date().toISOString(),
      timestampLocal: new Date().toLocaleString()
    };
    const statsBefore = { ...apiStats };
    apiLog(`── scan starting (${run.timestampLocal}) ──`);
    const { results, errors, feedStats, droppedForSalary, unlistedSalaryCount,
            droppedForAge, droppedForLocation, droppedForExcludedTitle } =
      await scanAll({ minSalary, strict, discover, maxAgeDays });
    apiLog(`── scan done: ${apiStats.total - statsBefore.total} requests, ${apiStats.failed - statsBefore.failed} failed ──`);
    if (errors.length) {
      console.error(`\n[${errors.length} feed(s) failed — check slugs]`);
      errors.forEach(e => console.error('  ' + e));
    }

    // Dedup cursor: a job is "new" if the ATS reports it posted/updated after
    // the last run that actually sent Telegram alerts. See LAST_SCAN_PATH.
    const cutoffIso = loadLastScanAt();
    const newSinceLastScan = results.filter(r => isNewSinceCursor(r.postedOrUpdated, cutoffIso));

    // Promising discovered companies -> resolve their ATS board and track
    // them directly from the next scan onward.
    if (discover && !noAutoAdd) {
      await autoAddDiscoveredCompanies(newSinceLastScan, minMatch);
    }

    if (jsonOut) {
      console.log(JSON.stringify({
        runTimestamp: run.timestamp, lastScanAt: cutoffIso, minSalary, minMatch,
        feedStats,
        currentJobs: results,
        newSinceLastScanUrls: newSinceLastScan.map(j => j.url)
      }, null, 2));
    } else {
      console.log(`\n=== Scan · ${run.timestampLocal} ===`);
      printFeedStats(feedStats);
      // ALL currently matching jobs, every run — the cursor only gates Telegram.
      printTable(results, { minSalary, strict, maxAgeDays, droppedForSalary, unlistedSalaryCount, droppedForAge, droppedForLocation, droppedForExcludedTitle });
      console.log(`${newSinceLastScan.length} of ${results.length} posted/updated since the last scan` +
        (cutoffIso ? ` (${cutoffIso}).` : ' (first scan for this profile).'));
    }

    // Telegram: send only what's new since the cursor. The cursor only
    // advances on a run where Telegram is actually configured and enabled —
    // a disabled (--no-telegram) or misconfigured (missing token/chat id)
    // Telegram leaves it in place, so nothing is silently skipped once it's
    // fixed. An individual send failure (network blip, rate limit) with
    // credentials otherwise present does NOT hold the cursor back — that
    // job just won't be retried, the trade-off documented at LAST_SCAN_PATH.
    // These status lines go to stderr in --json mode so stdout stays pure JSON.
    const statusLog = jsonOut ? console.error : console.log;
    const telegramConfigured = !!(process.env[CONFIG.telegram.botTokenEnv] && process.env[CONFIG.telegram.chatIdEnv]);
    if (!noTelegram && telegramConfigured) {
      const toSend = SCORING_ENABLED ? newSinceLastScan.filter(j => j.matchPct >= minMatch) : newSinceLastScan;
      let sent = 0;
      for (const job of toSend) {
        const ok = await sendTelegramMessage(formatTelegramMessage(job, run));
        if (ok) sent++;
      }
      if (toSend.length) {
        statusLog(`[Telegram] Sent ${sent}/${toSend.length} alert(s) at/above ${minMatch}% match.`);
      }
      // No heartbeat by design: Telegram receives ONLY job alerts. A quiet
      // scan is visible in the terminal/GitHub Actions run logs instead.
      statusLog(`Funnel: ${results.length} passed filters -> ${newSinceLastScan.length} new since last scan -> ${toSend.length} at/above ${minMatch}% match -> ${sent} sent to Telegram.`);
      saveLastScanAt(run.timestamp);
    } else if (newSinceLastScan.length) {
      const why = noTelegram ? '--no-telegram passed' : `${CONFIG.telegram.botTokenEnv}/${CONFIG.telegram.chatIdEnv} not set`;
      statusLog(`[Telegram disabled: ${why}] Scan cursor not advanced — these will still look new on the next Telegram-enabled run.`);
    }
  }
}

// Run the CLI only when executed directly (node job_watch.js ...).
// When require()d — e.g. by the Vercel function — just export.
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// Exported beyond the CLI's own needs so other scripts in this folder (e.g.
// hiring_cafe_scan.js) can reuse this profile's exact tracks/thresholds/
// location policy/Telegram destination instead of redefining their own.
module.exports = {
  performScan, getAllCompanies, sendTelegramMessage,
  CONFIG, DATA_DIR, DISCOVERY_QUERIES,
  classifyTrack, scoreJob, locationAllowed,
  REMOTE_INCLUDE_RE, REMOTE_EXCLUDE_RE,
  MIN_SALARY, GOOD_MATCH_THRESHOLD, MAX_AGE_DAYS, EXCLUDED_TITLE_TERMS, CURRENCY_SYMBOL, SCORING_ENABLED,
  formatTelegramMessage, setApiLogEnabled
};
