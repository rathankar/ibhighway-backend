// ─── IA DIARY ROUTES ─────────────────────────────────────────────────────────
// Prompts live here on Railway — never sent to the browser.
// Student's own Gemini key is used for the API call and never stored.

const MODELS = [
  { model: 'gemini-3.5-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-pro',        api: 'v1beta' },
  { model: 'gemini-3.1-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-flash-lite', api: 'v1beta' },
  { model: 'gemini-2.5-pro',        api: 'v1beta' },
  { model: 'gemini-2.5-flash',      api: 'v1beta' },
  { model: 'gemini-2.5-flash-lite', api: 'v1beta' },
];

async function callGemini(geminiKey, prompt, maxTokens = 1500) {
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

// `spine` is flat strings pulled by the client from other sections the
// student has already filled in (Research Question, Hypothesis & Variables,
// Introduction) -- kept flat rather than a nested variables_manager object
// because the deployed client stores answers as simple {id: text} pairs
// per section, not a structured variables object.
function getSystemPrompt(subject, step, spine = {}) {
  const spineText = `
Research Question: ${spine.rq || 'Not defined yet'}
Independent Variable (IV): ${spine.iv || 'Not defined'}
Dependent Variable (DV): ${spine.dv || 'Not defined'}
Controlled Variables: ${spine.controls || 'Not defined'}
Experimental System / Context: ${spine.context || 'Not defined'}
`;

  const subjectFocus = {
    'Physics':   'Focus on uncertainties, linearization of data, propagation of errors, and physical meaning of gradients/intercepts.',
    'Chemistry': 'Focus on stoichiometry, reaction mechanisms, purity of reagents, and random vs systematic errors.',
    'Biology':   'Focus on biological variability, sample size (n>5), standard deviation, statistical significance (t-test/ANOVA), and ethics.',
    'ESS':       'Focus on environmental systems, reliability of secondary data, different perspectives (EVS), and sustainability.'
  }[subject] || '';

  const basePersona = `You are an experienced IB ${subject} IA examiner.
The student has submitted work for the section: "${step}".
You are provided with the Fixed Research Spine for this investigation:
${spineText}
TASK: Evaluate the student's response using TWO lenses:
Lens 1: Section Quality (Local) — scientific accuracy, clarity, depth, correct terminology. ${subjectFocus}
Lens 2: Document Coherence (Global) — check logical consistency with the Research Spine. Identify scope drift, variable swapping, or logical disconnects.

RESPONSE FORMAT (STRICT):
### Overall Judgment
(Strong / Adequate / Weak)

### Coherence Check
(State explicitly: "This section is coherent with the research question." OR "This section is NOT coherent." If not, state exactly what is mismatched.)

### Specific Feedback
(Bullet points on strengths and weaknesses specific to this section)

### Priority Fixes
(Top 3 actionable corrections)`;

  const stepCriteria = {
    'Introduction':                       'Context must lead directly to the specific aim/RQ. Must not drift into unrelated topics.',
    'Research Question':                  'Must clearly state the relationship between the IV and DV. Must include specific conditions (e.g. species, chemical system).',
    'Background Research':                'Must explain theory specifically relevant to IV and DV. Equations must link the variables in the RQ. Irrelevant textbook theory = Scope Drift.',
    'Hypothesis & Variables':             'Hypothesis must predict the effect of IV on DV based on theory. Variables must MATCH the Research Spine exactly. Controls must be relevant to the specific experimental context.',
    'Materials':                          'Must list instruments capable of measuring the specific IV and DV. Range and precision must be appropriate for the expected values.',
    'Procedure & Method':                 'Method must vary the IV and measure the DV as defined in the Spine. Controls mentioned in the Spine must be explicitly kept constant. Any new variable introduced = Coherence Failure.',
    'Risk Assessment':                    'Risks must be specific to the chemicals/equipment used.',
    'Raw Data Collection':                'Columns must correspond to IV and DV. Units and uncertainties must be present.',
    'Processed Data':                     'Processing must convert raw data into variables needed to test the Hypothesis. Sample calculation must use data from the table.',
    'Graphical Analysis':                 'Graph axes must match IV and DV (or linearized forms). Interpretation must relate gradient/intercept back to the Hypothesis.',
    'Conclusion':                         'Must answer the specific Research Question. Must not introduce new findings unrelated to the original aim.',
    'Evaluation: Hypothesis & Model':     'Assessment must be based on actual data collected. Model validity must relate to the specific theoretical context defined earlier.',
    'Evaluation: Methodology & Errors':   "Errors must explain why DV deviated from expectations. 'Human error' is banned. Must distinguish random (precision) vs systematic (accuracy) errors.",
    'Evaluation: Improvements & Future Work': 'Improvements must address specific errors identified. Extensions must call back to the original Research Context.'
  };

  const criteria = stepCriteria[step] || Object.entries(stepCriteria).find(([k]) => step.includes(k))?.[1] || '';
  return criteria ? `${basePersona}\n\nSPECIFIC CRITERIA FOR ${step.toUpperCase()}:\n${criteria}` : basePersona;
}

// `conversationHistory` is the plain transcript the client keeps itself:
// [{ role: 'student'|'buddy', text }, ...]. Output format matches what the
// client's chat widget parses: normal conversational text, and once a
// research question is ready, a reply that STARTS with "RESEARCH QUESTION:"
// followed by the question on that same line.
function getBrainstormPrompt(subject, turnCount, conversationHistory) {
  const shouldProposeRQ = (turnCount || 0) >= 4;
  const transcript = (conversationHistory || [])
    .map(m => (m.role === 'student' ? 'Student: ' : 'Buddy: ') + m.text)
    .join('\n');

  return `You are a friendly, encouraging AI brainstorming buddy helping an IB ${subject} student develop an idea for their Internal Assessment (IA). ` +
    `Ask short, focused follow-up questions (one at a time) to help them narrow down: (1) a phenomenon or topic they're curious about, (2) a possible independent variable they could change, (3) a possible dependent variable they could measure, (4) whether it's feasible in a school lab. ` +
    `Keep each reply to 2-4 sentences, conversational and warm. Use plain sentences only -- no markdown formatting (no **, no bullet lists, no headers). ` +
    (shouldProposeRQ
      ? `The conversation has gone on for a few turns now -- based on everything the student has told you, propose ONE clear, focused Research Question suitable for an IB ${subject} IA. Start your reply with "RESEARCH QUESTION:" followed by the question on the same line, then a short sentence of encouragement.`
      : `Do not propose a final research question yet -- just ask the next most useful follow-up question based on what the student has said so far.`) +
    `\n\nConversation so far:\n${transcript}\n\nBuddy:`;
}

// Full-document review, run once the student has filled in all 17 sections.
// `sectionsText` is the concatenated raw Q&A text the client already has on
// screen (nothing new is revealed by sending it -- it's the student's own
// answers) -- only the instructions/rubric wrapper is server-side.
function getFullReviewPrompt(subject, sectionsText) {
  return `You are an experienced IB examiner producing a full Internal Assessment review document.

Subject: ${subject}
Student's IA content by section:
${sectionsText}

Write a comprehensive examiner review document. For each IB assessment criterion (Personal Engagement, Exploration, Analysis, Evaluation, Communication), provide:
1. A mark band estimate (e.g. 3-4 out of 6)
2. Specific strengths with reference to the student's work
3. Specific areas for improvement with actionable suggestions
4. Examiner comments

End with an overall estimated total mark out of 24 and a summary of the most important things to fix before submission.

Be honest, specific, and constructive. Reference actual content from the student's responses.`;
}

// Grading an already-written IA draft the student pastes in, against all 5
// criteria at once, rather than section by section.
function getGradePrompt(subject, studentText) {
  return `You are an experienced IB examiner grading a complete Internal Assessment draft.

Subject: ${subject}

Full IA text submitted by the student:
${studentText}

Grade this IA against all five IB assessment criteria (Personal Engagement, Exploration, Analysis, Evaluation, Communication). For each criterion, provide:
1. A mark band estimate with justification
2. Specific strengths, quoting the student's own words where relevant
3. Specific weaknesses and concrete, actionable fixes
4. Examiner-style comments

End with an overall estimated total mark out of 24 and a prioritized list of the top 3 things to fix before submission.

Be honest, specific, and constructive.`;
}

// NEW (additive — does not touch the section/full-review/grade prompts above).
// Focused feedback on ONE answer only, for the per-question diary panel: short,
// plain-text, judges just that answer, and flags completion with [COMPLETE].
function getQuestionFeedbackPrompt(subject, section, questionLabel, answer) {
  return `You are an experienced IB ${subject} examiner giving quick feedback on ONE answer a student wrote in their Internal Assessment.

Section: ${section}
Question: ${questionLabel}
Student's answer: ${answer}

Give short, specific, encouraging feedback on THIS answer only. Rules:
- 2 to 4 sentences of plain conversational English.
- Name one thing done well and the single most important improvement.
- Judge ONLY the answer given. Do NOT mention or assume other questions, and do NOT ask for content that belongs to a different question.
- No markdown at all: no #, no *, no **, no headings, no bullet characters. Plain text only.
- If this answer already fully and correctly addresses the question, end your reply with the exact tag [COMPLETE].`;
}

const { requireStudent, checkDiaryRun, useDiaryRun } = require('../student-auth');
const RL = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

module.exports = async function iaDiaryRoutes(app) {

  // POST /api/ia-question-feedback — feedback on a SINGLE answer (diary engine)
  app.post('/ia-question-feedback', RL(40), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, section, questionLabel, answer, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !questionLabel || !answer) return reply.code(400).send({ error: 'Missing fields' });
    try {
      const prompt = getQuestionFeedbackPrompt(subject, section || '', questionLabel, answer);
      const result = await callGemini(geminiKey, prompt, 1500);
      const text = (result.text || '');
      const complete = /\[COMPLETE\]/i.test(text);
      return reply.send({ text: text.replace(/\[COMPLETE\]/ig, '').trim(), model: result.model, complete });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ia-review — section feedback
  app.post('/ia-review', RL(30), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, step, studentInput, spine, geminiKey } = req.body || {};
    if (!geminiKey)     return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !step || !studentInput) return reply.code(400).send({ error: 'Missing fields' });

    try {
      const systemPrompt = getSystemPrompt(subject, step, spine || {});
      const fullPrompt   = `${systemPrompt}\n\nStudent Submission for ${step}:\n${studentInput}`;
      // 1500 was too tight for the strict 4-heading format (Overall Judgment,
      // Coherence Check, Specific Feedback, Priority Fixes) -- responses were
      // getting cut off mid-section on longer student submissions.
      const result = await callGemini(geminiKey, fullPrompt, 2500);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ia-brainstorm — idea generation chat
  app.post('/ia-brainstorm', RL(30), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, turnCount, conversationHistory, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject)   return reply.code(400).send({ error: 'Missing subject' });

    try {
      const prompt = getBrainstormPrompt(subject, turnCount || 0, conversationHistory || []);
      const result = await callGemini(geminiKey, prompt, 1500);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ia-generate — full document review (all 17 sections at once)
  app.post('/ia-generate', RL(10), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, sectionsText, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !sectionsText) return reply.code(400).send({ error: 'Missing fields' });

    // Shared IA/EE/TOK run cap — enforced HERE so direct API calls can't
    // bypass it. Checked before generating, consumed only after success.
    const runs = await checkDiaryRun(student.code);
    if (runs.blocked) {
      return reply.code(429).send({ error: 'You have used all of your diary generations (shared across IA, EE, and TOK Diary). This limit does not reset automatically.' });
    }

    try {
      const prompt = getFullReviewPrompt(subject, sectionsText);
      const result = await callGemini(geminiKey, prompt, 2500);
      const run = await useDiaryRun(student.code);
      return reply.send({ ...result, runMessage: run.message || run.error || null });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ia-grade — grade an existing, already-written IA draft
  app.post('/ia-grade', RL(10), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, studentText, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !studentText) return reply.code(400).send({ error: 'Missing fields' });

    try {
      const prompt = getGradePrompt(subject, studentText);
      const result = await callGemini(geminiKey, prompt, 2500);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

};
