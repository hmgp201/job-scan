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
 *   node job_watch.js                    -> scan once, print results (min salary $180k)
 *   node job_watch.js --json             -> scan once, print raw JSON
 *   node job_watch.js --min-salary=200000 -> override the $180k floor
 *   node job_watch.js --strict           -> hide postings that don't list a salary at all
 *   node job_watch.js --watch=1800       -> re-scan every 1800s (30 min), only alert on NEW postings
 *   node job_watch.js --min-match=50     -> only send Telegram alerts for jobs at/above this match %
 *   node job_watch.js --max-age=7        -> override the 3-day freshness window
 *   node job_watch.js --quiet            -> hide per-request API logs (they go
 *                                           to stderr; stdout/--json stay clean)
 *
 * HARD FILTERS (edit the constants below to change):
 *   - Postings older than MAX_AGE_DAYS (3) are dropped.
 *   - Titles containing EXCLUDED_TITLE_TERMS (marketing etc.) are dropped.
 *   - Location must be remote (US) OR hybrid/onsite in Washington DC /
 *     Richmond VA. Remote sorts above hybrid everywhere.
 *
 *   node job_watch.js --add-company="Second Nature"
 *       -> auto-resolves the company's Greenhouse/Ashby/Lever board slug and
 *          saves it to companies_extra.json (merged with the built-in list on
 *          every run). No more hunting for slugs by hand. Repeatable flag.
 *          If auto-resolution picks the wrong board (or finds several), force it:
 *   node job_watch.js --add-company="Second Nature" --ats=greenhouse --slug=secondnature
 *
 *   node job_watch.js --add-company="Retool" --careers-url="https://retool.com/careers"
 *       -> for companies NOT on a supported ATS: scrape their own careers
 *          page, no AI involved. Detection cascade: (1) embedded known-ATS
 *          board hiding in the HTML (Greenhouse/Lever/Ashby/Workable/
 *          Recruitee/SmartRecruiters/Rippling -> their public JSON APIs),
 *          (2) schema.org JobPosting JSON-LD blocks, (3) job-link URL
 *          pattern grouping. Limitation: pages that only render listings
 *          with client-side JS can't be scraped this way — the add command
 *          tests the page and tells you what it found before saving.
 *
 *   THE COMPANY LIST LIVES IN companies.csv (created on first run, seeded
 *   from the built-in list; legacy companies_extra.json is auto-migrated).
 *   Columns: Name,ATS,Slug,URL,AddedAt,Via — edit it by hand freely.
 *   ATS is greenhouse|ashby|lever (uses Slug) or custom (uses URL).
 *
 *   node job_watch.js --bot              -> just listen for Telegram commands
 *          (no scheduled scanning). Use this alongside cron-driven scans.
 *
 *   TELEGRAM COMMANDS (work while --watch or --bot is running):
 *     /add Plaid                    -> resolve + track a company, instant reply
 *     /add Name | ats | slug        -> force a specific board
 *     /addpage Name | https://...   -> scrape a company's own careers page
 *     /remove Name                  -> stop tracking a company
 *     /list                         -> show every tracked company
 *     /scan                         -> run a scan right now
 *     /help                         -> show this list
 *   Only messages from YOUR chat id are accepted. Run only ONE listening
 *   process at a time (--watch with Telegram configured already listens;
 *   don't also run --bot, or Telegram will 409 one of them).
 *
 *   node job_watch.js --discover         -> ALSO run an open-discovery pass over
 *          the Remotive and The Muse public aggregator APIs. Broader net, lower
 *          precision: surfaces roles at companies NOT on your list. Hits go
 *          through the exact same track/salary/match pipeline. Any discovered
 *          company whose job clears --min-match gets its ATS slug auto-resolved
 *          and added to companies_extra.json for direct tracking going forward
 *          (disable that with --no-autoadd). Works with --watch too.
 *
 * SALARY FILTERING: pulls the range straight out of the job description text
 * (most US states legally require this). A posting is dropped only if its
 * OWN stated maximum is below your floor. If no range is listed at all, the
 * posting is still shown (flagged "not listed") unless you pass --strict —
 * plenty of legitimate $180k+ roles simply don't disclose in the JD.
 *
 * DEDUPLICATION lives in job_watch_log.csv — the CSV is the ledger of every
 * job ever alerted to Telegram. Each run fetches ALL jobs meeting the
 * criteria and prints them; a job goes to Telegram only if its URL (or
 * company+title, catching aggregator-vs-canonical duplicates) is not already
 * in the CSV, and every successfully sent alert is appended to the CSV in
 * the same moment. Failed/unconfigured sends are NOT recorded, so they
 * retry on the next run. Works the same for --watch and scheduled runs.
 *
 * SCHEDULING: .github/workflows/scan.yml runs a plain `node job_watch.js`
 * every 15 minutes via GitHub Actions cron, then commits any changed state
 * files (job_watch_log.csv, run_counter.json, slug_cache.json) back to the
 * repo so the ledger persists between runs. Set TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID as repo secrets (Settings -> Secrets and variables ->
 * Actions). Trigger a run manually from the Actions tab (workflow_dispatch)
 * to test without waiting for the schedule.
 *
 * TELEGRAM ALERTS: set two environment variables before running:
 *   TELEGRAM_BOT_TOKEN  -> from @BotFather on Telegram (message it "/newbot")
 *   TELEGRAM_CHAT_ID    -> message your new bot once, then visit
 *                          https://api.telegram.org/bot<TOKEN>/getUpdates
 *                          and copy the "chat":{"id": ...} value
 * Only NEW postings that meet --min-match (default 50%) get pushed — this
 * keeps the channel to genuinely good matches, not every posting found.
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

// Where state files live (companies.csv, job_watch_log.csv, run_counter.json,
// slug_cache.json, telegram_offset.json). This is always the script's own
// directory — including in the GitHub Actions runner, where the workflow
// commits the changed state files back to the repo after each run.
const DATA_DIR = process.env.JOB_WATCH_DATA_DIR || __dirname;

// =================================================================
// API REQUEST LOGGING
// Every outbound HTTP request (ATS boards, discovery APIs, slug probes,
// Telegram) is logged to STDERR with a sequence number, status, and
// latency — so you can see exactly which requests happen and whether
// they're working. stdout stays clean, so --json is still parseable.
// Disable with --quiet. Telegram tokens are redacted from logged URLs.
// The routine getUpdates long-poll (fires every ~25s in --watch/--bot)
// is only logged when it FAILS, so it doesn't drown everything else.
// =================================================================
let API_LOG_ENABLED = true; // main() flips this off when --quiet is passed
const apiStats = { total: 0, failed: 0 };
let apiSeq = 0;

function apiLog(msg) {
  if (API_LOG_ENABLED) console.error(`[api ${new Date().toISOString()}] ${msg}`);
}

function redactUrl(url) {
  return String(url).replace(/\/bot[^/]+\//, '/bot<TOKEN>/');
}

const rawFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const id = ++apiSeq;
  apiStats.total++;
  const method = opts?.method || 'GET';
  const shown = redactUrl(url);
  const isRoutinePoll = shown.includes('/getUpdates');
  const t0 = Date.now();
  if (!isRoutinePoll) apiLog(`#${id} -> ${method} ${shown}`);
  try {
    const res = await rawFetch(url, opts);
    if (!res.ok) apiStats.failed++;
    if (!isRoutinePoll || !res.ok) {
      apiLog(`#${id} <- HTTP ${res.status}${res.ok ? '' : ` ${res.statusText}`} in ${Date.now() - t0}ms  ${shown}`);
    }
    return res;
  } catch (err) {
    apiStats.failed++;
    apiLog(`#${id} <- NETWORK ERROR (${err.message}) in ${Date.now() - t0}ms  ${shown}`);
    throw err;
  }
};

// =================================================================
// 1. YOUR THREE CV TRACKS — keywords pulled directly from each resume's
//    SKILLS section. This is what gets diffed against each job description.
//    Add/edit freely as your resumes evolve.
// =================================================================
const TRACKS = {
  tpm_automation: {
    label: 'TPM / Automation & AI',
    resumeFile: 'Harry_Pethel_-_TPM.pdf',
    titleKeywords: [
      'technical program manager', 'tpm', 'business operations', 'biz ops',
      'bizops', 'automation engineer', 'internal tools', 'platform operations',
      'workflow automation', 'operations lead', 'head of operations', 'ai agent',
      'automation lead', 'process automation'
    ],
    // exact terms you already have real skill in — used for synonym swapping
    skillTerms: [
      'n8n', 'zapier', 'retool', 'google apps script', 'airtable', 'clay',
      'la growth machine', 'llm agents', 'prompt engineering', 'workflow design',
      'javascript', 'sql', 'postgresql', 'express.js', 'git', 'github',
      'rest api', 'soap api', 'webhooks', 'snowflake', 'auth0', 'stripe',
      'paypal', 'chargebee', 'netlify', 'hubspot', 'salesforce', 'zendesk',
      'slack', 'notion', 'talentlms', 'activecollab', 'cross-functional',
      'process design', 'roadmap prioritization', 'billing operations',
      'vendor management', 'partner management', 'documentation systems',
      'capm', 'project management'
    ]
  },
  solutions_engineer: {
    label: 'Solutions Engineering / Pre-Sales',
    resumeFile: 'Harry_Pethel_-Solutions_Engineer_docx.pdf',
    titleKeywords: [
      'solutions engineer', 'sales engineer', 'pre-sales', 'presales',
      'solutions architect', 'technical account manager', 'implementation engineer',
      'integration engineer', 'forward deployed engineer', 'deployment strategist',
      'technical program manager'
    ],
    skillTerms: [
      'discovery', 'solution design', 'product demos', 'proof of concept', 'poc',
      'security questionnaire', 'integration scoping', 'onboarding', 'escalation',
      'expansion', 'renewals', 'rest api', 'soap api', 'webhooks', 'javascript',
      'sql', 'postgresql', 'express.js', 'html', 'css', 'git', 'github',
      'snowflake', 'n8n', 'zapier', 'retool', 'google apps script', 'airtable',
      'clay', 'la growth machine', 'llm', 'zendesk', 'hubspot', 'salesforce',
      'slack', 'notion', 'netlify', 'talentlms', 'activecollab'
    ]
  },
  customer_success: {
    label: 'Customer Success / Support Leadership',
    resumeFile: 'Harry_Pethel_-_Support_and_Success.pdf',
    titleKeywords: [
      'customer success', 'support manager', 'support lead', 'customer success manager',
      'csm', 'head of support', 'director of customer success', 'technical support lead',
      'support operations', 'customer experience', 'client success'
    ],
    skillTerms: [
      'enterprise account ownership', 'onboarding', 'implementation', 'escalation management',
      'renewals', 'expansion', 'qa', 'voice of the customer', 'knowledge base',
      'video documentation', 'team management', 'enablement', 'llm', 'n8n', 'zapier',
      'retool', 'google apps script', 'airtable', 'sql', 'postgresql', 'javascript',
      'rest api', 'soap api', 'webhooks', 'auth0', 'stripe', 'paypal', 'chargebee',
      'snowflake', 'git', 'github', 'html', 'css', 'zendesk', 'hubspot', 'salesforce',
      'slack', 'notion', 'talentlms', 'activecollab', 'netlify'
    ]
  }
};

// Common synonym pairs: [job-description phrasing, your resume phrasing]
// When a JD uses the left term and you only have the right term (or vice versa),
// the tool flags it as a 1-word/1-phrase swap — never a rewrite.
// Minimum acceptable base salary. Many states (CA, CO, NY, WA, IL, etc.)
// legally require salary ranges in postings, so this is extracted straight
// from the job description text — no external salary API needed.
// Override at runtime with --min-salary=200000
const MIN_SALARY = 180000;

// Minimum keyword-match % for a job to be "good enough" to push to Telegram
// (and, with --discover, to auto-add the company for direct tracking).
// NOTE ON SCALE: the score is (skill terms found in the JD) / (your ENTIRE
// ~40-term track list), so even excellent fits score 12-21% — a JD never
// mentions all 40 of your terms. Calibrated 2026-08-23 against a full scan
// (118 matching roles: median 8%, top decile 13%, max 21%). 12 ≈ top quartile.
// Override at runtime with --min-match=15
const GOOD_MATCH_THRESHOLD = 4;

// Ignore postings older than this many days (based on the ATS's own
// posted/updated timestamp). Override at runtime with --max-age=7
const MAX_AGE_DAYS = 3;

// Titles containing any of these are dropped no matter what track they'd
// otherwise match (e.g. "Strategy & Operations Lead, Enterprise Marketing").
const EXCLUDED_TITLE_TERMS = ['marketing', 'demand generation', 'demand gen'];

// LOCATION POLICY: remote roles, or hybrid/onsite ONLY in Washington DC or
// Richmond VA. Remote-tagged roles that are explicitly non-US (e.g. "Remote -
// EMEA") are dropped. Jobs with no location listed are kept — vet manually.
// Remote roles sort above the hybrid ones in output and alerts.
function locationAllowed(loc) {
  const l = (loc || '').toLowerCase();
  if (!l) return { allowed: true, isRemote: false }; // not stated — keep, vet manually
  const isRemote = /\bremote\b|work from home|distributed|\banywhere\b/.test(l);
  if (isRemote) {
    const nonUS = /(emea|europe|apac|latam|canada|\buk\b|united kingdom|australia|india|germany|japan|singapore|brazil|mexico|poland|philippines|south korea)/;
    const usSignal = /(united states|\bus\b|\busa\b|north america|americas|worldwide|anywhere|global)/;
    if (nonUS.test(l) && !usSignal.test(l)) return { allowed: false, isRemote: true };
    return { allowed: true, isRemote: true };
  }
  const dcOrRichmond = /washington,?\s*d\.?c\.?|,\s*dc\b|richmond,?\s*(va\b|virginia)/;
  return { allowed: dcOrRichmond.test(l), isRemote: false };
}

const SYNONYMS = [
  ['workflow orchestration', 'automation pipeline'],
  ['low-code', 'no-code'],
  ['process automation', 'workflow automation'],
  ['internal tooling', 'internal tools'],
  ['api integration', 'rest api'],
  ['legacy systems', 'soap api'],
  ['data warehouse', 'snowflake'],
  ['ai agents', 'llm agents'],
  ['generative ai', 'llm'],
  ['customer onboarding', 'onboarding'],
  ['technical implementation', 'implementation'],
  ['revenue operations', 'revops'],
  ['business systems', 'business operations'],
  ['cross functional leadership', 'cross-functional'],
];

// =================================================================
// 2. TARGET COMPANY LIST
//    Grounded in your actual background: API-first B2B SaaS, proptech,
//    fintech/crypto, and automation/dev-tools companies — the kind of
//    place that has an unowned ops problem exactly like the one you solved
//    at Propexo. ats = 'greenhouse' | 'ashby' | 'lever'.
//    slug = the token in the company's public job board URL, e.g.
//      https://job-boards.greenhouse.io/anthropic  -> slug: 'anthropic'
//      https://jobs.ashbyhq.com/retool              -> slug: 'retool'
//      https://jobs.lever.co/ramp                   -> slug: 'ramp'
//    SOME SLUGS BELOW ARE BEST-GUESS AND NEED CONFIRMING — the script
//    will just skip/report an error for any that don't resolve, so it's
//    safe to run as-is and prune afterward.
// =================================================================
// All slugs below were VERIFIED LIVE on 2026-08-23 by probing the actual
// board APIs (many companies had migrated Greenhouse -> Ashby).
const TARGET_COMPANIES = [
  // --- API-first / dev-tools / automation platforms (fits all 3 tracks) ---
  { name: 'Merge',         ats: 'ashby',      slug: 'merge' },
  { name: 'Workato',       ats: 'greenhouse', slug: 'workato' },
  { name: 'Zapier',        ats: 'ashby',      slug: 'zapier' },
  { name: 'Vanta',         ats: 'ashby',      slug: 'vanta' },
  { name: 'Drata',         ats: 'ashby',      slug: 'drata' },
  { name: 'Ironclad',      ats: 'ashby',      slug: 'ironcladhq' },
  { name: 'Ramp',          ats: 'ashby',      slug: 'ramp' },
  { name: 'Mercury',       ats: 'greenhouse', slug: 'mercury' },
  { name: 'Anthropic',     ats: 'greenhouse', slug: 'anthropic' },
  { name: 'Persona',       ats: 'ashby',      slug: 'persona' },
  { name: 'Alloy',         ats: 'greenhouse', slug: 'alloy' },
  { name: 'Middesk',       ats: 'ashby',      slug: 'middesk' },
  { name: 'Codat',         ats: 'ashby',      slug: 'codat' },
  { name: 'Finch',         ats: 'lever',      slug: 'finch' },

  // --- Proptech (direct domain overlap with Propexo) ---
  { name: 'Latch',         ats: 'lever',      slug: 'latch' },
  { name: 'Second Nature', ats: 'ashby',      slug: 'second-nature' },
  { name: 'Steadily',      ats: 'ashby',      slug: 'steadily' },
  { name: 'PropHero',      ats: 'greenhouse', slug: 'prophero' },

  // --- Fintech / crypto (direct domain overlap with Ledgible/Coinbase) ---
  { name: 'Fireblocks',    ats: 'greenhouse', slug: 'fireblocks' },
  { name: 'TaxBit',        ats: 'greenhouse', slug: 'taxbit' },
  { name: 'Chainalysis',   ats: 'ashby',      slug: 'chainalysis-careers' },
  { name: 'Gemini',        ats: 'greenhouse', slug: 'gemini' },

  // --- General B2B SaaS w/ known lean-ops / automation-heavy culture ---
  { name: 'Notion',        ats: 'ashby',      slug: 'notion' },
  { name: 'Linear',        ats: 'ashby',      slug: 'linear' },
  { name: 'Vercel',        ats: 'greenhouse', slug: 'vercel' },

  // =============================================================
  // EXPANSION (added 2026-08-23): every slug below was verified live
  // against the actual board API — name-checked on Greenhouse, or a
  // directly name-derived slug on Ashby/Lever with active postings.
  // More verified-but-not-added companies: companies_backlog.json
  // (add any with: node job_watch.js --add-company="Name")
  // =============================================================

  // --- Fintech infrastructure / payments (SE + TPM fit) ---
  { name: 'Stripe',          ats: 'greenhouse', slug: 'stripe' },
  { name: 'Brex',            ats: 'greenhouse', slug: 'brex' },
  { name: 'Airwallex',       ats: 'ashby',      slug: 'airwallex' },
  { name: 'Bill.com',        ats: 'greenhouse', slug: 'billcom' },
  { name: 'Melio',           ats: 'greenhouse', slug: 'melio' },
  { name: 'Modern Treasury', ats: 'ashby',      slug: 'moderntreasury' },
  { name: 'Anrok',           ats: 'ashby',      slug: 'anrok' },
  { name: 'Sardine',         ats: 'ashby',      slug: 'sardine' },
  { name: 'Socure',          ats: 'ashby',      slug: 'socure' },
  { name: 'Lithic',          ats: 'greenhouse', slug: 'lithic' },
  { name: 'Prove',           ats: 'greenhouse', slug: 'prove' },

  // --- Dev/API platforms ---
  { name: 'Twilio',          ats: 'greenhouse', slug: 'twilio' },
  { name: 'Postman',         ats: 'greenhouse', slug: 'postman' },
  { name: 'Kong',            ats: 'ashby',      slug: 'kong' },
  { name: 'WorkOS',          ats: 'ashby',      slug: 'workos' },
  { name: 'Nylas',           ats: 'ashby',      slug: 'nylas' },

  // --- Crypto (Ledgible/Coinbase domain overlap) ---
  { name: 'Coinbase',        ats: 'greenhouse', slug: 'coinbase' },
  { name: 'Ripple',          ats: 'greenhouse', slug: 'ripple' },
  { name: 'Uniswap Labs',    ats: 'ashby',      slug: 'uniswap' },
  { name: 'Alchemy',         ats: 'ashby',      slug: 'alchemy' },
  { name: 'BitGo',           ats: 'greenhouse', slug: 'bitgo' },
  { name: 'MoonPay',         ats: 'lever',      slug: 'moonpay' },

  // --- Data / dev infrastructure ---
  { name: 'Fivetran',        ats: 'greenhouse', slug: 'fivetran' },
  { name: 'Hightouch',       ats: 'greenhouse', slug: 'hightouch' },
  { name: 'Amplitude',       ats: 'greenhouse', slug: 'amplitude' },
  { name: 'Mixpanel',        ats: 'greenhouse', slug: 'mixpanel' },
  { name: 'LaunchDarkly',    ats: 'greenhouse', slug: 'launchdarkly' },
  { name: 'Temporal',        ats: 'ashby',      slug: 'temporal' },
  { name: 'Supabase',        ats: 'ashby',      slug: 'supabase' },
  { name: 'Sentry',          ats: 'ashby',      slug: 'sentry' },
  { name: 'PagerDuty',       ats: 'greenhouse', slug: 'pagerduty' },
  { name: 'GitLab',          ats: 'greenhouse', slug: 'gitlab' },
  { name: 'Tailscale',       ats: 'greenhouse', slug: 'tailscale' },

  // --- AI ---
  { name: 'Scale AI',        ats: 'greenhouse', slug: 'scaleai' },
  { name: 'Cohere',          ats: 'ashby',      slug: 'cohere' },
  { name: 'Together AI',     ats: 'greenhouse', slug: 'togetherai' },
  { name: 'Baseten',         ats: 'ashby',      slug: 'baseten' },
  { name: 'LangChain',       ats: 'ashby',      slug: 'langchain' },
  { name: 'Perplexity',      ats: 'ashby',      slug: 'perplexity' },
  { name: 'Harvey',          ats: 'ashby',      slug: 'harvey' },
  { name: 'Sierra',          ats: 'ashby',      slug: 'sierra' },
  { name: 'Decagon',         ats: 'ashby',      slug: 'decagon' },

  // --- Compliance / security SaaS (Vanta/Drata adjacent) ---
  { name: 'Secureframe',     ats: 'lever',      slug: 'secureframe' },
  { name: 'Hyperproof',      ats: 'greenhouse', slug: 'hyperproof' },
  { name: 'OneTrust',        ats: 'greenhouse', slug: 'onetrust' },
  { name: 'Abnormal Security', ats: 'greenhouse', slug: 'abnormalsecurity' },

  // --- HR / payroll / hiring tech ---
  { name: 'Gusto',           ats: 'greenhouse', slug: 'gusto' },
  { name: 'Justworks',       ats: 'greenhouse', slug: 'justworks' },
  { name: 'Checkr',          ats: 'greenhouse', slug: 'checkr' },
  { name: 'Greenhouse',      ats: 'greenhouse', slug: 'greenhouse' },
  { name: 'Ashby',           ats: 'ashby',      slug: 'ashby' },

  // --- CS / support / sales tooling (your CS + SE tracks sell these) ---
  { name: 'Help Scout',      ats: 'ashby',      slug: 'helpscout' },
  { name: 'Gorgias',         ats: 'ashby',      slug: 'gorgias' },
  { name: 'Aircall',         ats: 'lever',      slug: 'aircall' },
  { name: 'Dialpad',         ats: 'greenhouse', slug: 'dialpad' },
  { name: 'Pylon',           ats: 'ashby',      slug: 'pylon' },
  { name: 'Outreach',        ats: 'lever',      slug: 'outreach' },
  { name: 'Salesloft',       ats: 'greenhouse', slug: 'salesloft' },
  { name: 'Apollo.io',       ats: 'greenhouse', slug: 'apolloio' },

  // --- Proptech / real estate ---
  { name: 'VTS',             ats: 'greenhouse', slug: 'vts' },
  { name: 'Crexi',           ats: 'greenhouse', slug: 'crexi' },
  { name: 'Blend',           ats: 'greenhouse', slug: 'blend' },
  { name: 'Qualia',          ats: 'greenhouse', slug: 'qualia' },
  { name: 'Roofstock',       ats: 'greenhouse', slug: 'roofstock' },
  { name: 'EliseAI',         ats: 'ashby',      slug: 'eliseai' },
  { name: 'SmartRent',       ats: 'greenhouse', slug: 'smartrent' },
  { name: 'ButterflyMX',     ats: 'ashby',      slug: 'butterflymx' },

  // --- General B2B SaaS ---
  { name: 'Figma',           ats: 'greenhouse', slug: 'figma' },
  { name: 'Airtable',        ats: 'greenhouse', slug: 'airtable' },
  { name: 'Webflow',         ats: 'greenhouse', slug: 'webflow' },
  { name: 'Asana',           ats: 'greenhouse', slug: 'asana' },
  { name: 'Klaviyo',         ats: 'greenhouse', slug: 'klaviyo' },
  { name: 'Braze',           ats: 'greenhouse', slug: 'braze' },

  // REMOVED (probed 2026-08-23, no public Greenhouse/Ashby/Lever board — they
  // run in-house or unsupported ATSs, so this script can't poll them):
  //   Retool, Rippling, Deel (Ashby board exists but 0 postings), AppFolio,
  //   Funnel Leasing, DoorLoop, Rentable, Cotality, Circle, Anchorage Digital,
  //   Bitwave, Clay
  // If any migrate to a supported ATS later, re-add with:
  //   node job_watch.js --add-company="<Name>"
];

// =================================================================
// 2b. COMPANY LIST CSV — companies.csv, next to this script, is the
//     single source of truth for what gets scanned. Editable by hand,
//     by --add-company / --careers-url, and by the Telegram bot.
//     Columns: Name,ATS,Slug,URL,AddedAt,Via
//       ATS 'greenhouse'|'ashby'|'lever' use Slug; ATS 'custom' uses URL
//       (a careers page to scrape without AI — see fetchCustom below).
//     TARGET_COMPANIES above is ONLY the seed used to create the CSV the
//     first time; after that the CSV rules and code edits aren't needed.
// =================================================================
const COMPANIES_CSV_PATH = path.join(DATA_DIR, 'companies.csv');
const COMPANIES_CSV_HEADER = 'Name,ATS,Slug,URL,AddedAt,Via\n';

function companyKey(c) {
  return c.ats === 'custom' ? `custom:${c.url}` : `${c.ats}:${c.slug}`;
}

function companyCsvRow(c) {
  return [c.name, c.ats, c.slug || '', c.url || '', c.addedAt || '', c.via || '']
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

// First run after this feature: seed companies.csv from the built-in list
// plus any legacy companies_extra.json (which is then archived).
function ensureCompaniesCsv() {
  if (fs.existsSync(COMPANIES_CSV_PATH)) return;
  const seed = TARGET_COMPANIES.map(c => ({ ...c, via: 'seed' }));
  const legacyPath = path.join(DATA_DIR, 'companies_extra.json');
  try {
    const extras = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    if (Array.isArray(extras)) seed.push(...extras);
    fs.renameSync(legacyPath, legacyPath + '.migrated');
    console.error('[companies] migrated companies_extra.json into companies.csv');
  } catch { /* no legacy file */ }
  const seen = new Set();
  const rows = seed.filter(c => c.name && c.ats && !seen.has(companyKey(c)) && seen.add(companyKey(c)));
  fs.writeFileSync(COMPANIES_CSV_PATH, COMPANIES_CSV_HEADER + rows.map(companyCsvRow).join('\n') + '\n');
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
    if (c.ats === 'custom' ? !c.url : !c.slug) continue;
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
  return null;
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
  smartrecruiters: fetchSmartRecruiters, rippling: fetchRippling
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

function extractJobLinks(html, baseUrl) {
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const cands = [];
  for (const [, href, inner] of anchors) {
    const text = stripHtml(inner).trim();
    if (text.length < 5 || text.length > 90) continue;
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

async function fetchCustom(co) {
  const res = await fetch(co.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-watch)' } });
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
      const r = await fetch(j.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-watch)' } });
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
const DISCOVERY_QUERIES = [
  'technical program manager', 'solutions engineer', 'sales engineer',
  'customer success manager', 'implementation engineer', 'support manager',
  'workflow automation', 'internal tools'
];

const MUSE_CATEGORIES = [
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

// US-remote heuristic for discovery feeds (the direct ATS list doesn't need
// this — you picked those companies). Keeps unknown/blank locations.
function locationLooksUSRemote(loc) {
  if (!loc) return true;
  const l = loc.toLowerCase();
  if (/(remote|flexible|united states|\busa?\b|worldwide|anywhere|americas)/.test(l)) return true;
  return /,\s?[A-Z]{2}(;|$)/.test(loc); // "Austin, TX" style US city
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

// =================================================================
// CSV LEDGER — job_watch_log.csv is both the log AND the dedup store:
// a job has "already been alerted" iff it's in the CSV. Rows are appended
// the moment a Telegram alert is successfully sent, so separate processes
// (cron runs, --watch, /scan from the bot) all share one source of truth.
// =================================================================
const CSV_PATH = path.join(DATA_DIR, 'job_watch_log.csv');
const CSV_HEADER = 'RunID,RunTimestamp,Company,Title,Track,Match%,Salary,Location,PostedOrUpdated,URL\n';

const comboKey = r => `${normName(r.companyDisplay)}|${normName(r.title)}`;

// Minimal parser for our own CSV format (quoted fields, "" escapes).
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

// Reads the ledger (and any archived _old.csv) into URL + company|title sets.
// Column positions are looked up from each file's own header, so older CSV
// layouts still count toward dedup.
function loadAlertedFromCsv() {
  const urls = new Set();
  const combos = new Set();
  for (const file of [CSV_PATH, CSV_PATH.replace(/\.csv$/, '_old.csv')]) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
    catch { continue; } // file doesn't exist yet
    const header = parseCsvLine(lines[0]);
    const iUrl = header.indexOf('URL');
    const iCompany = header.indexOf('Company');
    const iTitle = header.indexOf('Title');
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const f = parseCsvLine(line);
      if (iUrl >= 0 && f[iUrl]) urls.add(f[iUrl]);
      if (iCompany >= 0 && iTitle >= 0 && f[iCompany] && f[iTitle]) {
        combos.add(`${normName(f[iCompany])}|${normName(f[iTitle])}`);
      }
    }
  }
  return { urls, combos };
}

// Run at the start of every scan: drop ledger rows for jobs older than the
// freshness window. A row survives if EITHER its posting date OR its alert
// time is still inside the window — pruning purely on posting date could
// re-alert a job whose ATS timestamp gets bumped after an edit, so recently
// alerted rows are kept until they age out too. Unparseable dates are kept.
function pruneCsvLedger(maxAgeDays) {
  let lines;
  try { lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n'); }
  catch { return 0; } // no ledger yet
  if (lines[0] + '\n' !== CSV_HEADER) return 0; // unknown format — leave it alone
  const header = parseCsvLine(lines[0]);
  const iRun = header.indexOf('RunTimestamp');
  const iPosted = header.indexOf('PostedOrUpdated');
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const isFresh = (v) => {
    const t = new Date(v).getTime();
    return !Number.isFinite(t) || t >= cutoff;
  };
  const kept = [];
  let pruned = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (isFresh(f[iPosted]) || isFresh(f[iRun])) kept.push(line);
    else pruned++;
  }
  if (pruned) {
    fs.writeFileSync(CSV_PATH, CSV_HEADER + kept.join('\n') + (kept.length ? '\n' : ''));
  }
  return pruned;
}

function ensureCsvReady() {
  if (fs.existsSync(CSV_PATH)) {
    const firstLine = fs.readFileSync(CSV_PATH, 'utf8').split('\n')[0] + '\n';
    // Archive an older-format file rather than appending misaligned rows.
    if (firstLine !== CSV_HEADER) fs.renameSync(CSV_PATH, CSV_PATH.replace(/\.csv$/, '_old.csv'));
  }
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, CSV_HEADER);
}

function appendCsvRow(run, r) {
  ensureCsvReady();
  const row = [run.id, run.timestamp, r.companyDisplay, r.title, r.track, r.matchPct, r.salary, r.location, r.postedOrUpdated, r.url]
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  fs.appendFileSync(CSV_PATH, row + '\n');
}

// =================================================================
// RUN IDs — every scan gets a sequential id (persisted across processes)
// and a timestamp, stamped on terminal output, CSV rows, and Telegram
// alerts so you can always tell which run surfaced a job.
// =================================================================
const RUN_COUNTER_PATH = path.join(DATA_DIR, 'run_counter.json');

function nextRunId() {
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(RUN_COUNTER_PATH, 'utf8')).last || 0; }
  catch { /* first run */ }
  const id = last + 1;
  fs.writeFileSync(RUN_COUNTER_PATH, JSON.stringify({ last: id }));
  return id;
}

// =================================================================
// TELEGRAM
// =================================================================
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('[Telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping alert. See header comment for setup.');
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
  const swaps = job.suggestedSwaps.length
    ? `\nSwap: ${job.suggestedSwaps.map(s => `"${s.youHaveAs}"→"${s.jdUsesPhrase}"`).join(', ')}`
    : '';
  const sourceTag = job.source ? ` (via ${job.source} discovery)` : '';
  const locTag = job.isRemote ? '🏠 Remote' : '🏢 Hybrid';
  const runLine = run ? `\n<i>Run #${run.id} · ${escapeHtml(run.timestampLocal)}</i>` : '';
  return (
    `<b>${escapeHtml(job.companyDisplay)}</b> — ${escapeHtml(job.title)} [${locTag}]${sourceTag}\n` +
    `Track: ${escapeHtml(job.track)}\n` +
    `Match: ${job.matchPct}% | Salary: ${escapeHtml(job.salary)} | Posted ${hoursAgo}h ago\n` +
    `${job.url}${swaps}${runLine}`
  );
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =================================================================
// TELEGRAM COMMAND BOT
// Long-polls getUpdates so you can manage the company list from your
// phone: "/add Plaid" -> resolves the ATS board and replies immediately.
// Runs inside --watch (if Telegram is configured) or standalone via --bot.
// =================================================================
const TG_OFFSET_PATH = path.join(DATA_DIR, 'telegram_offset.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadTgOffset() {
  try { return JSON.parse(fs.readFileSync(TG_OFFSET_PATH, 'utf8')).offset || 0; }
  catch { return 0; }
}
function saveTgOffset(offset) {
  fs.writeFileSync(TG_OFFSET_PATH, JSON.stringify({ offset }));
}

function removeExtraCompany(name) {
  const all = getAllCompanies();
  const idx = all.findIndex(c => normName(c.name) === normName(name));
  if (idx === -1) return null;
  const removed = all[idx];
  const rest = all.filter((_, i) => i !== idx);
  fs.writeFileSync(COMPANIES_CSV_PATH,
    COMPANIES_CSV_HEADER + rest.map(companyCsvRow).join('\n') + (rest.length ? '\n' : ''));
  return removed;
}

const BOT_HELP =
  '<b>Commands</b>\n' +
  '/add Plaid — find &amp; track a company\'s job board\n' +
  '/add Name | ats | slug — force a specific board\n' +
  '/addpage Name | https://... — scrape a company\'s own careers page (no supported ATS needed)\n' +
  '/remove Name — stop tracking a company\n' +
  '/list — show tracked companies\n' +
  '/scan — run a scan right now\n' +
  '/help — this list';

async function handleTelegramCommand(text, triggerScan) {
  const t = text.trim();

  if (/^\/(start|help)\b/i.test(t)) return BOT_HELP;

  const add = t.match(/^\/add\s+(.+)$/is);
  if (add) {
    const parts = add[1].split('|').map(s => s.trim()).filter(Boolean);
    const name = parts[0];

    // Forced form: /add Name | ats | slug
    if (parts.length >= 3) {
      const ats = parts[1].toLowerCase();
      const slug = parts[2];
      const probe = PROBES[ats];
      if (!probe) return `Unknown ATS "${escapeHtml(parts[1])}" — use greenhouse, ashby or lever.`;
      const hit = await probe(slug).catch(() => null);
      if (!hit) return `❌ No live ${escapeHtml(ats)} board at slug "${escapeHtml(slug)}".`;
      return saveExtraCompany({ name, ats: hit.ats, slug: hit.slug, via: 'telegram' })
        ? `✅ Added <b>${escapeHtml(name)}</b>: ${escapeHtml(describeHit(hit))}\nNow tracking ${getAllCompanies().length} companies.`
        : `${escapeHtml(name)} (${hit.ats}/${hit.slug}) is already tracked.`;
    }

    const hits = await resolveCompany(name);
    if (!hits.length) {
      return `❌ No live Greenhouse/Ashby/Lever board found for "${escapeHtml(name)}".\n` +
        `If you know the board, force it:\n/add ${escapeHtml(name)} | ats | slug\n` +
        `Or, if they have their own careers page, send me its URL and I'll scrape it directly:\n` +
        `/addpage ${escapeHtml(name)} | https://...`;
    }
    const best = hits[0];
    if (best.nameVerified === false) {
      return `⚠️ Found board(s) for "${escapeHtml(name)}" but the name doesn't match — not adding automatically:\n` +
        hits.map(h => `• ${escapeHtml(describeHit(h))}`).join('\n') +
        `\nIf one is right: /add ${escapeHtml(name)} | ats | slug`;
    }
    let reply = saveExtraCompany({ name, ats: best.ats, slug: best.slug, via: 'telegram' })
      ? `✅ Added <b>${escapeHtml(name)}</b>: ${escapeHtml(describeHit(best))}\nNow tracking ${getAllCompanies().length} companies — included from the next scan.`
      : `${escapeHtml(name)} (${best.ats}/${best.slug}) is already tracked.`;
    for (const alt of hits.slice(1)) reply += `\n(also found: ${escapeHtml(describeHit(alt))})`;
    return reply;
  }

  const ap = t.match(/^\/addpage\s+(.+)$/is);
  if (ap) {
    const parts = ap[1].split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return 'Usage: /addpage Company Name | https://their-careers-page';
    const { ok, message } = await addCustomCompany(parts[0], parts[1]);
    return `${ok ? '✅' : '❌'} ${escapeHtml(message)}${ok ? `\nNow tracking ${getAllCompanies().length} companies.` : ''}`;
  }

  const rm = t.match(/^\/remove\s+(.+)$/is);
  if (rm) {
    const name = rm[1].trim();
    const removed = removeExtraCompany(name);
    return removed
      ? `🗑 Removed <b>${escapeHtml(removed.name)}</b> (${removed.ats === 'custom' ? removed.url : `${removed.ats}/${removed.slug}`}). Tracking ${getAllCompanies().length} companies.`
      : `Not tracking anything called "${escapeHtml(name)}".`;
  }

  if (/^\/list\b/i.test(t)) {
    const companies = getAllCompanies();
    return `<b>Tracking ${companies.length} companies</b>\n` +
      companies.map(c => `${escapeHtml(c.name)} (${c.ats})`).join(', ');
  }

  if (/^\/scan\b/i.test(t)) {
    if (!triggerScan) return 'No scanner attached in this mode.';
    triggerScan(); // fire and forget — results arrive as normal job alerts
    return '🔍 Scanning now — any new matches will arrive as separate alerts.';
  }

  if (t.startsWith('/')) return `Unknown command.\n\n${BOT_HELP}`;
  return null; // ignore plain (non-command) messages
}

async function telegramCommandLoop(triggerScan) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('[Telegram bot] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — command bot disabled.');
    return;
  }
  console.log('[Telegram bot] Listening for commands (/help for the list).');
  let offset = loadTgOffset();
  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset + 1}&allowed_updates=%5B%22message%22%5D`
      );
      if (res.status === 409) {
        console.error('[Telegram bot] Another process is already polling this bot (409) — stopping this listener.');
        return;
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
      for (const update of data.result || []) {
        offset = Math.max(offset, update.update_id);
        saveTgOffset(offset);
        const msg = update.message;
        // Only obey your own chat — anyone can message a bot.
        if (!msg || !msg.text || String(msg.chat?.id) !== String(chatId)) continue;
        try {
          const reply = await handleTelegramCommand(msg.text, triggerScan);
          if (reply) await sendTelegramMessage(reply);
        } catch (err) {
          await sendTelegramMessage(`Error: ${escapeHtml(err.message)}`);
        }
      }
    } catch (err) {
      console.error(`[Telegram bot] poll error: ${err.message} — retrying in 5s`);
      await sleep(5000);
    }
  }
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

function scoreJob(job, trackKey) {
  const track = TRACKS[trackKey];
  const descLower = job.description.toLowerCase();
  const haveTerms = [];
  const missingTerms = [];

  for (const term of track.skillTerms) {
    if (descLower.includes(term.toLowerCase())) haveTerms.push(term);
  }

  // Find JD terms you don't literally have but DO have via synonym —
  // these are your safe, non-obvious keyword swaps.
  const suggestedSwaps = [];
  for (const [jdTerm, resumeTerm] of SYNONYMS) {
    if (descLower.includes(jdTerm) && track.skillTerms.includes(resumeTerm)) {
      suggestedSwaps.push({ jdUsesPhrase: jdTerm, youHaveAs: resumeTerm });
    }
  }

  // crude "required skills" extraction: lines/sentences containing
  // requirement signal words, scanned for terms you're missing entirely
  const requirementSignals = ['required', 'must have', 'requirements', 'qualifications', 'you have', 'you bring'];
  const hasRequirementsSection = requirementSignals.some(s => descLower.includes(s));

  const matchPct = track.skillTerms.length
    ? Math.round((haveTerms.length / track.skillTerms.length) * 100)
    : 0;

  return {
    matchPct,
    haveTerms,
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

    const { matchPct, haveTerms, suggestedSwaps } = scoreJob(job, trackKey);
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
      suggestedSwaps,
      salary: salary ? `$${salary.min.toLocaleString()}-$${salary.max.toLocaleString()}` : 'not listed'
    });
  };

  const directPass = Promise.all(companies.map(async (co) => {
    const label = co.ats === 'custom' ? `${co.name} (custom: ${co.url})` : `${co.name} (${co.ats}/${co.slug})`;
    const stat = newFeedStat(label);
    try {
      let jobs;
      if (co.ats === 'custom') {
        const scraped = await fetchCustom(co);
        stat.method = scraped.method;
        jobs = scraped.jobs;
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
          if (!locationLooksUSRemote(job.location)) continue;
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
  console.log(`\nFound ${results.length} matching roles (min salary floor: $${meta.minSalary.toLocaleString()}, max age: ${meta.maxAgeDays}d, remote or DC/Richmond hybrid only):\n`);
  if (meta.droppedForSalary) {
    console.log(`(Filtered out ${meta.droppedForSalary} posting(s) below the floor.)`);
  }
  if (meta.droppedForAge) {
    console.log(`(Filtered out ${meta.droppedForAge} posting(s) older than ${meta.maxAgeDays} days.)`);
  }
  if (meta.droppedForLocation) {
    console.log(`(Filtered out ${meta.droppedForLocation} posting(s) outside remote / Washington DC / Richmond VA.)`);
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
    console.log(`   Location: ${r.location || 'n/a'} | Salary: ${r.salary} | Posted/updated: ${hoursAgo}h ago | Match: ${r.matchPct}%`);
    console.log(`   Apply direct: ${r.url}`);
    if (r.suggestedSwaps.length) {
      console.log(`   Keyword swaps to make: ${r.suggestedSwaps.map(s => `"${s.youHaveAs}" -> "${s.jdUsesPhrase}"`).join(', ')}`);
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
    const probe = PROBES[forced.ats];
    if (!probe) { console.error(`Unknown ATS "${forced.ats}" — use greenhouse | ashby | lever.`); return; }
    const hit = await probe(forced.slug).catch(() => null);
    if (!hit) { console.error(`No live ${forced.ats} board at slug "${forced.slug}".`); return; }
    const added = saveExtraCompany({ name, ats: hit.ats, slug: hit.slug, via: 'manual' });
    console.log(added ? `Added ${name}: ${describeHit(hit)}` : `${name} (${hit.ats}/${hit.slug}) is already tracked.`);
    return;
  }

  console.log(`Resolving "${name}" (trying ${slugCandidates(name).join(', ')} on all three ATSs)...`);
  const hits = await resolveCompany(name);
  if (!hits.length) {
    console.log(`  No live board found. If you know the board, force it:\n` +
      `  node job_watch.js --add-company="${name}" --ats=<greenhouse|ashby|lever> --slug=<slug>\n` +
      `  Or, if they have their own careers page, scrape it directly (no AI):\n` +
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
    newJobs.filter(j => j.source && j.matchPct >= minMatch).map(j => j.companyDisplay)
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
    console.error(`[Auto-add] Now tracking directly: ${added.join(', ')} — saved to companies_extra.json.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const strict = args.includes('--strict');
  const noTelegram = args.includes('--no-telegram');
  const discover = args.includes('--discover');
  const noAutoAdd = args.includes('--no-autoadd');
  const botOnly = args.includes('--bot');
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

  // Never let a /scan command and the interval timer scan simultaneously.
  let scanning = false;
  const safeScan = async () => {
    if (scanning) return;
    scanning = true;
    try { await runOnce(); } finally { scanning = false; }
  };

  if (botOnly) {
    console.log('Bot-only mode: no scheduled scans (pair this with cron, or use /scan).');
    await telegramCommandLoop(safeScan);
  } else if (watchArg) {
    const intervalSec = parseInt(watchArg.split('=')[1], 10) || 1800;
    console.log(`Watching ${getAllCompanies().length} companies every ${intervalSec}s${discover ? ' + open discovery (Remotive, The Muse)' : ''}. Ctrl+C to stop.`);
    if (!noTelegram) telegramCommandLoop(safeScan); // runs alongside the scan interval
    await safeScan(); // first run only alerts on jobs not already in the CSV ledger
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
      id: nextRunId(),
      timestamp: new Date().toISOString(),
      timestampLocal: new Date().toLocaleString()
    };
    const statsBefore = { ...apiStats };
    apiLog(`── run #${run.id} starting ──`);
    const { results, errors, feedStats, droppedForSalary, unlistedSalaryCount,
            droppedForAge, droppedForLocation, droppedForExcludedTitle } =
      await scanAll({ minSalary, strict, discover, maxAgeDays });
    apiLog(`── run #${run.id} scan done: ${apiStats.total - statsBefore.total} requests, ${apiStats.failed - statsBefore.failed} failed ──`);
    if (errors.length) {
      console.error(`\n[${errors.length} feed(s) failed — check slugs]`);
      errors.forEach(e => console.error('  ' + e));
    }

    // Age out ledger rows past the freshness window before reading it.
    const prunedRows = pruneCsvLedger(maxAgeDays);
    if (prunedRows) console.log(`[ledger] Pruned ${prunedRows} row(s) older than ${maxAgeDays} day(s) from job_watch_log.csv.`);

    // The CSV is the dedup ledger: a job counts as already-alerted if its
    // URL — or its company+title combo, which catches the same role under an
    // aggregator link vs the canonical ATS link — is already in the file.
    const alerted = loadAlertedFromCsv();
    const notYetAlerted = results.filter(r =>
      !alerted.urls.has(r.url) && !alerted.combos.has(comboKey(r))
    );

    // Promising discovered companies -> resolve their ATS board and track
    // them directly from the next scan onward.
    if (discover && !noAutoAdd) {
      await autoAddDiscoveredCompanies(notYetAlerted, minMatch);
    }

    if (jsonOut) {
      console.log(JSON.stringify({
        runId: run.id, runTimestamp: run.timestamp, minSalary, minMatch,
        feedStats,
        currentJobs: results,
        notYetAlertedUrls: notYetAlerted.map(j => j.url)
      }, null, 2));
    } else {
      console.log(`\n=== Run #${run.id} · ${run.timestampLocal} ===`);
      printFeedStats(feedStats);
      // ALL currently matching jobs, every run — dedup only gates Telegram.
      printTable(results, { minSalary, strict, maxAgeDays, droppedForSalary, unlistedSalaryCount, droppedForAge, droppedForLocation, droppedForExcludedTitle });
      console.log(`${notYetAlerted.length} of ${results.length} not yet in the CSV ledger.`);
    }

    // Telegram: send only what's NOT already in the CSV, and append each
    // successfully sent alert to the CSV in the same moment. A failed send
    // is deliberately not recorded, so it retries next run.
    if (!noTelegram) {
      const toSend = notYetAlerted.filter(j => j.matchPct >= minMatch);
      let sent = 0;
      for (const job of toSend) {
        const ok = await sendTelegramMessage(formatTelegramMessage(job, run));
        if (ok) {
          appendCsvRow(run, job);
          alerted.urls.add(job.url);
          alerted.combos.add(comboKey(job));
          sent++;
        }
      }
      if (toSend.length) {
        console.log(`[Telegram] Sent ${sent}/${toSend.length} alert(s) at/above ${minMatch}% match — each recorded in the CSV.`);
      }
      // No heartbeat by design: Telegram receives ONLY job alerts. A quiet
      // scan is visible in the terminal/GitHub Actions run logs instead.
      console.log(`Funnel: ${results.length} passed filters -> ${notYetAlerted.length} not yet in CSV -> ${toSend.length} at/above ${minMatch}% match -> ${sent} sent to Telegram & saved to CSV.`);
    } else if (notYetAlerted.length) {
      console.log(`[--no-telegram] Nothing recorded to the CSV — these will alert on the next Telegram-enabled run.`);
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

module.exports = { performScan, getAllCompanies, sendTelegramMessage };
