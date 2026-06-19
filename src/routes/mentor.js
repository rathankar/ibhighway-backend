const pool = require('../db');

// App name mapping: subject+task → credit app key
const APP_KEY = {
  physics: { ia: 'ia_mentor',  ee: 'ee_mentor',  tok: 'tok_mentor'  },
  chem:    { ia: 'chem_ia',    ee: 'chem_ee',    tok: 'chem_tok'    },
  bio:     { ia: 'bio_ia',     ee: 'bio_ee',     tok: 'bio_tok'     },
  ess:     { ia: 'ess_ia',     ee: 'ess_ee',     tok: 'ess_tok'     },
};

// Gemini pricing per token (USD)
const GEMINI_PRICING = {
  'gemini-2.0-flash':      { input: 0.10 / 1_000_000, output: 0.40 / 1_000_000 },
  'gemini-2.0-flash-exp':  { input: 0.10 / 1_000_000, output: 0.40 / 1_000_000 },
  'gemini-1.5-flash':      { input: 0.075 / 1_000_000, output: 0.30 / 1_000_000 },
  'gemini-1.5-flash-8b':   { input: 0.0375 / 1_000_000, output: 0.15 / 1_000_000 },
  'gemini-1.5-pro':        { input: 1.25 / 1_000_000, output: 5.00 / 1_000_000 },
  'gemini-2.5-pro':        { input: 1.25 / 1_000_000, output: 10.00 / 1_000_000 },
};

const INR_RATE = 84; // approximate USD → INR conversion
const MONTHLY_TOKEN_CAP = 500_000; // soft limit per student per calendar month

function computeCost(model, inputTokens, outputTokens) {
  const p = GEMINI_PRICING[model] || GEMINI_PRICING['gemini-2.0-flash'];
  return parseFloat(((inputTokens * p.input) + (outputTokens * p.output)).toFixed(6));
}

async function logUsage({ studentId, app, model, inputTokens, outputTokens, totalTokens, costUsd }) {
  try {
    await pool.query(
      `INSERT INTO ai_usage_log (student_id, app, model, input_tokens, output_tokens, total_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [studentId, app, model, inputTokens, outputTokens, totalTokens, costUsd]
    );
  } catch (err) {
    console.error('AI usage log error:', err.message);
  }
}

module.exports = async function mentorRoutes(app) {

  // ── POST /api/mentor/gemini ──────────────────────────────────────────────────
  // Proxy Gemini generateContent so the key never leaves the backend.
  // Body: { model, contents, systemInstruction, generationConfig, app }
  app.post('/gemini', { onRequest: [app.authenticate] }, async (req, reply) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return reply.code(503).send({ error: 'Gemini not configured on server' });

    const {
      model = 'gemini-2.0-flash',
      contents,
      systemInstruction,
      generationConfig,
      app: appName = 'mentor',   // which utility is calling — defaults to 'mentor'
    } = req.body || {};

    if (!contents?.length) return reply.code(400).send({ error: 'contents is required' });

    // ── Monthly token cap check ──────────────────────────────────────────────
    const capRes = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0)::int AS used
       FROM ai_usage_log
       WHERE student_id = $1
         AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`,
      [req.user.id]
    );
    const tokensUsedThisMonth = capRes.rows[0]?.used || 0;
    if (tokensUsedThisMonth >= MONTHLY_TOKEN_CAP) {
      return reply.code(429).send({
        error: `Monthly AI limit reached (${MONTHLY_TOKEN_CAP.toLocaleString()} tokens). Your limit resets on the 1st of next month.`,
        tokens_used: tokensUsedThisMonth,
        token_cap: MONTHLY_TOKEN_CAP,
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
    const res = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, systemInstruction, generationConfig }),
    });

    const data = await res.json();
    if (!res.ok) {
      const code = data?.error?.code || res.status;
      return reply.code(code < 600 ? code : 500).send({ error: data?.error?.message || 'Gemini error' });
    }

    // Log token usage (non-blocking — fire and forget)
    const usage = data?.usageMetadata || {};
    const inputTokens  = usage.promptTokenCount     || 0;
    const outputTokens = usage.candidatesTokenCount || 0;
    const totalTokens  = usage.totalTokenCount      || (inputTokens + outputTokens);
    const costUsd      = computeCost(model, inputTokens, outputTokens);

    logUsage({
      studentId:    req.user.id,
      app:          appName,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
    });

    return data;
  });

  // ── POST /api/mentor/tts ─────────────────────────────────────────────────────
  // Proxy ElevenLabs TTS; returns audio/mpeg stream.
  // Body: { text, voice_id? }
  app.post('/tts', { onRequest: [app.authenticate] }, async (req, reply) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey || apiKey === 'sandbox_mode')
      return reply.code(503).send({ error: 'TTS not configured' });

    const { text, voice_id = 'pNInz6obpgDQGcFmaJgB' } = req.body || {}; // default: Adam
    if (!text) return reply.code(400).send({ error: 'text is required' });

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}?optimize_streaming_latency=3`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return reply.code(res.status).send({ error: err?.detail?.message || err?.detail || 'TTS failed' });
    }

    const buffer = await res.arrayBuffer();
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(buffer));
  });

  // ── POST /api/mentor/send-rq ─────────────────────────────────────────────────
  // Send the final RQ to the student's phone via WhatsApp, falling back to SMS.
  // Body: { rq_text, subject, task }
  app.post('/send-rq', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { rq_text, subject, task } = req.body || {};
    if (!rq_text) return reply.code(400).send({ error: 'rq_text is required' });

    const uRes = await pool.query('SELECT name, phone FROM users WHERE id=$1', [req.user.id]);
    const user = uRes.rows[0];
    if (!user?.phone)
      return reply.code(400).send({ error: 'No phone number found on your account. Please update your profile.' });

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_FROM_NUMBER;

    // ── TWILIO DISABLED FOR TESTING — re-enable by removing the next 2 lines ──
    return reply.code(503).send({ error: 'Messaging temporarily disabled during testing.' });
    // if (!accountSid || !authToken || !fromNumber)
    //   return reply.code(503).send({ error: 'Messaging not configured on server' });

    const subjectLabel = { physics:'Physics', chem:'Chemistry', bio:'Biology', ess:'ESS' }[subject] || subject || '';
    const taskLabel    = { ia:'IA', ee:'EE', tok:'TOK' }[task] || task || '';
    const msgBody =
      `📚 IBHighway Mentor\n` +
      `${subjectLabel} ${taskLabel} — Your Research Question\n\n` +
      `${rq_text}\n\n` +
      `Good luck with your ${taskLabel}! — ibhighway.com`;

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    let via = null;
    try {
      const waRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: authHeader },
        body: new URLSearchParams({
          From: `whatsapp:${fromNumber}`,
          To:   `whatsapp:${user.phone}`,
          Body: msgBody,
        }).toString(),
      });
      if (waRes.ok) via = 'whatsapp';
    } catch (_) {}

    if (!via) {
      const smsRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: authHeader },
        body: new URLSearchParams({
          From: fromNumber,
          To:   user.phone,
          Body: msgBody,
        }).toString(),
      });
      if (!smsRes.ok) {
        const err = await smsRes.json().catch(() => ({}));
        return reply.code(500).send({ error: 'Could not send message: ' + (err.message || 'unknown') });
      }
      via = 'sms';
    }

    return { ok: true, via };
  });

  // ── GET /api/mentor/admin/usage ──────────────────────────────────────────────
  // Admin: full AI token usage report with costs
  app.get('/admin/usage', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    const { from, to, app: appFilter } = req.query;
    const conditions = [];
    const params = [];

    if (from)      { params.push(from);      conditions.push(`l.created_at >= $${params.length}`) }
    if (to)        { params.push(to + ' 23:59:59'); conditions.push(`l.created_at <= $${params.length}`) }
    if (appFilter) { params.push(appFilter); conditions.push(`l.app = $${params.length}`) }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Per-session log
    const sessionsRes = await pool.query(`
      SELECT
        l.id, l.app, l.model,
        l.input_tokens, l.output_tokens, l.total_tokens,
        l.cost_usd,
        ROUND(l.cost_usd * ${INR_RATE}, 2) AS cost_inr,
        l.created_at,
        u.id AS student_id, u.name AS student_name, u.email AS student_email
      FROM ai_usage_log l
      JOIN users u ON l.student_id = u.id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT 500
    `, params);

    // Per-student summary
    const studentsRes = await pool.query(`
      SELECT
        u.id AS student_id, u.name AS student_name, u.email AS student_email,
        COUNT(*)::int                        AS sessions,
        SUM(l.total_tokens)::int             AS total_tokens,
        SUM(l.input_tokens)::int             AS input_tokens,
        SUM(l.output_tokens)::int            AS output_tokens,
        ROUND(SUM(l.cost_usd)::numeric, 6)   AS cost_usd,
        ROUND(SUM(l.cost_usd * ${INR_RATE})::numeric, 2) AS cost_inr,
        MAX(l.created_at)                    AS last_used
      FROM ai_usage_log l
      JOIN users u ON l.student_id = u.id
      ${where}
      GROUP BY u.id, u.name, u.email
      ORDER BY cost_usd DESC
    `, params);

    // Per-app summary
    const appsRes = await pool.query(`
      SELECT
        l.app,
        COUNT(*)::int                        AS sessions,
        SUM(l.total_tokens)::int             AS total_tokens,
        ROUND(SUM(l.cost_usd)::numeric, 6)   AS cost_usd,
        ROUND(SUM(l.cost_usd * ${INR_RATE})::numeric, 2) AS cost_inr,
        COUNT(DISTINCT l.student_id)::int    AS unique_students
      FROM ai_usage_log l
      ${where}
      GROUP BY l.app
      ORDER BY cost_usd DESC
    `, params);

    // Overall summary
    const totalRes = await pool.query(`
      SELECT
        COUNT(*)::int                        AS total_sessions,
        COUNT(DISTINCT l.student_id)::int    AS unique_students,
        COALESCE(SUM(l.total_tokens),0)::int AS total_tokens,
        ROUND(COALESCE(SUM(l.cost_usd),0)::numeric, 6) AS total_cost_usd,
        ROUND(COALESCE(SUM(l.cost_usd * ${INR_RATE}),0)::numeric, 2) AS total_cost_inr
      FROM ai_usage_log l
      ${where}
    `, params);

    return {
      summary:  totalRes.rows[0],
      by_app:   appsRes.rows,
      students: studentsRes.rows,
      sessions: sessionsRes.rows,
      inr_rate: INR_RATE,
    };
  });
};
