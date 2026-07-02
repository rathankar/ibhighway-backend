'use strict';

/**
 * BridgeSpeak routes — AI English fluency practice
 * Prefix: /api/bridgespeak  (registered in server.js)
 *
 * Auth:    client sends ibh_code as username → backend auto-creates user, returns JWT.
 * Storage: shared Postgres pool (same DB as ibhighway backend).
 * AI:      Gemini via X-Gemini-Key header (fallback: GEMINI_API_KEY env var).
 */

const pool = require('../db');

// ── Ensure tables exist ───────────────────────────────────────────────────────
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bs_users (
      id                 SERIAL PRIMARY KEY,
      username           TEXT   UNIQUE NOT NULL,
      total_score        REAL   DEFAULT 0,
      streak             INTEGER DEFAULT 0,
      last_practice_date DATE,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bs_practice (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES bs_users(id),
      reference_text      TEXT NOT NULL,
      user_transcript     TEXT NOT NULL,
      pronunciation_score REAL DEFAULT 0,
      semantic_score      REAL DEFAULT 0,
      total_score         REAL DEFAULT 0,
      scaffolding_text    TEXT DEFAULT '',
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[BridgeSpeak] Postgres tables ready');
}
initTables().catch(e => console.error('[BridgeSpeak] Table init error:', e.message));

// ── Gemini helper ─────────────────────────────────────────────────────────────
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function callGemini(prompt, apiKey) {
  const key = apiKey;
  if (!key) throw new Error('No Gemini API key. Please add your key in the IBHighway portal.');
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text, model };
    } catch (_) { continue; }
  }
  throw new Error('All Gemini models failed');
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ── WER ───────────────────────────────────────────────────────────────────────
function computeWER(reference, hypothesis) {
  const clean = s => s.toLowerCase().replace(/[.,/#!$%^&*;:{}=\-_`~()?]/g, '').replace(/\s+/g, ' ').trim();
  const rw = clean(reference).split(' ').filter(Boolean);
  const hw = clean(hypothesis).split(' ').filter(Boolean);
  const m = rw.length, n = hw.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = rw[i-1] === hw[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return m > 0 ? dp[m][n] / m : 0;
}

// ── Auth helper ───────────────────────────────────────────────────────────────
function getUser(request, reply) {
  try {
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = request.server.jwt.verify(token);
    return payload.sub; // user id
  } catch (_) {
    reply.code(401).send({ detail: 'Invalid or expired token' });
    return null;
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────
module.exports = async function bridgespeak(fastify) {

  // POST /api/bridgespeak/auth/login
  // Body: { username }  — auto-creates user if new
  fastify.post('/auth/login', async (request, reply) => {
    const { username } = request.body || {};
    if (!username) return reply.code(400).send({ detail: 'username required' });
    const { rows } = await pool.query(
      `INSERT INTO bs_users (username) VALUES ($1)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING *`, [username]
    );
    const user = rows[0];
    const token = fastify.jwt.sign({ sub: user.id }, { expiresIn: '30d' });
    return { access_token: token, token_type: 'bearer' };
  });

  // GET /api/bridgespeak/auth/me
  fastify.get('/auth/me', async (request, reply) => {
    const uid = getUser(request, reply); if (uid == null) return;
    const { rows } = await pool.query('SELECT * FROM bs_users WHERE id = $1', [uid]);
    if (!rows.length) return reply.code(404).send({ detail: 'User not found' });
    const user = rows[0];
    const { rows: rank } = await pool.query(
      'SELECT COUNT(*)+1 AS rank FROM bs_users WHERE total_score > $1', [user.total_score]
    );
    return { id: user.id, username: user.username, total_score: user.total_score, streak: user.streak, rank: Number(rank[0].rank) };
  });

  // POST /api/bridgespeak/practice/evaluate
  fastify.post('/practice/evaluate', async (request, reply) => {
    const uid = getUser(request, reply); if (uid == null) return;
    const geminiKey = request.headers['x-gemini-key'] ;
    const { reference_text, user_transcript } = request.body || {};
    if (!reference_text)
      return reply.code(400).send({ detail: 'reference_text required' });
    // Empty transcript = student didn't speak / mic cut off early
    const transcript = (user_transcript || '').trim();
    if (!transcript) {
      return { pronunciation_score: 0, semantic_score: 0, total_score: 0,
        scaffolding_text: "It looks like nothing was captured. Please try speaking louder and closer to your microphone.",
        scaffolding_triggered: false, streak: 0, wer: 1 };
    }

    const wer = computeWER(reference_text, transcript);
    const pronunciation_score = Math.max(0, Math.round((1 - wer) * 100));

    let semantic_score = 70, scaffolding_text = '', scaffolding_triggered = false;
    try {
      const prompt = `You are a strict but encouraging English pronunciation and fluency tutor for school students in India.

Reference sentence: "${reference_text}"
Student said: "${user_transcript}"
Pronunciation score (WER-based): ${pronunciation_score}%

Tasks:
1. Give a semantic similarity score 0-100 based on meaning and vocabulary match.
2. Write 2-3 sentences of encouraging feedback highlighting what was good and what to improve.
3. If pronunciation_score < 60, provide a simplified shorter version of the sentence and set scaffolding_triggered to true.

Respond ONLY as valid JSON: { "semantic_score": number, "feedback": string, "scaffolding_triggered": boolean, "scaffolding_simplified": string|null }`;

      const { text } = await callGemini(prompt, geminiKey);
      const parsed = parseJson(text);
      if (parsed) {
        semantic_score = parsed.semantic_score ?? 70;
        scaffolding_triggered = parsed.scaffolding_triggered ?? false;
        scaffolding_text = parsed.feedback || '';
        if (scaffolding_triggered && parsed.scaffolding_simplified)
          scaffolding_text += `\nSimplified: "${parsed.scaffolding_simplified}"`;
      }
    } catch (_) {
      scaffolding_text = pronunciation_score >= 80 ? 'Great effort! Your pronunciation was clear and accurate.'
        : pronunciation_score >= 60 ? 'Good attempt! Focus on the words you missed and try again.'
        : 'Keep practicing! Try speaking more slowly and clearly.';
    }

    const total_score = parseFloat(((pronunciation_score * 0.6 + semantic_score * 0.4) / 10).toFixed(2));

    // Update streak + save to DB (non-fatal if DB fails)
    let streak = 0;
    try {
      const { rows: [user] } = await pool.query('SELECT * FROM bs_users WHERE id = $1', [uid]);
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const lastDate = user.last_practice_date ? user.last_practice_date.toISOString?.().slice(0,10) || String(user.last_practice_date).slice(0,10) : null;
      streak = user.streak || 0;
      if (lastDate !== today) {
        streak = lastDate === yesterday ? streak + 1 : 1;
        await pool.query('UPDATE bs_users SET streak = $1, last_practice_date = $2 WHERE id = $3', [streak, today, uid]);
      }
      await pool.query(
        `INSERT INTO bs_practice (user_id, reference_text, user_transcript, pronunciation_score, semantic_score, total_score, scaffolding_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uid, reference_text, transcript, pronunciation_score, semantic_score, total_score, scaffolding_text]
      );
      await pool.query('UPDATE bs_users SET total_score = total_score + $1 WHERE id = $2', [total_score, uid]);
    } catch (dbErr) {
      console.error('[BridgeSpeak] DB error in evaluate (non-fatal):', dbErr.message);
    }

    return { pronunciation_score, semantic_score, total_score, scaffolding_text, scaffolding_triggered, streak, wer: parseFloat(wer.toFixed(3)) };
  });

  // GET /api/bridgespeak/practice/history
  fastify.get('/practice/history', async (request, reply) => {
    const uid = getUser(request, reply); if (uid == null) return;
    const { rows } = await pool.query(
      'SELECT * FROM bs_practice WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [uid]
    );
    return rows;
  });

  // GET /api/bridgespeak/leaderboard
  fastify.get('/leaderboard', async (request, reply) => {
    const uid = getUser(request, reply); if (uid == null) return;
    const { rows } = await pool.query(
      'SELECT id, username, total_score, streak FROM bs_users ORDER BY total_score DESC LIMIT 20'
    );
    return { leaderboard: rows.map((u, i) => ({ ...u, rank: i + 1 })) };
  });

  // POST /api/bridgespeak/tutor/chat
  fastify.post('/tutor/chat', async (request, reply) => {
    const uid = getUser(request, reply); if (uid == null) return;
    const geminiKey = request.headers['x-gemini-key'] ;
    const { message, context } = request.body || {};
    const prompt = `You are BridgeSpeak Tutor, a friendly AI English fluency coach for school students in India. Keep responses concise (2-4 sentences). Context: ${context || 'General English practice'}. Student asks: "${message}"`;
    try {
      const { text } = await callGemini(prompt, geminiKey);
      return { reply: text };
    } catch (_) {
      return { reply: "I'm having trouble connecting. Please check your Gemini API key." };
    }
  });

  // POST /api/bridgespeak/tutor/pronounce
  fastify.post('/tutor/pronounce', async (request, reply) => {
    const uid = getUser(request, reply); if (uid == null) return;
    const geminiKey = request.headers['x-gemini-key'] ;
    const { target_word, spoken_word, sentence_context } = request.body || {};
    const prompt = `Pronunciation coach for Indian school students. Guide for the word "${target_word}"${spoken_word ? ` (student said "${spoken_word}")` : ''}.
Respond ONLY as valid JSON: { "word": string, "ipa": string, "syllables": string, "sounds_like": string, "mouth_tip": string, "common_mistake": string, "practice_phrase": string }`;
    try {
      const { text } = await callGemini(prompt, geminiKey);
      const parsed = parseJson(text);
      if (parsed) return parsed;
      return reply.code(500).send({ detail: 'Could not parse pronunciation guide' });
    } catch (_) {
      return reply.code(500).send({ detail: 'Gemini error' });
    }
  });

  // POST /api/bridgespeak/express/evaluate
  fastify.post('/express/evaluate', async (request, reply) => {
    const uid = getUser(request, reply); if (uid == null) return;
    const geminiKey = request.headers['x-gemini-key'] ;
    const { raw_input } = request.body || {};
    if (!raw_input) return reply.code(400).send({ detail: 'raw_input required' });
    const prompt = `A Tamil-speaking school student wants to ask their teacher a question, expressed informally in Tanglish.
Input: "${raw_input}"
Respond ONLY as valid JSON: { "clean_question": string, "tamil_check": string }
clean_question = one polite English question they can say to their teacher.
tamil_check = one Tamil sentence confirming what the question means.`;
    try {
      const { text } = await callGemini(prompt, geminiKey);
      const parsed = parseJson(text);
      if (parsed) return parsed;
      return reply.code(500).send({ detail: 'Could not parse response' });
    } catch (_) {
      return reply.code(500).send({ detail: 'Gemini error' });
    }
  });
};
