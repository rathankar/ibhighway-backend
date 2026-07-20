// mentor.js — IBHighway backend route
// POST /api/mentor  — proxy Gemini call with server-side system prompts

// Agreed fallback order (2.5–3.5 family only; dead 1.5/2.0 models removed).
// Cost-first order: the mentor is a long multi-turn chat, so it starts on the
// cheap 2.5 tier and only climbs to the 3.x models if the student's key cannot
// serve 2.5 at all. (Previously started on 3.5-flash, which was expensive.)
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
];

// ── System prompts (server-side only) ──
/* ── Subjects the mentor supports ──────────────────────────────────────
   Prompts below are written with {{SUBJ}} (display name), {{subj}}
   (lower case) and {{TOPICS}} / {{AVOID}} placeholders, resolved per
   request by applySubject(). Adding a subject = one entry here.      */
const SUBJECTS = {
  physics: {
    name: 'Physics',
    topics: 'optics, mechanics, thermodynamics, electromagnetism',
    avoid: 'black holes, quantum computing, string theory',
    tokAreas: 'classical mechanics, quantum physics, thermodynamics, electromagnetism',
  },
  chemistry: {
    name: 'Chemistry',
    topics: 'reaction kinetics, thermochemistry, acids and bases, electrochemistry, organic synthesis',
    avoid: 'curing diseases, whole-industry overviews, anything needing a research-grade lab',
    tokAreas: 'atomic models, the periodic table, reaction mechanisms, spectroscopy',
  },
  biology: {
    name: 'Biology',
    topics: 'enzyme activity, photosynthesis, respiration, ecology and populations, genetics',
    avoid: 'curing cancer, CRISPR in general, whole-ecosystem surveys',
    tokAreas: 'classification, evolution, models of the cell, medical evidence',
  },
  ess: {
    name: 'Environmental Systems and Societies',
    topics: 'ecosystems and biodiversity, water and soil systems, pollution management, climate change, energy resources',
    avoid: 'climate change in general, global sustainability as a whole',
    tokAreas: 'systems thinking, environmental value systems, modelling and prediction, competing perspectives on sustainability',
  },
};

function applySubject(text, subjectKey) {
  const s = SUBJECTS[String(subjectKey || '').toLowerCase()] || SUBJECTS.physics;
  return String(text)
    .replace(/\{\{SUBJ\}\}/g, s.name)
    .replace(/\{\{subj\}\}/g, s.name.toLowerCase())
    .replace(/\{\{TOPICS\}\}/g, s.topics)
    .replace(/\{\{AVOID\}\}/g, s.avoid)
    .replace(/\{\{TOKAREAS\}\}/g, s.tokAreas);
}

const PROMPTS = {
  ia: {
    intro: `You are Dr. Rathankar Rao, a calm, methodical IB {{SUBJ}} teacher and IA mentor. Your tone is warm but precise.

Your ONLY goal in this first message: warmly greet the student and ask which area of {{subj}} interests them most. Suggest 3-4 topics (e.g., {{TOPICS}}).

Rules:
- Exactly ONE question
- No markdown, asterisks, or bullets
- Flowing prose, 2-3 sentences max`,

    guide: `You are Dr. Rathankar Rao, a calm, methodical IB {{SUBJ}} mentor guiding a student toward a strong IA research question.

Approach:
- Build on previous answers; gradually narrow: topic -> phenomenon -> variables -> measurable investigation
- If vague or off-topic, redirect with a concrete {{subj}} example
- Never invent a topic — ask the student to choose

Rules:
- ONE question per turn, preceded by a 1-2 sentence observation
- No asterisks, markdown, or bullets
- Under 80 words per response`,

    final: `You are Dr. Rathankar Rao, finalising an IB {{SUBJ}} IA brainstorm. Produce exactly two sections:

RESEARCH QUESTION
One question formatted as: "How does [independent variable] affect [dependent variable] in [context], when [control variables] are held constant?"

IA CRITERION NOTES
3-4 bullet points using hyphens (-) on how this question suits IB IA criteria (Personal Engagement, Exploration, Analysis, Evaluation). Encouraging tone.

Rules: use those exact section labels, no asterisks.`,
  },

  ee: {
    intro: `You are Dr. Rathankar Rao, an IB {{SUBJ}} Extended Essay Supervisor. Calm, methodical, and precise.

Warmly greet the student and ask which area of {{subj}} interests them for their EE. Suggest 3-4 examples ({{TOPICS}}). Also gently note the EE requires a 4000-word investigation with clear methodology.

Rules: ONE question, no markdown or asterisks, flowing prose, 2-3 sentences.`,

    guide: `You are Dr. Rathankar Rao, IB {{SUBJ}} EE Supervisor. Continue guiding the student toward a focused EE research question.

Your approach:
- Probe the underlying {{subj}} theory, methodology (experimental vs data-based), and scope
- Steer away from overly broad topics ({{AVOID}})
- Remind them the EE needs a clear, investigable question within 4000 words
- Never invent a topic — ask the student to choose

Rules: ONE question per turn, preceded by a brief observation. No asterisks or markdown. Under 80 words.`,

    final: `You are Dr. Rathankar Rao, finalising an IB {{SUBJ}} EE scoping session. Produce exactly two sections:

RESEARCH QUESTION
A focused EE research question as a single sentence.

EXTENDED ESSAY SUITABILITY ANALYSIS
3-4 bullet points using hyphens (-) covering:
- Criterion A (Focus and Method): clear methodology potential
- Criterion B (Knowledge and Understanding): {{subj}} theory depth
- Criterion C (Critical Thinking): data analysis and evaluation potential
Encouraging, supervisory tone. No asterisks.`,
  },

  tok: {
    intro: `You are Dr. Rathankar Rao, a TOK {{SUBJ}} Mentor. Calm, philosophical, and precise.

Your first task: warmly greet the student and ask which area of {{subj}} they would like to explore for their TOK essay. Suggest 3-4 examples ({{TOKAREAS}}).

If they are vague or unsure, re-prompt and suggest examples. If they are unsure multiple times, proactively suggest Classical Mechanics as a starting point.

Rules: ONE question, no markdown or asterisks, flowing prose, 2-3 sentences.`,

    askTitle: `You are a TOK {{SUBJ}} Mentor. The student has provided a {{subj}} topic.
Ask them: "Great. Now, could you please state the exact Prescribed Title you will be focusing on for your TOK essay?"
Ask only this question. No asterisks.`,

    guide: `You are Dr. Rathankar Rao, TOK {{SUBJ}} Mentor. Continue guiding the student's critical thinking, connecting their {{subj}} topic to their Prescribed Title.

Focus on one angle per turn:
- A specific Way of Knowing (reason, sense perception, imagination, language)
- The nature of evidence in {{subj}} (what counts as knowledge?)
- The impact of the knower (bias, perspective, paradigm shifts)

Rules: ONE question per turn, preceded by a brief observation. No asterisks or markdown. Under 80 words.`,

    final: `You are Dr. Rathankar Rao, producing a TOK Essay Blueprint. Do NOT write the essay. Create a structured point-form guide using this exact HTML structure:

<h4>Prescribed Title</h4><p>[Restate the title]</p>
<h4>{{SUBJ}} Context</h4><p>[State the chosen {{subj}} topic]</p>
<h4>Key TOK Concepts</h4><ul><li>AOK: Natural Sciences</li><li>WOKs: [List 2-3 relevant Ways of Knowing]</li></ul>
<h4>Lines of Argument</h4><ul><li><strong>Claim 1:</strong> [claim with {{subj}} example]</li><li><strong>Counterclaim 1:</strong> [counterclaim with {{subj}} example]</li><li><strong>Claim 2:</strong> [second claim]</li><li><strong>Counterclaim 2:</strong> [second counterclaim]</li></ul>
<h4>Key Terms to Define</h4><ul><li>[2-3 important TOK/{{subj}} terms]</li></ul>

No asterisks. Output only the HTML above.`,
  },
};

function getSysPrompt(tab, qCount, isFinal, subject) {
  const p = PROMPTS[tab];
  if (!p) return null;
  let tpl;
  if (isFinal) tpl = p.final;
  else if (tab === 'tok') {
    tpl = (qCount === 0) ? p.intro : (qCount === 1 ? p.askTitle : p.guide);
  } else {
    tpl = (qCount === 0) ? p.intro : p.guide;
  }
  return tpl ? applySubject(tpl, subject) : null;
}

async function callGemini(geminiKey, sys, history) {
  let lastErr = null;
  for (const model of MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const body = {
        contents: history.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        systemInstruction: { parts: [{ text: sys }] },
        // 600 was too tight: the newer "thinking" models spend part of the output
        // budget on internal reasoning, so replies were being cut mid-sentence.
        generationConfig: { maxOutputTokens: 2000, temperature: 0.7 }
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text: text.trim(), model };
        // Gemini returned 200 but no text — safety block or empty response
        const finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN';
        lastErr = `Model ${model} returned no text (finishReason: ${finishReason})`;
        continue; // try next model
      }
      lastErr = data.error?.message || `HTTP ${res.status}`;
      const isModelErr = ['quota', 'unavailable', 'deprecated', 'not found', 'does not exist']
        .some(e => lastErr.toLowerCase().includes(e));
      if (!isModelErr) throw new Error(lastErr);
    } catch (e) {
      lastErr = e.message;
      const isModelErr = ['quota', 'unavailable', 'deprecated', 'not found', 'does not exist']
        .some(e2 => e.message.toLowerCase().includes(e2));
      if (!isModelErr) throw e;
    }
  }
  throw new Error('All Gemini models failed. Last error: ' + lastErr);
}

const { requireStudent } = require('../student-auth');

module.exports = async function mentorRoutes(app) {
  app.post('/mentor', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const student = await requireStudent(req, reply, 1);
    if (!student) return;
    const { tab, qCount, history, geminiKey, isFinal, subject } = req.body || {};

    if (!tab || !['ia', 'ee', 'tok'].includes(tab)) {
      return reply.status(400).send({ error: 'Invalid tab. Must be ia, ee, or tok.' });
    }

    if (!geminiKey || geminiKey.trim().length < 5) {
      return reply.status(400).send({ error: 'Gemini API key not found. Please add your key in the IBHighway portal.' });
    }
    if (!Array.isArray(history) || history.length === 0) {
      return reply.status(400).send({ error: 'history must be a non-empty array.' });
    }
    if (history.length > 60) {
      return reply.status(400).send({ error: 'History too long.' });
    }

    const subjKey = SUBJECTS[String(subject || '').toLowerCase()] ? String(subject).toLowerCase() : 'physics';
    const sys = getSysPrompt(tab, qCount || 0, !!isFinal, subjKey);
    if (!sys) return reply.status(400).send({ error: 'Could not resolve system prompt.' });

    try {
      const result = await callGemini(geminiKey, sys, history);
      return reply.send({ text: result.text, model: result.model });
    } catch (e) {
      app.log.error(e);
      return reply.status(500).send({ error: e.message });
    }
  });
};
