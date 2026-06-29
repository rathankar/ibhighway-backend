// ─── TOK DIARY ROUTES ─────────────────────────────────────────────────────────
// Theory of Knowledge Essay Diary — per-stage AI examiner feedback
// Criteria: A (Understanding KQs, 10 marks) + B (Quality of Analysis, 20 marks) = 30 marks total
// Student's own Gemini key passed in request body, never stored server-side.

const MODELS = [
  { model: 'gemini-3.5-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-pro',        api: 'v1beta' },
  { model: 'gemini-3.1-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-flash-lite', api: 'v1beta' },
  { model: 'gemini-2.5-pro',        api: 'v1beta' },
  { model: 'gemini-2.5-flash',      api: 'v1beta' },
  { model: 'gemini-2.5-flash-lite', api: 'v1beta' },
];

async function callGemini(geminiKey, prompt, maxTokens = 2000) {
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
      const tokensUsed = d.usageMetadata?.totalTokenCount || 0;
      return { text, model: m.model, tokensUsed };
    } catch (e) {
      if (e.message?.includes('not found') || e.message?.includes('deprecated')) continue;
      throw e;
    }
  }
  throw new Error('No compatible Gemini model found for your API key.');
}

// ─── ANCHOR BLOCK ─────────────────────────────────────────────────────────────
// PT + KQ locked at Stage 1. Every subsequent stage is checked against these.

function getAnchorBlock(anchorData) {
  const pt = (anchorData?.pt || '').trim();
  const kq = (anchorData?.kq || '').trim();
  if (!pt) return '';
  let block = `\nLOCKED ANCHOR (must not change across stages):\nPrescribed Title (PT): ${pt}`;
  if (kq) block += `\nStudent's Knowledge Question (KQ): ${kq}`;
  block += `\n\nBefore any other feedback, check explicitly: is the student's response consistent with and directly advancing the locked PT and KQ above? If you detect drift, contradiction, or irrelevance, name it specifically FIRST.\n`;
  return block;
}

// ─── TOK ASSESSMENT CONTEXT ───────────────────────────────────────────────────

const TOK_CONTEXT = `
TOK ESSAY ASSESSMENT (post-2022 syllabus):
- Criterion A: Understanding Knowledge Questions (10 marks)
  • Does the student identify genuine, second-order knowledge questions arising from the PT?
  • Are KQs clearly formulated as open, conceptual questions about knowledge itself (not first-order factual questions)?
  • Does the student show understanding of the complexity of the KQ — not just give examples?

- Criterion B: Quality of Analysis of Knowledge Questions (20 marks)
  • Are claims and counterclaims developed with real depth — not just stated?
  • Are AOKs used as analytical lenses, not just context or examples?
  • Are Real-Life Situations (RLS) specific, named, and genuinely illuminating — not vague or decorative?
  • Is the argument coherent, structured, and does it directly answer the PT?
  • Are implications addressed — the "so what?" of the analysis?

Total: 30 marks → converted to 0–10 IB bonus points (combined with EE grade).

THE 5 AREAS OF KNOWLEDGE (AOKs): Natural Sciences, Human Sciences, History, The Arts, Mathematics.

KEY DISTINCTIONS TO CHECK:
- Second-order question: asks about the nature/limits/justification of knowledge ("How do we know X is certain?")
- First-order question: asks about the world ("Is X true?" or "What is X?")
- RLS must be specific and named — not "scientists have found that…"
- Counterclaims must genuinely threaten the claim, not be strawmen easily dismissed
- Implications must explain why the conclusion matters for knowledge — not just restate it
- History as AOK = the process of how historians produce knowledge, NOT events that happened in the past
- The Arts as AOK = how artistic knowledge is produced and validated, NOT just art appreciation

COMMON EXAMINER CRITICISMS TO FLAG:
1. KQ is first-order or too factual ("Is X true?" instead of "How do we know X?")
2. RLS is vague, generic, or used as decoration without analytical follow-through
3. Only one AOK explored in depth; second AOK is superficial
4. Claims stated but not developed with reasoning or evidence
5. Counterclaims dismissed in one sentence without engagement
6. Conclusion summarises rather than synthesises
7. Essay answers a different question from the PT (drift)
8. Personal knowledge references are vague ("in my experience…")
9. Word count exceeded (1,600 words maximum — hard limit)
10. AOK used as background/context rather than as an analytical lens
`;

// ─── STAGE-SPECIFIC GUIDANCE FOR AI ──────────────────────────────────────────

const STAGE_GUIDANCE = {

  'Stage 1: Prescribed Title & Knowledge Question': `
WHAT TO ASSESS IN STAGE 1:
- Q1 (PT): Is the PT pasted correctly and completely — not paraphrased or altered?
- Q2 (Key Terms): Are terms defined in a TOK context (as properties of knowledge), not just dictionary definitions? Are 3–5 genuine key terms identified from the PT?
- Q3 (Assumptions): Are at least 2 genuine assumptions in the PT identified and explained? Are these genuine assumptions (things the PT takes for granted) rather than just background facts?
- Q4 (PT Restatement): Does the student genuinely understand what the PT is asking in their own words? Is it insightful — showing they grasp the knowledge problem — or is it just a paraphrase?
- Q5 (Thesis Direction): Is the thesis direction arguable and nuanced — not just "yes" or "no"? Does it hint at complexity and AOK-specific variation?
- Q6 (First vs Second Order): Has the student clearly distinguished a first-order question from their second-order KQ? Is the first-order example genuinely first-order, and is the rewrite genuinely second-order?
- Q7 (KQ): Is the KQ open-ended, second-order, and genuinely arising from the PT? Does it begin with "To what extent…", "How…", "Under what conditions…" or similar? Is it answerable through two AOKs?
- Q8 (KQ Defence): Has the student explained WHY their KQ is second-order — not just asserted it? Is the comparison to a first-order version convincing?
- Q9 (KQ–PT Link): Is the logical connection between KQ and PT explicit and convincing — does the student explain HOW answering the KQ would answer the PT?

CRITICAL CHECK: Is the KQ genuinely second-order? This is the most important question in Stage 1. A KQ like "Is certainty possible in mathematics?" is FIRST-order (factual). A genuine second-order KQ would be "What role does formal proof play in justifying certainty as a property of mathematical knowledge?" — it asks about the nature of knowledge, not about facts.`,

  'Stage 2: Areas of Knowledge & Perspectives': `
WHAT TO ASSESS IN STAGE 2:
- AOK Choices (Q1, Q5): Are the two AOKs genuinely different — not two sub-fields of the same discipline? (Physics + Chemistry would both be Natural Sciences and is a poor choice.) Are they both well-suited to the KQ?
- AOK Rationales (Q2, Q6): Is the rationale ANALYTICAL — explaining why this AOK's nature or methodology makes it productive for the KQ — or is it just "I know this subject"? Flag rationales that are personal preference without analytical reasoning.
- Methodologies (Q3, Q7): Is the methodology accurately described? Check for common errors:
  • Natural Sciences: must mention hypothesis, experiment, falsifiability, peer review — not just "scientists test things"
  • History: methodology is SOURCE EVALUATION, corroboration, historiographical debate — NOT "studying past events"
  • The Arts: interpretation, aesthetic judgement, cultural context, how knowledge is validated in art
  • Mathematics: formal proof, axioms, logical deduction — not "solving problems"
  • Human Sciences: empirical study of human behaviour, ethical constraints, interpretation
- KQ Links (Q4, Q8): Is the link specific — explaining what this AOK reveals about the KQ that another AOK might not? Or is it generic?
- Contrast (Q11): Is there a genuine, productive contrast between the two AOKs — do they produce different or even opposing insights about the same KQ? Or are they too similar?
- Personal vs Shared Knowledge (Q9): Is the personal example specific and genuine — not vague? Is the connection to the KQ explicit?

WATCH FOR: Students who pick AOKs because they are familiar with the subject, not because the AOK is analytically productive. The best AOK choice creates maximum intellectual tension with the KQ.`,

  'Stage 3: Claims, Counterclaims & Real-Life Situations': `
WHAT TO ASSESS IN STAGE 3:
- Claims (Q1, Q7): Is each claim conceptual (about how knowledge works) rather than factual (a claim about the world)? Is it arguable — could a reasonable person disagree? Is it specific to the AOK — does it use the AOK's methodology or nature as part of the claim?
- RLS (Q2, Q5, Q8, Q11): 
  • Is each RLS specific and named? (Not "scientists have found that…" but "Watson and Crick's 1953 DNA double helix model…")
  • Is it genuinely illuminating — does it make the claim clearer, or is it decorative?
  • Does the student understand it well enough to analyse it (not just cite it)?
- RLS Analysis (Q3, Q9): This is the most important question in Stage 3 — and the one most students skip. Check:
  • Does the analysis go BEYOND description? (Not "This shows that X happened" but "This reveals that in the Natural Sciences, knowledge is validated through…")
  • Does the analysis connect explicitly back to the KQ and PT?
  • Is there a genuine "so what?" — an inference about how knowledge works?
- Counterclaims (Q4, Q10): 
  • Does the counterclaim genuinely challenge the claim — or is it a strawman?
  • Is the counterclaim within the same AOK (not a different topic)?
  • Does it make the student's argument less certain without destroying it?
- Reconciliation/Mini-Conclusions (Q6, Q12): Does the reconciliation produce a NEW insight — a more nuanced understanding of the claim after the counterclaim? Or does it just say "both have valid points"?
- Cross-AOK Comparison (Q13): Is the comparison analytical — explaining WHY the two AOKs produce different insights? Or is it just listing what each AOK showed?
- Implications (Q14): Are implications addressed? Does the student explain why this conclusion matters beyond the essay? Is the "so what?" genuine — not just a restatement?`,

  'Stage 4: Essay Outline & Line of Argument': `
WHAT TO ASSESS IN STAGE 4:
- Hook (Q1): Does the hook create genuine intellectual interest — a paradox, puzzle, or striking observation? Or is it generic ("Since the beginning of time…")? Does it avoid "In this essay, I will…"?
- Key Term Definitions (Q2): Are definitions contextual and TOK-relevant — not dictionary definitions? Are they woven naturally into sentences rather than listed like a glossary?
- Thesis (Q3): Is the thesis: (a) a direct answer to the PT, (b) nuanced/qualified rather than a blunt yes/no, (c) signalling the two AOKs? Does it create expectations the essay can fulfil in 1,600 words?
- Roadmap (Q4): Is the roadmap explicit — naming both AOKs and signalling the contrast between them? This helps the examiner follow the structure.
- Body Plans (Q5, Q6): Are the plans concrete — naming specific claims, specific RLS, specific counterclaims? Or are they vague? Is the transition sentence between AOK 1 and AOK 2 explicit?
- Conclusion (Q7): Is the conclusion a SYNTHESIS (new insight from combining both AOKs) or just a summary? Does it directly answer the PT?
- Implications (Q8): Are implications genuine — explaining consequences for knowledge — or just padding?
- Line of Argument (Q9): Can the student state their complete line of argument in one sentence? If not, the argument is not yet coherent.
- Word Count Plan (Q10): Is the allocation realistic? Does it respect the 1,600 word limit? A common mistake is underestimating intro/conclusion and leaving too little for body analysis.
- Self-Criticism (Q11): Has the student honestly identified genuine weaknesses — or are their "concerns" trivial? Praise genuine self-criticism as a sign of good TOK thinking.`,

  'Stage 5: Draft Review & Evaluation': `
WHAT TO ASSESS IN STAGE 5:
- Full Draft (Q1): Read the draft carefully. Assess it holistically against Criteria A and B before giving per-question feedback.
- PT Focus (Q2): Does every paragraph connect back to the PT — not just tangentially, but explicitly? Flag any specific paragraph where the connection to the PT is unclear or absent.
- KQ Presence (Q3): Is the KQ explicitly stated in the essay — ideally in the introduction? Is it genuinely second-order in the context of the full essay?
- RLS Specificity (Q4): Are RLS examples specific and named in the actual draft? Is each RLS analytically integrated — or just cited?
- Counterclaim Quality (Q5): Are counterclaims genuinely challenging? Are they developed with RLS? Are they dismissed too quickly?
- Criterion A Self-Mark (Q6): Is the student's self-mark realistic? Challenge over-confidence or under-confidence with specific references to the draft.
- Criterion B Self-Mark (Q7): Same — is it realistic? Point to specific evidence in the draft for your assessment.
- Implications (Q8): Are implications present in the draft? Are they genuine — explaining why the conclusion matters for knowledge?
- Word Count (Q9): Is the essay within 1,600 words? If over, identify specific cuts. If under, identify where depth (not length) can be added.
- Top 3 Revisions (Q10): Are the revision priorities the student listed the RIGHT ones — the highest-impact changes? If not, suggest better priorities.

OVERALL DRAFT ASSESSMENT: Provide estimated Criterion A mark (out of 10) and Criterion B mark (out of 20) with specific justification referencing the actual draft content.`,

  'Stage 6: Reflection & Personal Engagement': `
WHAT TO ASSESS IN STAGE 6:
- Personal Knowledge (Q1): Is the personal experience specific and genuine — not vague? Does it connect meaningfully to the KQ/PT — not just to the topic?
- What Changed (Q2): Is the intellectual change specific — naming a particular moment or insight? Or is it generic ("I learned to think more critically")? Generic reflections score low.
- Unexpected Difficulty (Q3): Is the difficulty intellectual — about the knowledge problem itself — or just practical (time management, finding sources)? Intellectual difficulty is more valuable to describe.
- Remaining Tension (Q4): Has the student identified a GENUINE remaining tension — something the essay could not fully resolve? Or is it invented? Showing awareness of limits is intellectually mature.
- Perspective Awareness (Q5): Is the student genuinely self-aware about how their background shaped their essay — or is it a generic disclaimer? Specific examples of perspective-shaping are much better.
- Subject Connection (Q6): Is the connection to an IB subject specific — naming a concept, topic, or experience from a named subject? Or is it vague?
- What They'd Do Differently (Q7): Is the reflection evaluative — explaining WHY they'd do it differently and what it would have produced? Or is it just listing things?
- Intellectual Honesty (Q8): Has the student genuinely identified where their argument breaks down — with specific conditions under which the thesis fails? This is the highest-order reflection task and the one most students avoid.

IMPORTANT: Reflections in Stage 6 are not separately marked under post-2022 criteria, but they develop the personal knowledge dimension that can strengthen Criterion A and B when integrated into the essay. Encourage the student to weave strong reflective insights back into the essay itself.`,

};

// ─── PER-QUESTION PROMPT BUILDER ─────────────────────────────────────────────

function buildPerQuestionPrompt(stage, studentInput, anchorData) {
  const anchor = getAnchorBlock(anchorData);
  const guidance = STAGE_GUIDANCE[stage] || 'Apply IB TOK examiner standards to each answer below.';

  const stageCriterion = {
    'Stage 1: Prescribed Title & Knowledge Question': 'Criterion A — Understanding Knowledge Questions (feeds into 10 marks)',
    'Stage 2: Areas of Knowledge & Perspectives':     'Criterion A+B — AOK Selection and Analytical Framing',
    'Stage 3: Claims, Counterclaims & Real-Life Situations': 'Criterion B — Quality of Analysis (feeds into 20 marks)',
    'Stage 4: Essay Outline & Line of Argument':      'Criterion B — Coherence and Structure',
    'Stage 5: Draft Review & Evaluation':             'Criterion A (10 marks) + Criterion B (20 marks) — Full 30-mark assessment',
    'Stage 6: Reflection & Personal Engagement':      'Personal Knowledge dimension — strengthens Criterion A and B',
  }[stage] || 'IB TOK Assessment';

  return `You are an experienced IB Theory of Knowledge examiner giving per-question feedback on a student's essay diary.

${TOK_CONTEXT}

Stage: ${stage}
Assessment Focus: ${stageCriterion}

${anchor}
${guidance}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STUDENT'S ANSWERS FOR THIS STAGE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${studentInput}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR RESPONSE FORMAT (STRICT — follow exactly):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Anchor Check
State explicitly: "Consistent with locked PT/KQ." OR "INCONSISTENT — [specific mismatch described]."

### Per-Question Feedback

For EACH question the student has answered, provide:

**Q[N] — [question topic in 3–5 words]**
- Depth: (Excellent / Adequate / Superficial / Missing)
- Feedback: [2–4 sentences — specific critique. Name what is strong. Name what is weak. Reference the student's actual words. For KQ questions: state explicitly whether it is second-order or first-order and why. For RLS questions: state whether it is specific/named and whether the analytical link is explicit. For claims: state whether it is conceptual or factual.]
- Fix: [One specific, actionable sentence: exactly what should the student add, change, or remove?]

(Repeat for every answered question. For unanswered questions: write "**Q[N]** — Not yet answered.")

### Stage Overview
(Strong / Adequate / Weak — 2 sentences on the overall quality of this stage's work, referencing the specific criterion being developed.)

### Top 3 Priority Fixes
(The three highest-impact corrections to raise the IB TOK mark. Be specific — name the question number and exactly what needs to change.)

1.
2.
3.`;
}

// ─── FULL ESSAY REVIEW PROMPT ─────────────────────────────────────────────────

function buildFullReviewPrompt(allStageData, anchorData) {
  const pt  = (anchorData?.pt  || 'Not provided').trim();
  const kq  = (anchorData?.kq  || 'Not provided').trim();

  const stageOrder = [
    'Stage 1: Prescribed Title & Knowledge Question',
    'Stage 2: Areas of Knowledge & Perspectives',
    'Stage 3: Claims, Counterclaims & Real-Life Situations',
    'Stage 4: Essay Outline & Line of Argument',
    'Stage 5: Draft Review & Evaluation',
    'Stage 6: Reflection & Personal Engagement',
  ];

  let stagesText = '';
  stageOrder.forEach((stage, i) => {
    const data = allStageData[stage];
    if (data && Object.values(data).some(v => v && String(v).trim())) {
      stagesText += `\n\n═══ ${stage} ═══\n`;
      Object.entries(data).forEach(([k, v]) => {
        if (v && String(v).trim()) stagesText += `${k}: ${String(v).trim()}\n`;
      });
    }
  });

  return `You are an experienced IB Theory of Knowledge examiner producing a comprehensive review of a student's TOK Essay Diary.

${TOK_CONTEXT}

LOCKED PRESCRIBED TITLE (PT): ${pt}
STUDENT'S KNOWLEDGE QUESTION (KQ): ${kq}

STUDENT'S WORK ACROSS ALL 6 STAGES:
${stagesText}

Produce a full examiner review document in this exact format:

## IB TOK Essay — Examiner Review

### PT & KQ Consistency Check
(Has the student maintained focus on the locked PT and their KQ throughout all 6 stages? Name any specific stage where drift, contradiction, or loss of focus occurred.)

---

### Criterion A: Understanding Knowledge Questions (out of 10)
Estimated mark band: [Rudimentary 1–2 / Basic 3–4 / Satisfactory 5–6 / Good 7–8 / Excellent 9–10]
Strengths: (reference specific student work)
Areas for improvement: (specific and actionable)
KQ quality verdict: (Is the KQ genuinely second-order? State explicitly and explain why.)

### Criterion B: Quality of Analysis of Knowledge Questions (out of 20)
Estimated mark band: [Rudimentary 1–4 / Basic 5–8 / Satisfactory 9–12 / Good 13–16 / Excellent 17–20]
Strengths: (reference specific student work)
Areas for improvement: (specific and actionable)
RLS quality verdict: (Are RLS specific, named, and analytically integrated — or vague and decorative?)
Counterclaim quality verdict: (Are counterclaims genuinely challenging and developed?)
Implications verdict: (Has the student addressed the "so what?" of their analysis?)

---

### Overall Estimated Mark: [XX / 30]
(Converted IB points: 0–10 — note this is combined with EE grade for bonus points)

### AOK Analysis Verdict
AOK 1 ([name]): (Strong / Adequate / Weak — 1–2 sentences)
AOK 2 ([name]): (Strong / Adequate / Weak — 1–2 sentences)
Cross-AOK comparison: (Has the student genuinely compared how the two AOKs illuminate the KQ differently?)

### Top 5 Priority Improvements Before Submission
(Ranked by impact on final mark — most impactful first)
1.
2.
3.
4.
5.

---
*This review is AI-assisted and based on IBHighway TOK Diary entries. Always verify against the official IB TOK Guide and consult your teacher before submission.*`;
}

// ─── FASTIFY ROUTE REGISTRATION ──────────────────────────────────────────────

module.exports = async function tokDiaryRoutes(app) {

  // POST /api/tok-review — per-stage, per-question AI feedback
  app.post('/tok-review', async (req, reply) => {
    const { stage, studentInput, anchorData, geminiKey } = req.body || {};
    if (!geminiKey)
      return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!stage || !studentInput)
      return reply.code(400).send({ error: 'Missing fields: stage, studentInput required' });

    try {
      const prompt = buildPerQuestionPrompt(stage, studentInput, anchorData || {});
      const result = await callGemini(geminiKey, prompt, 2000);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/tok-generate — full 6-stage review document
  app.post('/tok-generate', async (req, reply) => {
    const { allStageData, anchorData, geminiKey } = req.body || {};
    if (!geminiKey)
      return reply.code(400).send({ error: 'No Gemini key provided' });

    try {
      const prompt = buildFullReviewPrompt(allStageData || {}, anchorData || {});
      const result = await callGemini(geminiKey, prompt, 3000);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

};
