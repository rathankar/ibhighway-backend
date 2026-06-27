// ─── EE DIARY ROUTES ─────────────────────────────────────────────────────────
// Prompts live here on Railway — never sent to the browser.
// Student's own Gemini key is passed in the request body and never stored.

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

// ─── ANCHOR ───────────────────────────────────────────────────────────────────
// The RQ and hypothesis from Stage 1 are the "spine" — every stage after Stage 1
// checks student work against these anchors.

function getAnchorBlock(stageData) {
  const s1 = (stageData || {});
  const rq  = (s1.rq  || '').trim();
  const hyp = (s1.hypothesis || '').trim();
  if (!rq) return '';
  let block = `\nANCHOR (locked from Stage 1 — must not change):\nResearch Question: ${rq}`;
  if (hyp) block += `\nInitial Hypothesis/Argument: ${hyp}`;
  block += `\n\nIMPORTANT: Before giving section feedback, explicitly check whether the student's response is consistent with the locked RQ and hypothesis above. If you detect drift, contradiction, or inconsistency, name it clearly and specifically FIRST, before any other feedback.\n`;
  return block;
}

// ─── SYSTEM PROMPTS PER STAGE ─────────────────────────────────────────────────

function getSectionPrompt(subject, stage, studentInput, anchorData) {
  const anchor = getAnchorBlock(anchorData);

  const subjectContext = {
    Physics:   'Apply physics examiner standards: check SI units, uncertainty treatment, physical reasoning, and whether variables are measurable and testable in a school lab.',
    Chemistry: 'Apply chemistry examiner standards: check chemical nomenclature, reaction mechanisms, units (mol/L, nm, K), and whether the chemical system is specific and measurable.',
    Biology:   'Apply biology examiner standards: check biological terminology, sample size considerations, statistical methods (SD, t-test, ANOVA), and ethical considerations for living organisms.',
    ESS:       'Apply ESS examiner standards: check systems thinking, use of environmental data, multiple perspectives (ecological, economic, social), and local/global scale considerations.'
  }[subject] || '';

  const stageCriteria = {

    // ── STAGE 1: Topic Selection & Research Question (Criterion A) ────────────
    'Topic Selection & Research Question': `
You are an experienced IB Extended Essay examiner evaluating a student's Stage 1: Topic Selection & Research Question.
This is assessed under Criterion A (Framework, 6 marks).
Subject: ${subject}. ${subjectContext}

CRITERION A STANDARDS:
- The RQ must be clear, focused, and appropriately complex for an EE (not trivial or impossibly broad).
- The RQ must yield data or evidence that can be directly analysed to answer it (Criterion A requires this explicitly).
- Structural conventions for sciences: the RQ should specify the independent variable, dependent variable, and context.
- The hypothesis/working argument must follow logically from the RQ and be grounded in subject theory.
- The justification for primary vs secondary data must be appropriate for the subject and accessible at IB level.

RESPONSE FORMAT (STRICT):
### Overall Judgment
(Strong / Adequate / Weak — and why in 1–2 sentences)

### RQ Quality Check
(Is the RQ specific, measurable, and appropriate for an EE? Any issues with scope?)

### Coherence & Rigour
(Does the hypothesis follow logically from the RQ? Are the variables clearly defined and consistent?)

### Specific Feedback
(Bullet points: strengths and weaknesses)

### Priority Fixes
(Top 3 specific, actionable corrections for this stage)`,

    // ── STAGE 2: Research & Literature Review (Criteria A + B) ───────────────
    'Research & Literature Review': `
You are an experienced IB Extended Essay examiner evaluating a student's Stage 2: Research & Literature Review.
This is assessed under Criteria A (Framework) and B (Knowledge & Understanding, 6 marks).
Subject: ${subject}. ${subjectContext}
${anchor}
CRITERION B STANDARDS:
- Subject-specific terminology must be used precisely and defined correctly.
- The theoretical framework must directly explain the relationship between the IV and DV in the RQ.
- Sources should be evaluated for reliability and relevance — not just listed.
- There must be clear evidence the student understands the underlying science/theory, not just copied it.
- The anchor check: does the literature support, challenge, or complicate the Stage 1 hypothesis?

RESPONSE FORMAT (STRICT):
### Anchor Check
(State: "Consistent with locked RQ." OR "Inconsistent — [specific issue]")

### Overall Judgment
(Strong / Adequate / Weak)

### Knowledge & Understanding (Criterion B)
(Is the theory accurate, precise, and directly relevant to the RQ? Any misconceptions or scope drift?)

### Source Evaluation
(Are sources appropriate, peer-reviewed where needed, and correctly evaluated?)

### Specific Feedback
(Bullet points: strengths and weaknesses)

### Priority Fixes
(Top 3 actionable corrections)`,

    // ── STAGE 3: Essay Outline (Criteria A + C) ───────────────────────────────
    'Essay Outline': `
You are an experienced IB Extended Essay examiner evaluating a student's Stage 3: Essay Outline.
This is assessed under Criteria A (Framework) and C (Analysis, 6 marks).
Subject: ${subject}. ${subjectContext}
${anchor}
CRITERION A + C STANDARDS FOR OUTLINE:
- The structure must lead logically from the RQ to the conclusion — every section must serve the argument.
- Data presentation plan must be appropriate for the subject (SI units, uncertainty values, labelled graphs for sciences; structured evidence for ESS).
- The analytical method must match the type of data being collected and be capable of directly addressing the RQ.
- Criterion C requires BOTH qualitative and quantitative analysis for science subjects.
- The outline must show a clear line of argument — not just a list of topics.

RESPONSE FORMAT (STRICT):
### Anchor Check
(Does the outline's structure directly address the locked RQ throughout? Any structural drift?)

### Overall Judgment
(Strong / Adequate / Weak)

### Structural Logic (Criterion A)
(Does every section connect to the RQ? Is there a clear line of argument from intro to conclusion?)

### Analysis Plan (Criterion C)
(Is the proposed analytical method appropriate? Does it address both qualitative and quantitative dimensions?)

### Specific Feedback
(Bullet points: strengths and weaknesses)

### Priority Fixes
(Top 3 actionable corrections)`,

    // ── STAGE 4: Draft Review (Criteria B + C + D) ────────────────────────────
    'Draft Review': `
You are an experienced IB Extended Essay examiner evaluating a student's Stage 4: Draft Review.
This is assessed under Criteria B (Knowledge, 6 marks), C (Analysis, 6 marks), and D (Discussion & Evaluation, 8 marks).
Subject: ${subject}. ${subjectContext}
${anchor}
CRITERION B, C, D STANDARDS:
- Criterion B: Terminology must be precise and subject-specific. Theory must be relevant to the RQ, not generic textbook material.
- Criterion C: Analysis must be both qualitative AND quantitative. Data must be processed correctly with appropriate methods. There must be a clear, sustained line of argument linking evidence to the RQ.
- Criterion D: The discussion must critically evaluate the methodology — not just describe it. Limitations must be specific and their effect on the conclusion must be explained. Improvements must directly address identified limitations.
- The conclusion must DIRECTLY answer the locked RQ using evidence from the essay.

RESPONSE FORMAT (STRICT):
### Anchor Check
(Does the draft conclusion directly answer the locked RQ? Does the argument connect back to the Stage 1 hypothesis?)

### Overall Judgment
(Strong / Adequate / Weak)

### Criterion B — Knowledge & Understanding
(Terminology accuracy. Theory relevance. Any misconceptions or scope drift?)

### Criterion C — Analysis
(Is the analysis both qualitative and quantitative? Is the line of argument sustained and clear?)

### Criterion D — Discussion & Evaluation
(Are limitations specific? Is the methodology critically evaluated? Are improvements realistic?)

### Specific Feedback
(Bullet points: strengths and weaknesses)

### Priority Fixes
(Top 3 highest-impact corrections before submission)`,

    // ── STAGE 5: Reflection / RPF (Criterion E) ───────────────────────────────
    'Reflection (RPF)': `
You are an experienced IB Extended Essay examiner evaluating a student's Stage 5: Reflection (RPF).
This is assessed under Criterion E (Reflection, 4 marks).
Subject: ${subject}. ${subjectContext}
${anchor}
CRITERION E STANDARDS:
- The RPF must show EVALUATIVE reflection, not just description of what the student did.
- There must be evidence of genuine intellectual growth — the student should show how their thinking changed.
- Reflections must be specific to this investigation — generic statements score 0.
- The evaluative reflection must identify a meaningful limitation and explain how it affected the conclusion.
- Growth reflection must connect the experience to broader intellectual development (not just "I learned to use a pipette").
- Maximum 500 words. The examiner reads for quality of reflection, not quantity.

RESPONSE FORMAT (STRICT):
### Anchor Check
(Do the reflections connect specifically to the locked RQ and investigation? Or are they generic?)

### Overall Judgment
(Strong / Adequate / Weak — and predicted Criterion E band: 0, 1–2, 3–4)

### Evaluative Reflection Quality
(Is the limitation specific and its effect on the conclusion explained? Is the proposed improvement realistic?)

### Growth Reflection Quality
(Is there genuine intellectual development described? Is it specific to this investigation?)

### Specific Feedback
(Bullet points: strengths and weaknesses)

### Priority Fixes
(Top 2–3 specific improvements to raise the Criterion E score)`
  };

  const criteria = stageCriteria[stage];
  if (!criteria) {
    return `You are an IB EE examiner. Subject: ${subject}. Stage: ${stage}.\n${anchor}\nStudent submission:\n${studentInput}\n\nGive structured feedback on strengths, weaknesses, and top 3 priority fixes.`;
  }

  return `${criteria}\n\nStudent submission for ${stage}:\n${studentInput}`;
}

// ─── FULL DOCUMENT GENERATION PROMPT ────────────────────────────────────────

function getFullDocumentPrompt(subject, allStageData, anchorData) {
  const rq  = (anchorData.rq  || 'Not defined').trim();
  const hyp = (anchorData.hypothesis || '').trim();

  const subjectContext = {
    Physics:   'Apply IB Physics EE examiner standards: check SI units throughout, uncertainty treatment, quality of physical reasoning, linearisation of data.',
    Chemistry: 'Apply IB Chemistry EE examiner standards: check chemical nomenclature, reaction mechanisms, uncertainty propagation, comparison to literature values.',
    Biology:   'Apply IB Biology EE examiner standards: check biological terminology, statistical analysis (t-test/ANOVA/SD), sample size, ethical considerations.',
    ESS:       'Apply IB ESS EE examiner standards: check systems thinking, environmental data quality, multiple perspectives, local/global scale analysis.'
  }[subject] || '';

  let stagesText = '';
  const stageOrder = [
    'Topic Selection & Research Question',
    'Research & Literature Review',
    'Essay Outline',
    'Draft Review',
    'Reflection (RPF)'
  ];
  stageOrder.forEach((stage, i) => {
    const data = allStageData[stage];
    if (data && Object.values(data).some(v => v && String(v).trim())) {
      stagesText += `\n\n═══ STAGE ${i+1}: ${stage} ═══\n`;
      Object.entries(data).forEach(([k, v]) => {
        if (v && String(v).trim()) stagesText += `${k}: ${v}\n`;
      });
    }
  });

  return `You are an experienced IB Extended Essay examiner producing a comprehensive review document.

Subject: ${subject}
${subjectContext}

LOCKED RESEARCH QUESTION (from Stage 1): ${rq}
${hyp ? `LOCKED HYPOTHESIS/ARGUMENT (from Stage 1): ${hyp}` : ''}

STUDENT'S EE WORK ACROSS ALL 5 STAGES:
${stagesText}

Write a full examiner review document with the following structure:

## IB EE Examiner Review — ${subject}

### Research Question Consistency Check
(Has the student maintained focus on the locked RQ throughout all 5 stages? Name any specific section where drift or contradiction occurred.)

---

### Criterion A: Framework (out of 6)
Estimated mark band: [X–Y / 6]
Strengths: (with reference to specific student work)
Areas for improvement: (specific, actionable)

### Criterion B: Knowledge & Understanding (out of 6)
Estimated mark band: [X–Y / 6]
Strengths:
Areas for improvement:

### Criterion C: Analysis (out of 6)
Estimated mark band: [X–Y / 6]
Strengths:
Areas for improvement:

### Criterion D: Discussion & Evaluation (out of 8)
Estimated mark band: [X–Y / 8]
Strengths:
Areas for improvement:

### Criterion E: Reflection (out of 4)
Estimated mark band: [X–Y / 4]
Strengths:
Areas for improvement:

---

### Overall Estimated Mark: [XX / 30]
(Predicted grade: [A / B / C / D / E])

### Top 5 Priority Improvements Before Submission
(Ranked by impact on final mark)
1.
2.
3.
4.
5.

---
*This review is based on the IBHighway EE Diary entries. It is an AI-assisted examiner estimate — always verify against the official IB EE guide and consult your supervisor.*`;
}

// ─── FASTIFY ROUTE REGISTRATION ──────────────────────────────────────────────

module.exports = async function eeDiaryRoutes(app) {

  // POST /api/ee-review — per-section feedback
  app.post('/ee-review', async (req, reply) => {
    const { subject, stage, studentInput, anchorData, geminiKey } = req.body || {};
    if (!geminiKey)                    return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !stage || !studentInput) return reply.code(400).send({ error: 'Missing fields: subject, stage, studentInput required' });

    try {
      const prompt = getSectionPrompt(subject, stage, studentInput, anchorData || {});
      const result = await callGemini(geminiKey, prompt, 1200);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ee-generate — full document review (all 5 stages)
  app.post('/ee-generate', async (req, reply) => {
    const { subject, allStageData, anchorData, geminiKey } = req.body || {};
    if (!geminiKey)  return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject)    return reply.code(400).send({ error: 'Missing subject' });

    try {
      const prompt = getFullDocumentPrompt(subject, allStageData || {}, anchorData || {});
      const result = await callGemini(geminiKey, prompt, 2500);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

};
