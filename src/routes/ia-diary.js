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
    const url = `https://generativelanguage.googleapis.com/${m.api}/models/${m.model}:generateContent?key=${geminiKey}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

module.exports = async function iaDiaryRoutes(app) {

  // POST /api/ia-review — section feedback
  app.post('/ia-review', async (req, reply) => {
    const { subject, step, studentInput, spine, geminiKey } = req.body || {};
    if (!geminiKey)     return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !step || !studentInput) return reply.code(400).send({ error: 'Missing fields' });

    try {
      const systemPrompt = getSystemPrompt(subject, step, spine || {});
      const fullPrompt   = `${systemPrompt}\n\nStudent Submission for ${step}:\n${studentInput}`;
      const result = await callGemini(geminiKey, fullPrompt, 1500);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ia-brainstorm — idea generation chat
  app.post('/ia-brainstorm', async (req, reply) => {
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

};
