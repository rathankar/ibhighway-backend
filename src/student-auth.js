// ─── STUDENT VERIFICATION (server-side tier gate) ────────────────────────────
// The tier source of truth is auth.php on Hostinger (same store the tools'
// client-side IBH.init() checks). These helpers let Fastify routes enforce
// tier + the shared diary run cap SERVER-SIDE, so calling the API directly
// (bypassing the tool pages) no longer bypasses gating.
//
// Fails closed: if auth.php is unreachable or says inactive, the request is
// rejected. A short cache keeps this to ~1 upstream call per code per 5 min.

const AUTH_URL = process.env.IBH_AUTH_URL || 'https://ibhighway.com/auth.php';
const CACHE_MS = 5 * 60 * 1000;
const _cache = new Map(); // code → { tier, expiry }

// Dev bypass — mirrors tools-auth.js test codes.
const DEV_TIERS = { 'IBH-TEST-0001': 1, 'IBH-TEST-0002': 2, 'IBH-TEST-0003': 3 };

async function _postAuth(action, code) {
  const fd = new FormData();
  fd.append('action', action);
  fd.append('code', code);
  const res = await fetch(AUTH_URL, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`auth.php HTTP ${res.status}`);
  return await res.json();
}

// Returns { tier } or throws { statusCode, message }.
async function verifyStudent(code, minTier) {
  code = String(code || '').trim().toUpperCase();
  if (!code) {
    const e = new Error('Missing student code. Please log in at ibhighway.com.');
    e.statusCode = 401; throw e;
  }
  let tier;
  if (DEV_TIERS[code] !== undefined) {
    tier = DEV_TIERS[code];
  } else {
    const cached = _cache.get(code);
    if (cached && cached.expiry > Date.now()) {
      tier = cached.tier;
    } else {
      let data;
      try {
        data = await _postAuth('subscription-status', code);
      } catch (err) {
        const e = new Error('Could not verify your subscription. Please try again.');
        e.statusCode = 503; throw e;
      }
      if (!data.active || !data.tier) {
        const e = new Error('Invalid or inactive access code. Please log in at ibhighway.com.');
        e.statusCode = 401; throw e;
      }
      tier = parseInt(data.tier);
      _cache.set(code, { tier, expiry: Date.now() + CACHE_MS });
    }
  }
  if (minTier && tier < minTier) {
    const e = new Error(`This tool requires Tier ${minTier}. Please upgrade at ibhighway.com.`);
    e.statusCode = 403; throw e;
  }
  return { code, tier };
}

// Reads the code from body.code or the X-Student-Code header, verifies it,
// and sends the error response itself. Returns { code, tier } or null.
async function requireStudent(req, reply, minTier) {
  const code = (req.body && req.body.code) || req.headers['x-student-code'] || '';
  try {
    return await verifyStudent(code, minTier);
  } catch (e) {
    reply.code(e.statusCode || 401).send({ error: e.message });
    return null;
  }
}

// ── Shared diary run cap (IA/EE/TOK) — same auth.php pool the client used ──
// Check BEFORE generating (never burn quota on a request that will be
// blocked), consume AFTER a successful generation. Dev codes are uncapped.
// Fails OPEN on network error only for consumption (a paying student should
// not lose a successful generation to a blip), but fails CLOSED on the
// pre-check when auth.php explicitly reports the cap is exhausted.
async function checkDiaryRun(code) {
  if (DEV_TIERS[code] !== undefined) return { blocked: false, remaining: null };
  try {
    const data = await _postAuth('diary-run-status', code);
    return { blocked: Number(data.remaining) <= 0, remaining: data.remaining, cap: data.cap };
  } catch (e) {
    return { blocked: false, remaining: null }; // auth.php unreachable — allow
  }
}

async function useDiaryRun(code) {
  if (DEV_TIERS[code] !== undefined) return { message: 'Dev code — run not counted.' };
  try {
    return await _postAuth('diary-use-run', code);
  } catch (e) {
    return {}; // best-effort consumption
  }
}

module.exports = { verifyStudent, requireStudent, checkDiaryRun, useDiaryRun };
