const pool = require('../db');

const DAILY_LIMIT = 3;

// Check if student has an active subscription
async function hasActiveSubscription(studentId) {
  const res = await pool.query(
    `SELECT id FROM subscriptions
     WHERE user_id=$1 AND type='student_annual'
       AND status='active' AND expires_at > NOW()
     LIMIT 1`,
    [studentId]
  );
  return res.rows.length > 0;
}

async function getDailyUsage(studentId) {
  const res = await pool.query(
    `SELECT COUNT(*) FROM ai_usage_log
     WHERE student_id=$1 AND app='ee_compass' AND created_at >= NOW() - INTERVAL '24 hours'`,
    [studentId]
  );
  return parseInt(res.rows[0].count);
}

const SYSTEM_PROMPT = `You are a senior IB Extended Essay coordinator and subject specialist with 15+ years of experience supervising EE students. You know exactly what makes an EE topic viable or problematic.

Your two priorities are:
1. FEASIBILITY — Is this topic actually doable within 4,000 words, by a high school student, with accessible sources, within a typical school year? Be honest and specific about what could go wrong.
2. CRITICAL THINKING — Does the research question allow for genuine analysis, argument, and evaluation — not just description or data collection? The IB awards 12 of 30 marks to Criterion C (Critical Thinking) alone.

You also help students frame a professional research question in clear academic English — many students have great ideas but struggle to phrase them formally. Your job is to help them say what they mean in the language their supervisor expects.

STRICT RULE: Never suggest quantum mechanics, quantum physics, quantum computing, or any quantum-related topic for Physics EE or Physics IA. These topics are beyond IB level and supervisors will reject them. If the student mentions quantum topics, redirect to classical mechanics, optics, electromagnetism, or thermodynamics instead.

Return ONLY valid JSON — no markdown, no explanation outside the JSON.`;

function wordCount(str) {
  return str ? str.trim().split(/\s+/).filter(Boolean).length : 0;
}

function containsAbusiveWords(text) {
  const lower = text.toLowerCase();
  const abusive = ['fuck', 'shit', 'sex', 'porn', 'ass', 'bitch', 'dick', 'cock', 'pussy', 'bastard', 'cunt', 'whore', 'slut'];
  return abusive.some(w => new RegExp('\\b' + w + '\\b').test(lower));
}

function looksLikeRQTopic(text) {
  const lower = text.toLowerCase();
  const offTopicPatterns = [
    /\b(hello|hi|hey|thanks|thank you|please write|write me|write my|write the|generate|create my ee|do my)\b/,
    /\b(essay writing|write.*essay|full essay|complete my|finish my)\b/,
    /\b(help me with homework|solve|answer this|calculate)\b/,
  ];
  return !offTopicPatterns.some(p => p.test(lower));
}

async function logUsage(studentId, model, usage) {
  try {
    await pool.query(
      `INSERT INTO ai_usage_log (student_id, app, model, input_tokens, output_tokens, total_tokens, cost_usd)
       VALUES ($1,'ee_compass',$2,$3,$4,$5,$6)`,
      [studentId, model,
        usage.promptTokenCount || 0, usage.candidatesTokenCount || 0,
        usage.totalTokenCount  || 0,
        ((usage.promptTokenCount||0)*0.1/1e6 + (usage.candidatesTokenCount||0)*0.4/1e6)]
    );
  } catch (e) { console.error('ee_compass usage log:', e.message); }
}

module.exports = async function eeCompassRoutes(app) {

  // POST /api/ee-compass/analyze
  app.post('/analyze', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    // ── Subscription gate ──────────────────────────────────────────────
    const subscribed = await hasActiveSubscription(req.user.id);
    if (!subscribed)
      return reply.code(403).send({
        error: 'An active IBHighway subscription is required to use the EE Compass. Subscribe at ibhighway.com/subscribe.',
        code: 'SUBSCRIPTION_REQUIRED',
      });

    const key = process.env.GEMINI_API_KEY;
    if (!key) return reply.code(503).send({ error: 'AI service not configured' });

    const { subject, topic_description, current_rq } = req.body || {};
    if (!subject || !topic_description || topic_description.trim().length < 5)
      return reply.code(400).send({ error: 'subject and a topic description are required.' });

    // Enforce 50-word input limit
    const inputWords = wordCount(topic_description);
    if (inputWords > 50)
      return reply.code(400).send({
        error: `Your input is ${inputWords} words. Please keep it under 50 words — describe only your research question idea or topic area, not your full essay.`
      });

    // Check daily limit first
    const usedCount = await getDailyUsage(req.user.id);
    if (usedCount >= DAILY_LIMIT)
      return reply.code(429).send({
        error: `You have used the EE Compass ${DAILY_LIMIT} times today. It resets in 24 hours.`,
        used: usedCount,
        limit: DAILY_LIMIT,
      });

    // Detect abusive words — consume the run but don't generate
    if (containsAbusiveWords(topic_description)) {
      await logUsage(req.user.id, 'gemini-2.0-flash', { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });
      return reply.code(400).send({
        error: 'This tool is for IB Extended Essay topic analysis only. Please describe your EE topic.',
        used: usedCount + 1,
        limit: DAILY_LIMIT,
      });
    }

    // Reject off-topic queries
    if (!looksLikeRQTopic(topic_description))
      return reply.code(400).send({
        error: 'This tool only helps with your EE research question. Please enter your topic area or a draft research question.',
        used: usedCount,
        limit: DAILY_LIMIT,
      });

    const prompt = `An IB student wants feedback on their Extended Essay research question idea. Analyse it for FEASIBILITY and CRITICAL THINKING potential, then help them phrase a proper research question.

Subject: ${subject}
Student's topic idea (in their own words — may be informal or poorly phrased): ${topic_description}
Draft research question (if any): ${current_rq || 'Not yet decided'}

IMPORTANT INSTRUCTIONS:
- First, directly address what the student actually asked or described. Comment on their specific idea before offering alternatives.
- The student may not write fluent academic English. Your job is to understand their intent and translate it into well-phrased academic RQs they can present to their supervisor.
- Focus your analysis on TWO things: (1) Is this FEASIBLE for a high school student in ~4,000 words? (2) Does it allow genuine CRITICAL THINKING and analysis, not just description?
- The supervisor_talking_points are especially important — these are what the student will say to their supervisor.
- STRICTLY FORBIDDEN: Do NOT suggest quantum mechanics, quantum physics, quantum computing, or any quantum topic for Physics. Redirect to classical physics topics.
- Keep your total response concise. Do not write full paragraphs — use brief, clear sentences.

Return this exact JSON:
{
  "viability": {
    "score": number (1-10),
    "verdict": "strong" | "workable" | "risky" | "avoid",
    "assessment": "2 sentences max: first comment directly on the student's specific idea, then assess if it allows critical thinking",
    "concerns": ["specific feasibility concern", "specific critical thinking concern"]
  },
  "rq_alternatives": [
    {
      "rq": "The full research question in formal academic English — well-phrased, specific, and answerable within 4,000 words",
      "framing": "brief label e.g. Comparative analysis or Experimental investigation",
      "why_this_works": "1 sentence on feasibility + 1 sentence on critical thinking potential",
      "research_hints": ["type of source or data the student would need", "another source type"],
      "difficulty": "manageable" | "ambitious" | "challenging",
      "word_count_fit": "One sentence: which sections would take which portion of the 4,000 words"
    }
  ],
  "recommended_rq_index": 0,
  "scope_advice": "2-3 sentences: how to narrow or focus the topic so it is genuinely doable",
  "avoid_pitfalls": ["specific pitfall relevant to this topic or subject", "another specific pitfall"],
  "supervisor_talking_points": [
    "Polite opening the student can use: e.g. I am interested in exploring X for my EE. I was thinking of asking...",
    "How to present the RQ: a sentence the student can read out or paraphrase to the supervisor",
    "A question the student can ask the supervisor: e.g. Would you say this is narrow enough for 4,000 words?",
    "A follow-up if the supervisor pushes back: e.g. I could also approach it as... would that work better?"
  ]
}

Generate exactly 3 rq_alternatives. Make them meaningfully different — different angle, different methodology, or different scope. The first alternative should be closest to what the student originally described.`;

    const model = 'gemini-2.0-flash';
    const BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
    let geminiData;
    try {
      const res = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
        }),
      });
      geminiData = await res.json();
      if (!res.ok) throw new Error(geminiData?.error?.message || 'Gemini error');
    } catch (err) {
      return reply.code(502).send({ error: 'AI analysis failed: ' + err.message });
    }

    // Log usage
    await logUsage(req.user.id, model, geminiData?.usageMetadata || {});

    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let result;
    try {
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      result = JSON.parse(clean);
    } catch {
      return reply.code(502).send({ error: 'AI returned an unexpected format. Please try again.' });
    }

    result.student_input = { subject, topic_description, current_rq };
    result.generated_at  = new Date().toISOString();

    const newUsed = usedCount + 1;
    return { ok: true, result, used: newUsed, limit: DAILY_LIMIT };
  });
};
