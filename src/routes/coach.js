// ─── AI COACH ROUTE ──────────────────────────────────────────────────────────
// Prompt lives here on Railway — never sent to the browser.
// Client sends only: subject, level, topic + the student's own Gemini key.

const MODELS = [
  { model: 'gemini-3.5-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-pro',        api: 'v1beta' },
  { model: 'gemini-3.1-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-flash-lite', api: 'v1beta' },
  { model: 'gemini-2.5-pro',        api: 'v1beta' },
  { model: 'gemini-2.5-flash',      api: 'v1beta' },
  { model: 'gemini-2.5-flash-lite', api: 'v1beta' },
];

async function callGemini(geminiKey, prompt, maxTokens = 8192) {
  for (const m of MODELS) {
    const url = `https://generativelanguage.googleapis.com/${m.api}/models/${m.model}:generateContent`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
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

function buildGuidePrompt(topic, subject, level) {
  return `You are an expert IB teacher writing a study guide for a student who wants to learn "${topic}" in IB ${subject} ${level}.

Write a focused, practical study guide with exactly these four sections. Be specific, concise, and IB-accurate. No motivational filler.
IMPORTANT: Do NOT use LaTeX notation. Write all math in plain text (e.g. write "v = u + at" not "$v = u + at$", write "(1/2)at^2" not "\\frac{1}{2}at^2", write "m/s^2" not "\\text{m s}^{-2}").

## 📌 What's in this topic
List every concept and sub-topic the student needs to cover, in the logical order they should study them. One line per item. Group them if there are natural clusters. Be complete — if it's in the IB ${subject} ${level} syllabus, include it.

## 🔧 What you need to know first (prerequisites)
List any mathematics or prior physics/science concepts the student must be comfortable with before starting this topic. Be specific — e.g. "resolving vectors into components using sin/cos" not just "vectors". If there are no significant prerequisites, say so briefly.

## 📚 Where to find good resources
For each resource type below, give specific, actionable pointers:
- **IB Data Booklet / Formula Booklet:** which equations appear and what they mean
- **Textbook:** which chapters/sections to read (use standard IB textbook structure — Tsokos for Physics, Allott & Mindorff for Biology, etc.)
- **Past papers:** which paper (P1/P2/P3), which question types typically test this topic, and what mark scheme language to look for
- **Videos:** describe what to search for (e.g. "search: IB Physics projectile motion Khan Academy" or "IB-specific YouTube channels: Mike Sugiyama, Chris Doner")

## ✅ How to know you've understood it
Do NOT give MCQs or test questions. Instead, describe exactly what the student should be able to do from memory to confirm they have genuinely understood the topic:
- What they should be able to derive or explain without notes
- What types of problems they should be able to set up and solve from scratch (describe the problem type, not specific numbers)
- What IB exam command terms apply to this topic (e.g. "Explain", "Derive", "Calculate", "Sketch") and what a full-mark answer looks like for each
- Any common misconceptions that disappear once the topic is truly understood`;
}

const { requireStudent } = require('../student-auth');

module.exports = async function coachRoutes(app) {
  // POST /api/coach — generate a study guide
  app.post('/', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const student = await requireStudent(req, reply, 1);
    if (!student) return;
    const { subject, level, topic, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !topic) return reply.code(400).send({ error: 'Missing subject or topic' });
    if (String(topic).length > 300) return reply.code(400).send({ error: 'Topic too long' });

    try {
      const prompt = buildGuidePrompt(String(topic), String(subject), level === 'SL' ? 'SL' : 'HL');
      const result = await callGemini(geminiKey, prompt, 8192);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });
};
