const pool = require('../db');

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

// Subject → rubric criteria mapping
const RUBRICS = {
  sciences: {
    label: 'IB Sciences (Physics / Chemistry / Biology / ESS)',
    total: 24,
    criteria: [
      { key: 'pe',   name: 'Personal Engagement',       max: 2,  description: 'Shows personal interest, initiative, and independent thinking beyond the prescribed curriculum.' },
      { key: 'exp',  name: 'Exploration',                max: 6,  description: 'Background theory, research question clarity, methodology, variables, controls, safety, and ethical considerations.' },
      { key: 'ana',  name: 'Analysis',                   max: 6,  description: 'Data presentation, processing, graphing, uncertainty propagation, and interpretation of results.' },
      { key: 'eval', name: 'Evaluation',                 max: 6,  description: 'Conclusion validity, evaluation of method weaknesses, realistic improvements.' },
      { key: 'comm', name: 'Communication',              max: 4,  description: 'Report structure, citations, terminology, coherence, and length compliance.' },
    ],
  },
  economics: {
    label: 'IB Economics',
    total: 15,
    criteria: [
      { key: 'diag',  name: 'Diagrams',                  max: 3, description: 'Correct, labelled, and well-integrated economic diagrams.' },
      { key: 'term',  name: 'Terminology',               max: 3, description: 'Accurate use of economic concepts and vocabulary.' },
      { key: 'app',   name: 'Application',               max: 3, description: 'Relevant and accurate application of theory to the real-world article.' },
      { key: 'ana',   name: 'Analysis',                  max: 3, description: 'Logical chains of reasoning with cause-and-effect.' },
      { key: 'eval',  name: 'Evaluation',                max: 3, description: 'Balanced, substantiated judgements with real-world examples.' },
    ],
  },
  maths: {
    label: 'IB Mathematics (AA / AI)',
    total: 20,
    criteria: [
      { key: 'pres',  name: 'Presentation',              max: 4, description: 'Introduction, rationale, structure, and mathematical communication.' },
      { key: 'mcomm', name: 'Mathematical Communication',max: 4, description: 'Appropriate notation, definitions, and mathematical vocabulary.' },
      { key: 'pe',    name: 'Personal Engagement',       max: 3, description: 'Authenticity, initiative, and personal interest in the topic.' },
      { key: 'ref',   name: 'Reflection',                max: 3, description: 'Critical reflection on results, limitations, and possible extensions.' },
      { key: 'use',   name: 'Use of Mathematics',        max: 6, description: 'Correct, relevant, and sophisticated use of mathematics at the appropriate level.' },
    ],
  },
  history: {
    label: 'IB History',
    total: 25,
    criteria: [
      { key: 'src',   name: 'Identification and Evaluation of Sources', max: 6, description: 'Selecting and evaluating two relevant sources for origin, purpose, value, and limitation.' },
      { key: 'inv',   name: 'Investigation',             max: 15, description: 'Depth of knowledge, use of evidence, and quality of argument.' },
      { key: 'ref',   name: 'Reflection',                max: 4, description: 'Reflective discussion on the challenges historians face with the topic.' },
    ],
  },
  general: {
    label: 'Other / General',
    total: 20,
    criteria: [
      { key: 'focus',  name: 'Focus and Rationale',      max: 4, description: 'Clear, specific topic with well-defined aim and personal rationale.' },
      { key: 'method', name: 'Methodology',              max: 4, description: 'Appropriate and detailed method for achieving the stated aim.' },
      { key: 'know',   name: 'Knowledge and Analysis',   max: 6, description: 'Subject-specific knowledge applied correctly to analyse the topic.' },
      { key: 'eval',   name: 'Evaluation',               max: 4, description: 'Critical judgement on findings, limitations, and implications.' },
      { key: 'comm',   name: 'Communication',            max: 2, description: 'Structure, language, referencing, and formal presentation.' },
    ],
  },
};

function detectRubric(subject) {
  const s = (subject || '').toLowerCase();
  if (s.includes('physics') || s.includes('chemistry') || s.includes('biology') || s.includes('ess') || s.includes('design')) return 'sciences';
  if (s.includes('economics')) return 'economics';
  if (s.includes('math')) return 'maths';
  if (s.includes('history')) return 'history';
  return 'general';
}

const DAILY_LIMIT = 5;

async function checkDailyLimit(studentId, tool) {
  const res = await pool.query(
    `SELECT COUNT(*) FROM ai_usage_log
     WHERE student_id=$1 AND app=$2 AND created_at >= NOW() - INTERVAL '24 hours'`,
    [studentId, tool]
  );
  return parseInt(res.rows[0].count) >= DAILY_LIMIT;
}

module.exports = async function iaAutopsyRoutes(app) {

  // POST /api/ia-autopsy/analyze
  app.post('/analyze', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    // ── Subscription gate ──────────────────────────────────────────────
    const subscribed = await hasActiveSubscription(req.user.id);
    if (!subscribed)
      return reply.code(403).send({
        error: 'An active IBHighway subscription is required to use the IA Autopsy Room. Subscribe at ibhighway.com/subscribe.',
        code: 'SUBSCRIPTION_REQUIRED',
      });

    const key = process.env.GEMINI_API_KEY;
    if (!key) return reply.code(503).send({ error: 'AI service not configured' });

    const { draft_text, subject } = req.body || {};
    if (!draft_text || draft_text.trim().length < 100)
      return reply.code(400).send({ error: 'Please provide your IA draft text (minimum 100 characters).' });
    if (draft_text.length > 50000)
      return reply.code(400).send({ error: 'Draft text too long (max 50,000 characters). Please paste the most relevant sections.' });

    const limited = await checkDailyLimit(req.user.id, 'ia_autopsy');
    if (limited) return reply.code(429).send({ error: `You have used the IA Autopsy Room ${DAILY_LIMIT} times today. Limit resets in 24 hours.` });

    const rubricKey = detectRubric(subject);
    const rubric    = RUBRICS[rubricKey];

    const criteriaText = rubric.criteria.map(c =>
      `- ${c.name} (max ${c.max} marks): ${c.description}`
    ).join('\n');

    const systemPrompt = `You are an experienced IB examiner and IA specialist. Analyse the student's IA draft against the official IB rubric and return ONLY a valid JSON object — no markdown, no explanation, just raw JSON.`;

    const userPrompt = `Subject area: ${subject || 'Not specified'} (using ${rubric.label} rubric)

Rubric criteria:
${criteriaText}
Total marks: ${rubric.total}

Student's IA draft:
---
${draft_text}
---

Return this exact JSON structure:
{
  "subject_detected": "string",
  "rubric_used": "string",
  "total_marks": number,
  "overall_estimate": { "min": number, "max": number },
  "overall_feedback": "2-3 sentences on the overall standard",
  "strengths": ["string", "string"],
  "major_concerns": ["string", "string"],
  "top_priority_fix": "single most impactful thing to fix right now",
  "criteria": [
    {
      "key": "criterion key",
      "name": "criterion name",
      "max_marks": number,
      "score_estimate": { "min": number, "max": number },
      "evidence_quote": "exact quote from draft that most influences this score (max 80 words)",
      "examiner_comment": "what an examiner would think reading this section (2-3 sentences)",
      "fixes": [
        { "description": "specific actionable fix", "complexity": "quick" or "structural", "priority": 1 }
      ],
      "session_recommended": true or false
    }
  ]
}`;

    const model = 'gemini-2.0-flash';
    const BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
    let geminiData;
    try {
      const res = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        }),
      });
      geminiData = await res.json();
      if (!res.ok) throw new Error(geminiData?.error?.message || 'Gemini error');
    } catch (err) {
      return reply.code(502).send({ error: 'AI analysis failed: ' + err.message });
    }

    // Log token usage
    const usage = geminiData?.usageMetadata || {};
    try {
      await pool.query(
        `INSERT INTO ai_usage_log (student_id, app, model, input_tokens, output_tokens, total_tokens, cost_usd)
         VALUES ($1,'ia_autopsy',$2,$3,$4,$5,$6)`,
        [req.user.id, model,
          usage.promptTokenCount || 0, usage.candidatesTokenCount || 0,
          usage.totalTokenCount  || 0,
          ((usage.promptTokenCount||0)*0.1/1e6 + (usage.candidatesTokenCount||0)*0.4/1e6)]
      );
    } catch (e) { console.error('ia_autopsy usage log:', e.message); }

    // Parse JSON from Gemini response
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let analysis;
    try {
      const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(clean);
    } catch {
      return reply.code(502).send({ error: 'AI returned an unexpected format. Please try again.' });
    }

    return { ok: true, analysis };
  });

  // GET /api/ia-autopsy/rubrics — return available rubrics for dropdown
  app.get('/rubrics', { onRequest: [app.authenticate] }, async () => {
    return Object.entries(RUBRICS).map(([key, r]) => ({
      key, label: r.label, total: r.total,
      criteria: r.criteria.map(c => ({ key: c.key, name: c.name, max: c.max })),
    }));
  });
};
