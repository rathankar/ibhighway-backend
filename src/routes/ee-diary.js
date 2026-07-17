// ─── EE DIARY ROUTES ─────────────────────────────────────────────────────────
// Prompts live here on Railway — never sent to the browser.
// Student's own Gemini key is passed in the request body and never stored.
// Per-question AI feedback: every question the student answers gets individual
// targeted critique, not just stage-level overview.

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
// The locked RQ from Stage 2 is the spine. Every stage checks against it.

function getAnchorBlock(anchorData) {
  const rq  = (anchorData?.rq  || '').trim();
  const hyp = (anchorData?.hypothesis || '').trim();
  const pathway = (anchorData?.pathway || '').trim();
  if (!rq) return '';
  let block = `\nLOCKED ANCHOR (must not change across stages):\nResearch Question: ${rq}`;
  if (hyp) block += `\nHypothesis / Working Argument: ${hyp}`;
  if (pathway) block += `\nPathway: ${pathway}`;
  block += `\n\nBefore any other feedback, check explicitly: is the student's response consistent with the locked RQ above? If you detect drift, contradiction, or scope creep, name it specifically FIRST.\n`;
  return block;
}

// ─── SUBJECT CONTEXT ──────────────────────────────────────────────────────────

function getSubjectContext(subject) {
  return {
    Physics:
      'Apply IB Physics EE examiner standards. Check: SI units, uncertainty treatment (systematic vs random, percentage uncertainty propagation), physical reasoning quality, whether graphs are linearised where appropriate, and whether the gradient/intercept is interpreted in physical terms. Diagrams (circuit, ray diagram, free body diagram) must be correctly drawn and labelled.',
    Chemistry:
      'Apply IB Chemistry EE examiner standards. Check: chemical nomenclature precision, reaction mechanism clarity, units (mol/L, nm, K, J/mol), uncertainty propagation, comparison to literature values, and whether the analytical technique chosen matches the chemical system.',
    Biology:
      'Apply IB Biology EE examiner standards. Check: biological terminology, sample size (n ≥ 5 per group minimum), statistical methods (SD, t-test, ANOVA as appropriate), ethical treatment of living organisms, and whether variables are operationally defined.',
    ESS:
      'Apply IB ESS EE examiner standards. Check: systems thinking framework, reliability and provenance of environmental data, multiple perspectives (ecological, economic, social, ethical), appropriate scale (local/regional/global), and whether human-environment interactions are explicitly addressed.',
    'Language A':
      'Apply IB Language A EE examiner standards. Check: close textual evidence (direct quotation with page reference), literary terminology precision (not vague description), strength of interpretive argument, whether critical sources are engaged with rather than just cited, and whether the analysis goes beyond surface-level description.',
    'Language B':
      'Apply IB Language B EE examiner standards. Check: sociolinguistic or literary framework application, precision of linguistic terminology, corpus representativeness, cultural context integration, and whether the argument is analytical (not descriptive).',
    History:
      'Apply IB History EE examiner standards. Check: primary source evaluation (origin, purpose, value, limitation — OPCVL), historiographical awareness (named historians, named interpretations), use of specific historical evidence (dates, names, events), and whether the argument is evaluative not narrative.',
    Economics:
      'Apply IB Economics EE examiner standards. Check: correct economic model and diagram application (axes, labels, shifts), data analysis quality (trends, anomalies, comparison to theory), evaluation of assumptions and limitations, real-world application specificity, and whether stakeholder impacts are discussed.',
    Geography:
      'Apply IB Geography EE examiner standards. Check: spatial analysis quality, data presentation (maps, graphs, tables with labels), fieldwork methodology rigour, systems thinking at appropriate scale, and whether human and physical geography are integrated where relevant.',
    Mathematics:
      'Apply IB Mathematics EE examiner standards. Check: mathematical rigour and correctness of proofs/derivations, clarity of logical development, appropriate use of mathematical notation, whether personal engagement is genuinely evident, and whether the topic goes meaningfully beyond the IB syllabus.',
    Arts:
      'Apply IB Arts EE examiner standards. Check: analytical depth of formal/technical elements (not plot summary or vague description), strength and specificity of interpretive argument, appropriate critical framework application, and quality of specific textual/visual/musical evidence.',
    Psychology:
      'Apply IB Psychology EE examiner standards. Check: research methodology rigour, ethical compliance (consent, anonymity, debriefing), correct psychological terminology, statistical analysis appropriateness, and whether conclusions are justified by the evidence presented.',
    Philosophy:
      'Apply IB Philosophy EE examiner standards. Check: conceptual precision (define terms carefully), logical structure of arguments (premises → conclusion), quality of counter-argument engagement, clarity of distinctions, and whether the student takes and defends a position rather than merely surveying views.',
    'Computer Science':
      'Apply IB Computer Science EE examiner standards. Check: algorithm correctness, technical depth beyond surface description, quality of comparative analysis, appropriate use of Big-O and complexity notation, reproducibility of results, and whether ethical/social dimensions are acknowledged where relevant.',
    'Business Management':
      'Apply IB Business Management EE examiner standards. Check: correct application of BM frameworks (SWOT, Porter, BCG, Ansoff, etc.), quality and verifiability of primary and secondary data, balanced multi-stakeholder analysis, and whether conclusions are evidence-based rather than opinion-based.',
    'Global Politics':
      'Apply IB Global Politics EE examiner standards. Check: correct use of political concepts (power, sovereignty, legitimacy, human rights, etc.), quality of case study evidence, engagement with multiple theoretical perspectives (realism, liberalism, constructivism, etc.), and whether the argument is evaluative rather than descriptive.',
  }[subject] || 'Apply IB EE examiner standards: check conceptual precision, quality of evidence and analysis, coherence of argument, and whether the conclusion directly answers the research question.';
}

// ─── PER-QUESTION FEEDBACK FORMAT ────────────────────────────────────────────
// The key innovation: the frontend sends ALL question labels + student answers
// for the current stage. We give feedback question-by-question, then a stage summary.

function buildPerQuestionPrompt(subject, stage, studentInput, anchorData) {
  const anchor = getAnchorBlock(anchorData);
  const subjectCtx = getSubjectContext(subject);

  const stageCriterion = {
    'Topic Exploration & Brainstorm':  'Pre-assessment (feeds Criterion A: Framework)',
    'Research Question & Framework':   'Criterion A: Framework for the essay (6 marks)',
    'Literature Review & Knowledge':   'Criterion B: Knowledge and Understanding (6 marks)',
    'Analysis, Argument & Outline':    'Criterion C: Analysis and line of argument (6 marks)',
    'Discussion, Evaluation & Draft':  'Criterion D: Discussion and Evaluation (8 marks — highest weighted)',
    'Reflection (RPF)':                'Criterion E: Reflection (4 marks)',
  }[stage] || 'IB EE Assessment';

  const stageGuidance = {

    'Topic Exploration & Brainstorm': `
WHAT TO ASSESS IN THIS STAGE:
- Is the student's curiosity genuine and specific — or vague and generic?
- Is the topic sufficiently narrow for 4,000 words, and sufficiently rich for deep analysis?
- Does the topic connect authentically to the named subject, not just superficially?
- Is there a clear angle (compare, evaluate, challenge, analyse) emerging?
- Is the draft RQ seed specific enough to be refined into a strong RQ in Stage 2?
- For sciences: check whether the topic is experimentally/analytically feasible at school level.
- For humanities: check whether sufficient primary and secondary sources are likely to exist.
WATCH FOR: Topics that are too broad ("I want to study climate change"), too narrow (only one data point possible), or not genuinely about the subject claimed.`,

    'Research Question & Framework': `
WHAT TO ASSESS IN THIS STAGE:
- Is the finalised RQ clear, focused, and specific? Does it use "how", "why", or "to what extent"?
- Is the RQ arguable — can a reasonable person reach a different conclusion from the same evidence?
- For sciences: does the RQ name the IV and DV explicitly with appropriate context?
- For humanities: does the RQ invite evaluative analysis, not narrative description?
- Is the research method or approach appropriate for the subject and RQ?
- Is the essay structure logical — does it lead from RQ through evidence to conclusion?
- Is the word allocation realistic and appropriately distributed?
WATCH FOR: RQs that are too descriptive ("What is X?"), too broad ("How does globalisation affect society?"), or that cannot be answered within 4,000 words with available sources.
DIAGRAMS/GRAPHS NOTE: For sciences and economics, assess whether the student has planned for graphs, data tables, and diagrams in their structure. If not, flag this as a gap.`,

    'Literature Review & Knowledge': `
WHAT TO ASSESS IN THIS STAGE:
- Is the theoretical background accurate, precise, and directly relevant to the RQ?
- Are subject-specific concepts defined correctly using proper terminology?
- Are sources evaluated for reliability (not just listed)?
- Is there genuine engagement with the scholarly debate — do they engage with what scholars argue, not just what they found?
- For sciences: are equations correct, with all variables defined and conditions of applicability stated?
- For sciences: are uncertainties and limitations of the theoretical models acknowledged?
- For history: are primary sources evaluated using OPCVL or equivalent?
- For economics: are economic models applied correctly with diagrams planned?
WATCH FOR: Copied-and-pasted theory without understanding, failure to define terms, sources cited but not evaluated, and theoretical frameworks that are generic rather than specifically relevant to the RQ.
CRITICAL THINKING PROBE: Ask whether the student has identified where their theoretical model breaks down or has known limitations. Absence of this is a significant weakness.`,

    'Analysis, Argument & Outline': `
WHAT TO ASSESS IN THIS STAGE:
- Is there a clear, arguable thesis statement that directly answers the RQ?
- Does each body section make a distinct, logically connected claim?
- Is the line of argument coherent — does it move from RQ through evidence to conclusion?
- Is the counterargument engaged with seriously and rebutted with evidence?
- For sciences: is the data presented correctly with units, uncertainties, and uncertainty analysis? Are graphs described analytically (what does the gradient mean? what does the shape reveal?)?
- For sciences: is uncertainty propagation carried out? Are systematic and random errors distinguished?
- For humanities: are claims supported by specific textual or historical evidence (not paraphrase)?
- Is the conclusion draft a synthesis, not a summary?
WATCH FOR: Essays that list evidence without argument, conclusions that merely summarise instead of synthesise, counterarguments dismissed too quickly, and science work where graphs/data/uncertainties are absent or described without analytical interpretation.
DIAGRAMS/GRAPHS — MANDATORY CHECK FOR SCIENCES AND ECONOMICS:
If the student is studying Physics, Chemistry, Biology, ESS, or Economics, check explicitly:
(a) Have they described their data table structure with units and uncertainty columns?
(b) Have they described their graph axes, trend shape, and what the gradient or intercept represents?
(c) Have they calculated percentage uncertainties and identified the dominant source of error?
If any of these are missing, flag them as Priority Fixes — they directly determine Criterion C marks.`,

    'Discussion, Evaluation & Draft': `
WHAT TO ASSESS IN THIS STAGE:
- Does the conclusion directly and specifically answer the locked RQ? (Criterion D is worth 8 marks — the highest weight.)
- Does the discussion evaluate the significance of the findings, not just state them?
- Are limitations of the investigation specific and honest — with the effect of each limitation on the conclusion explained?
- Are improvements realistic and directly linked to identified limitations (not generic)?
- Is the essay balanced — does it give fair weight to evidence that complicates or challenges the thesis?
- Is the introduction complete — does it contextualise the topic, state the RQ, explain the method, outline the structure?
- For sciences: are systematic and random errors distinguished? Are improvements specific to the experimental setup?
- For economics: are stakeholder impacts evaluated? Is theory vs reality divergence explained?
- For history: does the conclusion synthesise the historiographical debate?
- For language: does the conclusion synthesise the interpretive argument rather than restating the introduction?
WATCH FOR: Conclusions that summarise instead of synthesise, limitations stated without explaining their effect, improvements that are vague ("use better equipment"), and discussions that are one-sided without engaging with counterevidence.`,

    'Reflection (RPF)': `
WHAT TO ASSESS IN THIS STAGE:
- Is the reflection EVALUATIVE (what changed, why it mattered) or merely DESCRIPTIVE (what I did)?
- Is the reflection specific to THIS investigation — or could it have been written about any EE?
- Are key decision points named with specific details (what changed, why, what the effect was)?
- Is there genuine intellectual growth described — something the student can now do or think that they could not before?
- Is the RPF draft within 500 words and focused on quality of reflection, not quantity?
- Do the reflections connect specifically to the locked RQ and the research process?
WATCH FOR: Generic reflections ("I learned time management"), descriptions of what was done rather than what was learned, reflections that do not connect to the specific investigation, and RPF statements that are too long with insufficient depth.
CRITERION E BANDS: 0 = no reflection / trivial; 1-2 = some reflection but largely descriptive; 3-4 = genuine evaluative reflection with specific intellectual growth. Predict the band and explain why.`,

  }[stage] || 'Apply IB EE examiner standards to each answer below.';

  return `You are an experienced IB Extended Essay examiner giving per-question feedback.

Subject: ${subject}
Stage: ${stage}
Criterion: ${stageCriterion}

${subjectCtx}
${anchor}
${stageGuidance}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STUDENT'S ANSWERS FOR THIS STAGE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${studentInput}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR RESPONSE FORMAT (STRICT — follow exactly):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Anchor Check
State explicitly: "Consistent with locked RQ." OR "INCONSISTENT — [specific mismatch]."

### Per-Question Feedback

For EACH numbered question the student has answered, provide:

**Q[N] — [question topic in 3-5 words]**
- Depth: (Excellent / Adequate / Superficial / Missing)
- Feedback: [2-4 sentences — specific critique, not generic. Name what is good and what is weak. For sciences: flag missing units, uncertainties, or graph descriptions. For humanities: flag missing evidence, vague claims, or absent critical engagement.]
- Fix: [One specific, actionable sentence: what exactly should the student add or change?]

(Repeat for every answered question. Skip unanswered questions — just note "Not yet answered.")

### Stage Overview
(Strong / Adequate / Weak — 2 sentences on the overall quality of this stage's work.)

### Top 3 Priority Fixes
(The three highest-impact corrections to raise the IB mark for this stage. Be specific — name the question number and the exact change needed.)

1.
2.
3.`;
}

// ─── FULL DOCUMENT REVIEW PROMPT ─────────────────────────────────────────────

function getFullDocumentPrompt(subject, allStageData, anchorData) {
  const rq  = (anchorData?.rq  || 'Not defined').trim();
  const hyp = (anchorData?.hypothesis || '').trim();
  const subjectCtx = getSubjectContext(subject);

  const stageOrder = [
    'Topic Exploration & Brainstorm',
    'Research Question & Framework',
    'Literature Review & Knowledge',
    'Analysis, Argument & Outline',
    'Discussion, Evaluation & Draft',
    'Reflection (RPF)'
  ];

  let stagesText = '';
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
${subjectCtx}

LOCKED RESEARCH QUESTION (from Stage 2): ${rq}
${hyp ? `LOCKED HYPOTHESIS/ARGUMENT: ${hyp}` : ''}

STUDENT'S EE WORK ACROSS ALL 6 STAGES:
${stagesText}

Produce a full examiner review document:

## IB EE Examiner Review — ${subject}

### Research Question Consistency Check
(Has the student maintained focus on the locked RQ throughout all stages? Name any specific stage where drift, contradiction, or scope creep occurred.)

---

### Criterion A: Framework for the essay (out of 6)
Estimated mark band: [X–Y / 6]
Strengths: (with reference to specific student work)
Areas for improvement: (specific, actionable)

### Criterion B: Knowledge and Understanding (out of 6)
Estimated mark band: [X–Y / 6]
Strengths:
Areas for improvement:
Terminology check: (Flag any subject-specific terms used incorrectly or imprecisely.)

### Criterion C: Analysis and Line of Argument (out of 6)
Estimated mark band: [X–Y / 6]
Strengths:
Areas for improvement:
${['Physics','Chemistry','Biology','ESS','Economics'].includes(subject) ? 'Diagrams/Data/Graphs check: (Are data tables, graphs with labelled axes and units, uncertainty analysis, and gradient/intercept interpretation present? Flag any missing elements — these directly determine Criterion C marks.)' : 'Evidence quality: (Is evidence specific, well-chosen, and analytically integrated — not just cited?)'}

### Criterion D: Discussion and Evaluation (out of 8) — HIGHEST WEIGHT
Estimated mark band: [X–Y / 8]
Strengths:
Areas for improvement:
Limitations check: (Are limitations specific and is their effect on the conclusion explained? Generic limitations score 0 here.)

### Criterion E: Reflection (out of 4)
Estimated mark band: [X–Y / 4]
Strengths:
Areas for improvement:
RPF band prediction: (0 / 1–2 / 3–4 — with specific reason)

---

### Overall Estimated Mark: [XX / 30]
(Predicted grade: [A / B / C / D / E])
Note: Criterion A=6, B=6, C=6, D=8 (highest weight), E=4. Total = 30 marks (current EE assessment model).

### Top 5 Priority Improvements Before Submission
(Ranked by impact on final mark — most impactful first)
1.
2.
3.
4.
5.

---
*This review is AI-assisted and based on IBHighway EE Diary entries. Always verify against the official IB EE Guide 2025 and consult your supervisor before submission.*`;
}

// ─── NEW (additive) — DIARY-ENGINE ROUTES ────────────────────────────────────
// Per-question Socratic feedback + strict foundation gate for the config-driven
// EE diary engine. These do NOT touch the ee-review / ee-generate prompts above.
// Current EE model: Criterion A Focus & Method /6, B Knowledge & Understanding /6,
// C Analysis & Line of Argument /6, D Discussion & Evaluation /8, E Reflection /4
// = 30, best-fit positive marking. Interdisciplinary essays combine a science with
// a second DP subject under one of five IB thematic frameworks; the framework
// itself is not graded, but genuine integration of the two disciplines is.

function _eeSpineBlock(spine) {
  spine = spine || {};
  var inter = !!spine.interdisciplinary;
  var b = "THE STUDENT'S EXTENDED ESSAY (their research foundation — every answer must be consistent with this):\n" +
          "Research Question: " + (spine.rq || '(not stated yet)') + "\n" +
          "Subject / Discipline: " + (spine.subject || '(not stated yet)');
  if (inter) {
    b += "\nApproach: INTERDISCIPLINARY" +
         "\nSecond Discipline: " + (spine.subject2 || '(not stated yet)') +
         "\nThematic Framework: " + (spine.framework || '(not chosen yet)');
  } else {
    b += "\nApproach: Single-subject";
  }
  b += "\nFocus & Method (methodology): " + (spine.methodology || '(not stated yet)') +
       "\nKnowledge & Literature base: " + (spine.literature || '(not stated yet)');
  return b;
}

function getEEQuestionFeedbackPrompt(subject, section, questionLabel, answer, spine) {
  spine = spine || {};
  var inter = !!spine.interdisciplinary;
  var interNote = inter ? ("\nThis is an INTERDISCIPLINARY Extended Essay combining " + subject + " with " +
    (spine.subject2 || 'a second discipline') + " under one of the five IB interdisciplinary frameworks (Power, Equality, Justice; Culture, Identity, Expression; Movement, Time, Space; Evidence, Measurement, Innovation; Sustainability, Development, Change) \u2014 NOT the older 'World Studies' global themes. Their chosen framework: \"" + (spine.framework || '(framework not chosen yet)') +
    "\". A distinctive requirement applies: the essay must genuinely INTEGRATE both disciplines — using the concepts, methods and terminology of BOTH — and must justify why an interdisciplinary approach is necessary rather than a single subject. Where the answer should draw on both disciplines but uses only one, that imbalance is the most important thing to raise. The choice of framework itself is not graded, but integration of the two subjects is central to Criteria A, B and C.") : "";
  return "You are an experienced IB Extended Essay examiner giving feedback on ONE answer in a student's EE, applying the current EE assessment criteria (Criterion A Focus and Method /6, B Knowledge and Understanding /6, C Analysis and Line of Argument /6, D Discussion and Evaluation /8, E Reflection /4; total 30, best-fit positive marking).\n\n" +
    _eeSpineBlock(spine) + "\n" + interNote + "\n\n" +
    "Section: " + section + "\n" +
    "Question: " + questionLabel + "\n" +
    "Student's answer: " + answer + "\n\n" +
    "FIRST, silently check coherence: does this answer fit the research question, discipline" + (inter ? "s" : "") + " and method above? A common serious mistake is an answer that drifts from the locked research question, is merely descriptive/narrative where analysis is required, or " + (inter ? "leans on only one of the two disciplines when both are needed" : "strays outside the subject") + ". If the answer is inconsistent with the foundation above, that inconsistency is the MOST important thing to raise.\n\n" +
    "Then reply in EXACTLY these three labelled sections, in this order, plain text only (no #, no *, no bullets):\n\n" +
    "WHAT IS INCORRECTLY SPECIFIED:\n(What is wrong, unclear, missing, or — most importantly — inconsistent with the research question / discipline / method. Be specific. If nothing is wrong and it is fully consistent, write: Nothing — this answer is correct and consistent with your research question.)\n\n" +
    "WHAT IS REQUIRED:\n(What this answer needs to satisfy the relevant EE criterion — describe the TYPE of content or analytical move needed, not the content itself.)\n\n" +
    "HINT:\n(One or two guiding questions or pointers that lead the student to work it out themselves. NEVER give or write the correct answer — make the student think.)\n\n" +
    "If the answer is not a genuine attempt — random characters, filler, a single word, or clearly off-topic — say so plainly in WHAT IS INCORRECTLY SPECIFIED and do NOT invent praise, analysis, or a real answer; simply tell the student to write a real response to the question.\n\n" +
    "Keep each section to 1-3 sentences. If the answer is fully correct and consistent with the foundation, end your whole reply with the exact tag [COMPLETE].";
}

function getEEFoundationVerifyPrompt(subject, spine) {
  spine = spine || {};
  var inter = !!spine.interdisciplinary;
  var interCheck = inter ? ("\n- Is the interdisciplinary pairing (" + subject + " + " + (spine.subject2 || 'second discipline') +
    ") genuinely justified — does the question actually NEED both disciplines, and is the chosen thematic framework \"" + (spine.framework || '(none)') +
    "\" appropriate?\n- Can BOTH disciplines' methods realistically be applied to answer this question?") : "";
  return "You are a strict IB Extended Essay examiner reviewing the FOUNDATION of a student's essay before they build the rest on it (Criterion A Focus and Method, and the knowledge base for Criterion B). If this foundation is flawed, everything built on it will be flawed.\n\n" +
    _eeSpineBlock(spine) + "\n\n" +
    "Judge whether this foundation is sound enough to build a full 4,000-word Extended Essay on. Check:\n" +
    "- Is the research question clear, focused, arguable, and answerable within 4,000 words at school level (not too broad, not merely descriptive)?\n" +
    "- Is the discipline appropriate, and does the RQ sit genuinely within it?\n" +
    "- Is the Focus & Method (approach/methodology) explicitly suitable for the question and feasible?\n" +
    "- Is there a real knowledge/literature base to ground the essay in scholarly discourse?\n" +
    "- Is everything internally consistent, with no drift between RQ, discipline and method?" + interCheck + "\n\n" +
    "Reply in plain text only (no #, no *, no bullets), in exactly this shape:\n\n" +
    "VERDICT: PASS   (use PASS only if the foundation is genuinely sound and internally consistent; otherwise use ISSUES)\n\n" +
    "PROBLEMS:\n(If ISSUES: a numbered list — 1., 2., 3. — of the specific foundational problems, each 1-2 sentences, most serious first. If PASS: write \"None — the foundation is sound and internally consistent.\")\n\n" +
    "Describe the problems only. Do NOT rewrite the research question or provide corrected answers — the student must fix these themselves.";
}

function getEEBrainstormPrompt(subject, interest, secondSubject, framework) {
  return "You are an encouraging IB Extended Essay supervisor helping a student brainstorm an INTERDISCIPLINARY EE that pairs " + subject + " (their science) with a SECOND Diploma Programme subject.\n\n" +
    "The IB interdisciplinary EE registers under ONE of five thematic frameworks (these, NOT the older 'World Studies' global themes): 1) Power, Equality, Justice; 2) Culture, Identity, Expression; 3) Movement, Time, Space; 4) Evidence, Measurement, Innovation; 5) Sustainability, Development, Change. The framework itself is not graded, but genuine INTEGRATION of the two subjects is central to Criteria A, B and C.\n\n" +
    "The student's stated interest: " + (interest || '(not stated yet)') + "\n" +
    (secondSubject ? "Second subject they are considering: " + secondSubject + "\n" : "") +
    (framework ? "Framework they picked: " + framework + "\n" : "") + "\n" +
    "Help them with HINTS (guide them, do NOT decide for them). Reply in plain text (no #, no *, no bullets) in these labelled parts:\n\n" +
    "POSSIBLE SUBJECT PAIRINGS:\n(Suggest 2-3 second DP subjects that pair naturally with " + subject + " for this interest, each with one sentence on what that discipline would add. Where it fits, include a second science — e.g. Physics with Biology, or Chemistry with Biology.)\n\n" +
    "BEST-FIT FRAMEWORK:\n(Name the one or two of the five frameworks that suit this interest, and why in one sentence each.)\n\n" +
    "TOPIC ANGLES TO EXPLORE:\n(Two or three example directions phrased as questions the student could pursue — hints, not a finished research question. Each must clearly need BOTH disciplines.)\n\n" +
    "QUESTIONS TO ASK YOURSELF:\n(Pose these guiding questions adapted to their interest: what aspect really interests you; why is an interdisciplinary approach necessary; which framework fits; which two DP subjects integrate logically.)\n\n" +
    "Keep it concise and encouraging. Do NOT write a final research question for them — the choice stays with the student.";
}

function getEEBrainstormChatPrompt(subject, framework, history, turnCount) {
  var proposeRQ = (turnCount || 0) >= 10;
  var transcript = (history || []).map(function(m){ return (m.role === 'student' ? 'Student: ' : 'Bot: ') + m.text; }).join('\n');
  return "You are a warm, encouraging brainstorming bot helping an IB student develop an INTERDISCIPLINARY Extended Essay that pairs " + subject + " (their science) with a SECOND Diploma Programme subject.\n" +
    (framework ? "They are exploring the framework: " + framework + ".\n" : "") +
    "The five IB interdisciplinary frameworks are: Power, Equality, Justice; Culture, Identity, Expression; Movement, Time, Space; Evidence, Measurement, Innovation; Sustainability, Development, Change (these five ONLY — never the old 'World Studies' global themes).\n" +
    "Ask SHORT, focused questions ONE AT A TIME to draw out, over the course of the chat: what genuinely interests them; which second DP subject pairs well and why; which of the five frameworks fits; why an interdisciplinary approach is genuinely necessary (not just two subjects they like); feasibility and available sources or methods; and finally a specific, narrow angle. Adapt each question to their previous answer. Ask only ONE question per reply. Keep each reply to 2-4 sentences, warm and plain — no markdown, no bullet points, no headings.\n" +
    (proposeRQ
      ? "You have now asked enough questions. Based on everything the student has said, propose ONE clear, focused, arguable interdisciplinary research question suitable for an Extended Essay that genuinely integrates " + subject + " with the second subject. Start your reply with 'RESEARCH QUESTION:' followed by the question on the same line. Then, on new lines, name the two subjects and the chosen framework, and add one sentence of encouragement."
      : "Do not propose a final research question yet — just ask the next single most useful question based on what the student has said so far.") +
    "\n\nConversation so far:\n" + (transcript || '(none yet — open with a warm greeting and your first question)') + "\n\nBot:";
}

// ─── FASTIFY ROUTE REGISTRATION ──────────────────────────────────────────────

const { requireStudent, checkDiaryRun, useDiaryRun } = require('../student-auth');
const RL = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

module.exports = async function eeDiaryRoutes(app) {

  // POST /api/ee-review — per-stage, per-question feedback
  app.post('/ee-review', RL(30), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, stage, studentInput, anchorData, geminiKey } = req.body || {};
    if (!geminiKey)
      return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !stage || !studentInput)
      return reply.code(400).send({ error: 'Missing fields: subject, stage, studentInput required' });

    try {
      const prompt = buildPerQuestionPrompt(subject, stage, studentInput, anchorData || {});
      const result = await callGemini(geminiKey, prompt, 2000);
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ee-generate — full 6-stage review document
  app.post('/ee-generate', RL(10), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, allStageData, anchorData, geminiKey } = req.body || {};
    if (!geminiKey)
      return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject)
      return reply.code(400).send({ error: 'Missing subject' });

    // Shared IA/EE/TOK run cap — server-side enforcement.
    const runs = await checkDiaryRun(student.code);
    if (runs.blocked) {
      return reply.code(429).send({ error: 'You have used all of your diary generations (shared across IA, EE, and TOK Diary). This limit does not reset automatically.' });
    }

    try {
      const prompt = getFullDocumentPrompt(subject, allStageData || {}, anchorData || {});
      const result = await callGemini(geminiKey, prompt, 3000);
      const run = await useDiaryRun(student.code);
      return reply.send({ ...result, runMessage: run.message || run.error || null });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });


  // POST /api/ee-question-feedback — Socratic feedback on a SINGLE answer (diary engine)
  app.post('/ee-question-feedback', RL(40), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, section, questionLabel, answer, spine, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !questionLabel || !answer) return reply.code(400).send({ error: 'Missing fields' });
    try {
      const prompt = getEEQuestionFeedbackPrompt(subject, section || '', questionLabel, answer, spine || {});
      const result = await callGemini(geminiKey, prompt, 1500);
      const text = (result.text || '');
      const complete = /\[COMPLETE\]/i.test(text);
      return reply.send({ text: text.replace(/\[COMPLETE\]/ig, '').trim(), model: result.model, complete });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // POST /api/ee-foundation-verify — strict check of RQ + discipline(s) + method + literature base
  app.post('/ee-foundation-verify', RL(20), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, spine, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject || !spine) return reply.code(400).send({ error: 'Missing fields' });
    try {
      const prompt = getEEFoundationVerifyPrompt(subject, spine || {});
      const result = await callGemini(geminiKey, prompt, 1500);
      const text = (result.text || '');
      const pass = /VERDICT:\s*PASS/i.test(text);
      return reply.send({ text: text.trim(), pass, model: result.model });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });


  // POST /api/ee-interdisciplinary-brainstorm — hints for choosing a 2nd subject + topic
  app.post('/ee-interdisciplinary-brainstorm', RL(30), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, interest, secondSubject, framework, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject) return reply.code(400).send({ error: 'Missing subject' });
    try {
      const prompt = getEEBrainstormPrompt(subject, interest || '', secondSubject || '', framework || '');
      const result = await callGemini(geminiKey, prompt, 1500);
      return reply.send({ text: (result.text || '').trim(), model: result.model });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });


  // POST /api/ee-brainstorm-chat — multi-turn interdisciplinary brainstorming bot.
  // Asks up to 10 adaptive questions; from turn 10 it proposes the research question.
  app.post('/ee-brainstorm-chat', RL(40), async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { subject, framework, conversationHistory, turnCount, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    if (!subject) return reply.code(400).send({ error: 'Missing subject' });
    try {
      const prompt = getEEBrainstormChatPrompt(subject, framework || '', conversationHistory || [], turnCount || 0);
      const result = await callGemini(geminiKey, prompt, 1200);
      const text = (result.text || '').trim();
      const isRQ = /RESEARCH QUESTION:/i.test(text);
      return reply.send({ text, isRQ, model: result.model });
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

};
