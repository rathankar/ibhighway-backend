// ─── MISCONCEPTION ANALYZER ROUTE ────────────────────────────────────────────
// Socratic system prompt lives here on Railway — never sent to the browser.
// Client sends only: the raw chat turns (student belief + replies + model
// responses) and the student's own Gemini key. The system prompt is attached
// server-side via Gemini's systemInstruction field.

const MODELS = [
  { model: 'gemini-3.5-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-pro',        api: 'v1beta' },
  { model: 'gemini-3.1-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-flash-lite', api: 'v1beta' },
  { model: 'gemini-2.5-pro',        api: 'v1beta' },
  { model: 'gemini-2.5-flash',      api: 'v1beta' },
  { model: 'gemini-2.5-flash-lite', api: 'v1beta' },
];

const SYSTEM_PROMPT = `You are an IB tutor using pure Socratic questioning to help a student discover whether their belief is correct or a misconception.

Your rules:
1. Never give the answer directly. Ask one focused question at a time that pushes the student to reason.
2. If the student's belief is CORRECT: acknowledge it clearly, then state the ONE condition under which their correct understanding would break or fail. End the session.
3. If the student's belief is INCORRECT: do NOT say "wrong" harshly. Instead, ask a question that makes the student confront the flaw in their own reasoning. Build toward the correct concept step by step.
4. Keep each response to 2–4 sentences maximum. No long explanations. No bullet lists.
5. Aim to wrap up in 3–5 exchanges. You may go up to 10 if the concept genuinely needs it.
6. When the student has arrived at the correct understanding (or after max exchanges), give a closing summary: one sentence stating the misconception, one sentence stating the correct understanding. Mark this with [WRAP-UP] at the start.
7. When the student's statement is correct from the start, begin your response with [CORRECT].
8. Do not use LaTeX. Write math in plain text.`;

async function callGemini(geminiKey, contents, maxTokens = 1000) {
  for (const m of MODELS) {
    const url = `https://generativelanguage.googleapis.com/${m.api}/models/${m.model}:generateContent?key=${geminiKey}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
        })
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        const msg = (e.error?.message || '').toLowerCase();
        if (msg.includes('not found') || msg.includes('deprecated') || r.status === 404) continue;
        throw new Error(e.error?.message || `HTTP ${r.status}`);
      }
      const d = await r.json();
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;
      return { text, model: m.model };
    } catch (e) {
      if (e.message?.includes('not found') || e.message?.includes('deprecated')) continue;
      throw e;
    }
  }
  throw new Error('No compatible Gemini model found for your API key.');
}

const { requireStudent } = require('../student-auth');

module.exports = async function misconceptionRoutes(app) {
  // POST /api/misconception — one Socratic turn.
  // Body: { history: [{role:'user'|'model', text:string}], wrapUp?: bool, geminiKey }
  // First turn: history = [{role:'user', text:<the belief>}].
  app.post('/', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const student = await requireStudent(req, reply, 1);
    if (!student) return;
    const { history, wrapUp, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!Array.isArray(history) || history.length === 0) {
      return reply.code(400).send({ error: 'history must be a non-empty array' });
    }
    if (history.length > 40) return reply.code(400).send({ error: 'History too long' });

    const contents = history.map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.text || '').slice(0, 4000) }]
    }));
    // First student message is their belief — frame it for the tutor.
    if (contents.length && contents[0].role === 'user') {
      contents[0].parts[0].text =
        `The student says: "${contents[0].parts[0].text}"\n\nRespond with your first Socratic question (or [CORRECT] acknowledgement if their statement is fully correct).`;
    }
    if (wrapUp) {
      contents.push({ role: 'user', parts: [{ text: 'Please give the [WRAP-UP] closing summary now.' }] });
    }

    try {
      const result = await callGemini(geminiKey, contents, 1000);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });
};
