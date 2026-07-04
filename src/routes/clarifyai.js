'use strict';

/**
 * ClarifyAI routes — personal AI study companion (Tier 2)
 * Prefix: /api/clarifyai   (register in server.js with bodyLimit for base64 uploads)
 *
 *   app.register(require('./routes/clarifyai'), { prefix: '/api/clarifyai', bodyLimit: 20 * 1024 * 1024 });
 *
 * Rules honoured (platform conventions):
 *   - ALL prompts live in this file. Nothing prompt-related ships to the browser.
 *   - Gemini key arrives ONLY via the X-Gemini-Key header. Missing/empty → HTTP 400.
 *   - process.env.GEMINI_API_KEY is NEVER used as a fallback. Hard rule.
 *   - No database — ClarifyAI stores nothing server-side. Session history is
 *     kept in the student's browser (localStorage).
 *   - Auth: platform JWT accepted via Authorization: Bearer. Currently SOFT
 *     (requests without a valid token still work) so the tool cannot break on
 *     portal-token wiring. Flip REQUIRE_AUTH to true once the portal token
 *     name is confirmed, to enforce Tier 2 gating.
 */

const REQUIRE_AUTH = false; // ← flip to true to enforce portal login on every route

// ── Model allowlist (must match the frontend picker) ─────────────────────────
const ALLOWED_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
];
const DEFAULT_MODEL = 'gemini-2.5-flash';

// ── Input caps ────────────────────────────────────────────────────────────────
const MAX_QUESTION_CHARS = 2000;
const MAX_CONTEXT_CHARS  = 120000; // ~30k tokens of lecture context
const MAX_SUBJECT_CHARS  = 120;
const MAX_TOPICS         = 12;
const MAX_QA_PAIRS       = 60;

// ── Curriculum configuration (server-side only) ──────────────────────────────
const CURRICULA = {
  'IB DP': {
    answerStyle:
      'Frame the answer using IB DP command terms where natural (define, state, outline, describe, explain, discuss, evaluate, derive). Match depth to IB DP standard. Where relevant, mention which command term the question maps to and the assessment objective level (AO1 recall, AO2 application, AO3 analysis/evaluation).',
    topicStyle:
      'Tag the topic using IB DP syllabus phrasing (e.g. "Physics B.3 — Gas laws", "Biology D2 — Cell division") when identifiable, otherwise a short topic name.',
    quizStyle:
      'Write questions in IB DP Paper-1 multiple-choice style: concise stem, plausible distractors based on common misconceptions, no trick wording, one unambiguous best answer.',
  },
  'IB MYP': {
    answerStyle:
      'Frame the answer for an IB MYP student: clear, concept-first explanations tied to MYP command terms (define, describe, explain, analyse, evaluate) and criterion-style thinking. Keep language accessible for ages 11–16.',
    topicStyle: 'Tag the topic with the MYP unit/concept name (e.g. "Sciences — Forces and energy").',
    quizStyle:
      'Write clear multiple-choice questions at MYP level: single-concept stems, age-appropriate vocabulary, distractors reflecting common student errors.',
  },
  'CBSE': {
    answerStyle:
      'Frame the answer in CBSE/NCERT style: precise definitions as given in NCERT textbooks, stepwise working for numericals, and phrasing aligned with CBSE board-exam answer conventions (mention marks-worthy points explicitly).',
    topicStyle: 'Tag the topic with the NCERT chapter/unit name (e.g. "Class 12 Physics — Ch. 2 Electrostatic Potential").',
    quizStyle:
      'Write questions in CBSE board style, mixing straight MCQs and assertion-reason format (clearly labelled) where it suits the concept. Use NCERT terminology.',
  },
  'ICSE': {
    answerStyle:
      'Frame the answer in ICSE style: thorough, definition-driven explanations with correct technical vocabulary and stepwise numerical working, matching ICSE answer conventions.',
    topicStyle: 'Tag the topic with the ICSE chapter/section name.',
    quizStyle: 'Write precise multiple-choice questions in ICSE style with technically exact options.',
  },
  'IGCSE': {
    answerStyle:
      'Frame the answer using Cambridge IGCSE command words (state, describe, explain, suggest, calculate, evaluate) and the depth expected at IGCSE Extended level unless the question implies Core.',
    topicStyle: 'Tag the topic with the IGCSE syllabus section (e.g. "0625 Physics — 2.2 Thermal properties").',
    quizStyle:
      'Write questions in Cambridge IGCSE Paper 2 multiple-choice style: clear stems, four options, distractors from common errors.',
  },
  'AS/A Levels': {
    answerStyle:
      'Frame the answer using Cambridge/Edexcel A-Level command words and A-Level depth: precise definitions, quantitative rigour, and mark-point style phrasing where helpful.',
    topicStyle: 'Tag the topic with the A-Level syllabus section name.',
    quizStyle:
      'Write questions in A-Level multiple-choice style (e.g. CIE Paper 1): demanding stems, quantitatively plausible distractors.',
  },
  'AQA': {
    answerStyle:
      'Frame the answer using AQA command words (define, describe, explain, compare, evaluate) and reference AQA assessment objectives (AO1/AO2/AO3) where natural. Use mark-scheme style phrasing for key points.',
    topicStyle: 'Tag the topic with the AQA specification section name.',
    quizStyle: 'Write questions in AQA multiple-choice style with specification-accurate terminology.',
  },
  'Other': {
    answerStyle:
      'Frame the answer as a clear, rigorous teaching explanation appropriate to the student\'s level, with definitions first and worked reasoning after.',
    topicStyle: 'Tag the topic with a short descriptive topic name.',
    quizStyle: 'Write clear, fair multiple-choice questions testing understanding rather than trivia.',
  },
};

const curriculumFor = (name) => CURRICULA[name] || CURRICULA['Other'];

// ── Gemini helper ─────────────────────────────────────────────────────────────
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

function friendlyGeminiError(status, apiMessage) {
  if (status === 429)
    return 'Gemini free-tier quota reached for this model. Switch to Gemini 2.5 Flash Lite in Settings, or wait a minute and try again.';
  if (status === 400 && /api key/i.test(apiMessage || ''))
    return 'Your Gemini API key looks invalid. Re-check it in Settings (aistudio.google.com/apikey).';
  if (status === 403)
    return 'Gemini rejected your API key (invalid or restricted). Re-check it in Settings.';
  if (status === 404)
    return 'This Gemini model is not available for your key. Pick a different model in Settings.';
  if (status === 503)
    return 'Gemini is overloaded right now. Try again in a few seconds.';
  return apiMessage || 'Gemini request failed. Please try again.';
}

async function callGemini(key, model, parts, generationConfig) {
  let res;
  try {
    res = await fetch(GEMINI_URL(model, key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig,
      }),
    });
  } catch (netErr) {
    const err = new Error('Could not reach Gemini (network issue). Please try again in a moment.');
    err.statusCode = 502;
    throw err;
  }
  if (!res.ok) {
    let msg = '';
    try { const e = await res.json(); msg = e?.error?.message || ''; } catch (_) {}
    const err = new Error(friendlyGeminiError(res.status, msg));
    err.statusCode = res.status === 429 ? 429 : 502;
    if (res.status === 400 || res.status === 403 || res.status === 404) err.statusCode = 400;
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason;
    const err = new Error(
      reason === 'SAFETY'
        ? 'Gemini declined to answer this (safety filter). Try rephrasing.'
        : 'Gemini returned an empty response. Please try again.'
    );
    err.statusCode = 502;
    throw err;
  }
  return text;
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (_) {}
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch (_) {} }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  return null;
}

// ── Request helpers ───────────────────────────────────────────────────────────
function getGeminiKey(request, reply) {
  const key = (request.headers['x-gemini-key'] || '').trim();
  if (!key) {
    reply.code(400).send({ error: 'Gemini API key missing. Add your key in Settings.' });
    return null;
  }
  return key; // NEVER fall back to process.env.GEMINI_API_KEY
}

function getModel(body) {
  const m = (body && body.model) || DEFAULT_MODEL;
  return ALLOWED_MODELS.includes(m) ? m : DEFAULT_MODEL;
}

function softAuth(request) {
  // Verifies the platform JWT when present. Soft by default (see REQUIRE_AUTH).
  try {
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const payload = request.server.jwt.verify(token);
    return payload.sub ?? null;
  } catch (_) {
    return null;
  }
}

function gate(request, reply) {
  const uid = softAuth(request);
  if (REQUIRE_AUTH && uid == null) {
    reply.code(401).send({ error: 'Please log in to the IBHighway portal to use ClarifyAI.' });
    return false;
  }
  return true;
}

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

function sendError(reply, err) {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  reply.code(status).send({ error: err.message || 'Request failed' });
}

// ── Prompt builders (server-side only) ────────────────────────────────────────
const PROMPTS = {
  contextPdf: () =>
    `This is a lecture document. Extract ALL educational content, thoroughly and faithfully:

## MAIN TOPIC
What is this document about?

## KEY CONCEPTS
Every definition, theory and idea, each with a short explanation.

## FORMULAS & EXAMPLES
All formulas (in LaTeX where applicable), worked examples, case studies, key facts.

## STRUCTURE
How the topics flow and connect.

Be exhaustive — a student will ask questions and take a quiz based ONLY on what you extract.`,

  contextImage: () =>
    `This is a photo of a whiteboard, slide, or textbook page from a lecture. Extract EVERYTHING legible:
- All text, verbatim where possible
- All equations and formulas (write them in LaTeX)
- Describe every diagram/graph and what it shows
- Note anything partially legible with your best reading marked [?]

Organise the output under ## headings by content area. Be exhaustive — this becomes the student's lecture context.`,

  contextYoutube: () =>
    `This is a lecture video. Extract and structure ALL educational content:

## MAIN TOPIC
What is this lecture about?

## KEY CONCEPTS
All definitions, theories, and ideas with explanations.

## IMPORTANT DETAILS
Formulas (in LaTeX), examples, case studies, facts.

## LECTURE STRUCTURE
How topics flow and connect.

Be thorough — a student will use this to ask questions and take a quiz.`,

  ask: ({ question, context, curriculum, subject, cfg }) =>
    `You are ClarifyAI, an expert ${subject || 'subject'} tutor for a student following the ${curriculum} curriculum.

LECTURE CONTEXT (may be empty):
"""
${context || '(no lecture context provided)'}
"""

The student asked (raw, possibly informal or spoken): "${question}"

Do BOTH of the following:
1. Refine the raw question into one precise academic question.
2. Answer it in 3–5 sentences. ${cfg.answerStyle}
   - Prefer the lecture context above when it covers the question; if the context does not cover it, answer from general knowledge and say so honestly.
   - Use LaTeX ($...$ inline, $$...$$ display) for any mathematics.
3. ${cfg.topicStyle}

Return ONLY valid JSON, no markdown fences:
{"refined":"the refined question","answer":"the 3-5 sentence answer (markdown + LaTeX allowed)","grounded":true|false,"topic":"short topic tag"}

"grounded" must be true ONLY if the answer is substantially based on the lecture context provided.`,

  summary: ({ context, qaList, curriculum, subject, cfg }) =>
    `Generate a structured study summary for a ${curriculum} ${subject || ''} student.

LECTURE CONTEXT:
"""
${context || 'Not provided'}
"""

STUDENT'S Q&A THIS SESSION:
${qaList || 'None'}

${cfg.answerStyle}

Format exactly:
## Lecture Summary
(2–3 paragraph overview)

## Key Takeaways
- bullet points (use LaTeX for any maths)

## Topics Needing Attention
(based on what the student asked — what they seem unsure about)`,

  quiz: ({ context, questionList, curriculum, subject, cfg, count }) =>
    `You are an exam-prep quiz generator for the ${curriculum} curriculum. Output ONLY valid JSON — no explanation, no markdown, no code fences.

SUBJECT: ${subject || 'the subject of the lecture context'}
${cfg.quizStyle}

Generate exactly ${count} multiple-choice questions based on this lecture.

LECTURE NOTES:
"""
${context || 'Use the subject above as context'}
"""

STUDENT QUESTIONS THIS SESSION (bias the quiz toward these areas):
${questionList || 'General comprehension'}

Output format — a raw JSON array, nothing else:
[{"question":"full question text","options":["...","...","...","..."],"answer":"FULL text of the correct option","topic":"short topic","explanation":"1-2 sentence explanation of the correct answer"}]

Rules:
- ALL questions strictly about ${subject || 'the lecture subject'} — never about programming or unrelated fields
- "answer" must exactly equal one of the four options
- Each question under 30 words; each option under 15 words
- Use LaTeX ($...$) for mathematics in questions and options where needed`,

  weakQuiz: ({ context, topics, curriculum, subject, cfg, count }) =>
    `You are an exam-prep quiz generator for the ${curriculum} curriculum. Output ONLY valid JSON — no explanation, no markdown, no code fences.

SUBJECT: ${subject || 'the subject of the lecture context'}
${cfg.quizStyle}

The student got questions WRONG on these topics: ${topics.join(', ')}
Generate exactly ${count} multiple-choice questions targeting ONLY these weak topics, slightly easier and more fundamental than exam level, to rebuild understanding.

LECTURE NOTES:
"""
${context || 'Use the subject above as context'}
"""

Output format — a raw JSON array, nothing else:
[{"question":"full question text","options":["...","...","...","..."],"answer":"FULL text of the correct option","topic":"topic name","explanation":"1-2 sentence explanation"}]

Rules:
- ALL questions strictly about ${subject || 'the lecture subject'}
- "answer" must exactly equal one of the four options
- Each question under 30 words; each option under 15 words
- Use LaTeX ($...$) for mathematics where needed`,

  flashcards: ({ context, qaList, curriculum, subject, cfg }) =>
    `Generate exactly 15 flashcards for spaced repetition for a ${curriculum} ${subject || ''} student. Output ONLY a valid JSON array — no markdown, no fences.

LECTURE CONTEXT:
"""
${context || 'Not provided'}
"""

STUDENT Q&A THIS SESSION:
${qaList || 'None'}

${cfg.topicStyle}

Format:
[{"front":"question or term","back":"answer or definition (LaTeX allowed)","topic":"category"}]

Mix definitions, applications, and conceptual questions. Fronts under 20 words; backs under 40 words.`,
};

const JSON_GEN = { temperature: 0.4, maxOutputTokens: 4096, response_mime_type: 'application/json' };
const TEXT_GEN = { temperature: 0.7, maxOutputTokens: 4096 };
const EXTRACT_GEN = { temperature: 0.3, maxOutputTokens: 8192 };

// ── Plugin ────────────────────────────────────────────────────────────────────
module.exports = async function clarifyai(fastify) {

  const rl = (max, timeWindow) => ({ config: { rateLimit: { max, timeWindow } } });

  // GET /api/clarifyai/health — deploy sanity check
  fastify.get('/health', async () => ({ tool: 'clarifyai', status: 'ok', time: new Date() }));

  // POST /context/pdf  { pdfBase64, model }
  fastify.post('/context/pdf', rl(10, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const { pdfBase64 } = request.body || {};
    if (!pdfBase64 || typeof pdfBase64 !== 'string')
      return reply.code(400).send({ error: 'pdfBase64 required' });
    try {
      const text = await callGemini(key, getModel(request.body), [
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
        { text: PROMPTS.contextPdf() },
      ], EXTRACT_GEN);
      return { context: text };
    } catch (err) { return sendError(reply, err); }
  });

  // POST /context/image  { imageBase64, mimeType, model }
  fastify.post('/context/image', rl(15, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const { imageBase64, mimeType } = request.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string')
      return reply.code(400).send({ error: 'imageBase64 required' });
    const mt = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(mimeType) ? mimeType : 'image/jpeg';
    try {
      const text = await callGemini(key, getModel(request.body), [
        { inline_data: { mime_type: mt, data: imageBase64 } },
        { text: PROMPTS.contextImage() },
      ], EXTRACT_GEN);
      return { context: text };
    } catch (err) { return sendError(reply, err); }
  });

  // POST /context/youtube  { youtubeUrl, model }
  fastify.post('/context/youtube', rl(6, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const { youtubeUrl } = request.body || {};
    if (!youtubeUrl || !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(youtubeUrl))
      return reply.code(400).send({ error: 'A valid YouTube URL is required' });
    try {
      const text = await callGemini(key, getModel(request.body), [
        { fileData: { fileUri: youtubeUrl } },
        { text: PROMPTS.contextYoutube() },
      ], EXTRACT_GEN);
      return { context: text };
    } catch (err) { return sendError(reply, err); }
  });

  // POST /ask  { question, context, curriculum, subject, model }
  fastify.post('/ask', rl(15, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const b = request.body || {};
    const question = clip((b.question || '').trim(), MAX_QUESTION_CHARS);
    if (!question) return reply.code(400).send({ error: 'question required' });
    const curriculum = CURRICULA[b.curriculum] ? b.curriculum : 'Other';
    const cfg = curriculumFor(curriculum);
    try {
      const text = await callGemini(key, getModel(b), [{
        text: PROMPTS.ask({
          question,
          context: clip(b.context, MAX_CONTEXT_CHARS),
          curriculum,
          subject: clip(b.subject, MAX_SUBJECT_CHARS),
          cfg,
        }),
      }], JSON_GEN);
      const parsed = parseJsonLoose(text);
      if (!parsed || !parsed.answer)
        return reply.code(502).send({ error: 'Gemini returned an unexpected format. Please try again.' });
      return {
        refined: String(parsed.refined || question),
        answer: String(parsed.answer),
        grounded: parsed.grounded === true,
        topic: String(parsed.topic || 'General'),
      };
    } catch (err) { return sendError(reply, err); }
  });

  // POST /summary  { context, questions:[{question,answer}], curriculum, subject, model }
  fastify.post('/summary', rl(6, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const b = request.body || {};
    const curriculum = CURRICULA[b.curriculum] ? b.curriculum : 'Other';
    const qaList = (Array.isArray(b.questions) ? b.questions : []).slice(0, MAX_QA_PAIRS)
      .map((q, i) => `${i + 1}. Q: ${clip(q.question, 500)}\n   A: ${clip(q.answer, 1200)}`).join('\n\n');
    try {
      const text = await callGemini(key, getModel(b), [{
        text: PROMPTS.summary({
          context: clip(b.context, MAX_CONTEXT_CHARS),
          qaList, curriculum,
          subject: clip(b.subject, MAX_SUBJECT_CHARS),
          cfg: curriculumFor(curriculum),
        }),
      }], TEXT_GEN);
      return { summary: text };
    } catch (err) { return sendError(reply, err); }
  });

  // Shared quiz validation
  function validQuizArray(parsed, count) {
    if (!Array.isArray(parsed)) return null;
    const items = parsed.filter(q =>
      q && typeof q.question === 'string' &&
      Array.isArray(q.options) && q.options.length === 4 &&
      typeof q.answer === 'string' && q.options.includes(q.answer)
    ).slice(0, count);
    return items.length >= Math.min(3, count) ? items.map(q => ({
      question: q.question, options: q.options, answer: q.answer,
      topic: String(q.topic || 'General'), explanation: String(q.explanation || ''),
    })) : null;
  }

  // POST /quiz  { context, questions:[...], curriculum, subject, model, count? }
  fastify.post('/quiz', rl(6, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const b = request.body || {};
    const curriculum = CURRICULA[b.curriculum] ? b.curriculum : 'Other';
    const count = b.count === 10 ? 10 : 5;
    const questionList = (Array.isArray(b.questions) ? b.questions : []).slice(0, 10)
      .map((q, i) => `${i + 1}. ${clip(typeof q === 'string' ? q : q.question, 300)}`).join('\n');
    try {
      const text = await callGemini(key, getModel(b), [{
        text: PROMPTS.quiz({
          context: clip(b.context, MAX_CONTEXT_CHARS),
          questionList, curriculum,
          subject: clip(b.subject, MAX_SUBJECT_CHARS),
          cfg: curriculumFor(curriculum), count,
        }),
      }], JSON_GEN);
      const quiz = validQuizArray(parseJsonLoose(text), count);
      if (!quiz) return reply.code(502).send({ error: 'Could not generate a valid quiz — please try again.' });
      return { quiz };
    } catch (err) { return sendError(reply, err); }
  });

  // POST /quiz/weak  { context, topics:[...], curriculum, subject, model, count? }
  fastify.post('/quiz/weak', rl(6, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const b = request.body || {};
    const topics = (Array.isArray(b.topics) ? b.topics : []).slice(0, MAX_TOPICS)
      .map(t => clip(String(t), 80)).filter(Boolean);
    if (!topics.length) return reply.code(400).send({ error: 'topics required' });
    const curriculum = CURRICULA[b.curriculum] ? b.curriculum : 'Other';
    const count = b.count === 10 ? 10 : 5;
    try {
      const text = await callGemini(key, getModel(b), [{
        text: PROMPTS.weakQuiz({
          context: clip(b.context, MAX_CONTEXT_CHARS),
          topics, curriculum,
          subject: clip(b.subject, MAX_SUBJECT_CHARS),
          cfg: curriculumFor(curriculum), count,
        }),
      }], JSON_GEN);
      const quiz = validQuizArray(parseJsonLoose(text), count);
      if (!quiz) return reply.code(502).send({ error: 'Could not generate a valid drill quiz — please try again.' });
      return { quiz };
    } catch (err) { return sendError(reply, err); }
  });

  // POST /flashcards  { context, questions:[{question,answer}], curriculum, subject, model }
  fastify.post('/flashcards', rl(6, '1 minute'), async (request, reply) => {
    if (!gate(request, reply)) return;
    const key = getGeminiKey(request, reply); if (!key) return;
    const b = request.body || {};
    const curriculum = CURRICULA[b.curriculum] ? b.curriculum : 'Other';
    const qaList = (Array.isArray(b.questions) ? b.questions : []).slice(0, MAX_QA_PAIRS)
      .map(q => `Q: ${clip(q.question, 400)}\nA: ${clip(q.answer, 800)}`).join('\n\n');
    try {
      const text = await callGemini(key, getModel(b), [{
        text: PROMPTS.flashcards({
          context: clip(b.context, MAX_CONTEXT_CHARS),
          qaList, curriculum,
          subject: clip(b.subject, MAX_SUBJECT_CHARS),
          cfg: curriculumFor(curriculum),
        }),
      }], JSON_GEN);
      const parsed = parseJsonLoose(text);
      const cards = (Array.isArray(parsed) ? parsed : []).filter(c =>
        c && typeof c.front === 'string' && typeof c.back === 'string'
      ).slice(0, 15).map(c => ({ front: c.front, back: c.back, topic: String(c.topic || 'General') }));
      if (cards.length < 5)
        return reply.code(500).send({ error: 'Not enough flashcards generated. Please try again.' });
      return reply.send({ cards });
    } catch (err) { return sendError(reply, err); }
  });

}; // end clarifyai plugin
