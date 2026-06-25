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

function getSystemPrompt(subject, step, formData = {}) {
  const spine = `
Research Question: ${formData.rq || 'Not defined yet'}
Independent Variable (IV): ${formData.variables_manager?.independent?.name || 'Not defined'}
Dependent Variable (DV): ${formData.variables_manager?.dependent?.name || 'Not defined'}
Controlled Variables: ${formData.variables_manager?.controls?.length > 0 ? formData.variables_manager.controls.map(c => c.name).join(', ') : 'Not defined'}
Experimental System / Context: ${formData.context || 'Not defined'}
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
${spine}
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

function getBrainstormPrompt(subject, turnCount, conversationHistory) {
  if (turnCount < 5) {
    return `You are acting as an IB ${subject} supervisor during the idea generation stage.
Your role is to encourage curiosity and help the student narrow broad interests into a testable direction.
Check basic scientific plausibility and feasibility.
CRITICAL: Ensure the topic is a valid physical system. REJECT ideas based on game rules, psychology, or pure math.
You must ask guiding questions, suggest possible directions, flag obvious scientific or practical risks gently.
Do NOT mention IB assessment criteria or marks. Do NOT use formal IA language (independent variable, dependent variable) unless the student uses it first.
Do NOT reject ideas unless they are clearly impossible at school level.
At the end (if appropriate): Propose ONE draft research question, clearly labelled as a draft that can be refined later.
Tone: Conversational, supportive, curious, non-judgmental.
Current State: Turn ${turnCount} of 5.
History: ${JSON.stringify(conversationHistory)}`;
  } else {
    return `You are acting as an IB ${subject} supervisor.
Based on the conversation below, propose a SINGLE, INFORMAL draft research question.
Rules:
1. Keep the tone exploratory (e.g., "How does X affect Y?" rather than "To determine the relationship...").
2. Do NOT list variables (IV/DV) explicitly.
3. Do NOT provide a justification or Rationale section.
4. Output MUST be strictly JSON in this format: {"rq": "The informal draft question..."}
History: ${JSON.stringify(conversationHistory)}`;
  }
}

module.exports = async function iaDiaryRoutes(app) {

  // POST /api/ia-review — section feedback
  app.post('/ia-review', async (req, reply) => {
    const { subject, step, studentInput, formData, geminiKey } = req.body || {};
    if (!geminiKey)     return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !step || !studentInput) return reply.code(400).send({ error: 'Missing fields' });

    try {
      const systemPrompt = getSystemPrompt(subject, step, formData || {});
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
      const result = await callGemini(geminiKey, prompt, 800);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

};
