// ─── ADAPTIVE LEARNING ROUTES ────────────────────────────────────────────────
// All Stage 1–4 prompt templates live here on Railway — never sent to the
// browser. The client sends only structured student data (profile fields,
// chat history, answers) + the student's own Gemini key.
//
// POST /api/adaptive  body: { action, params, history, maxTokens?, geminiKey }
//   action: sim | s1-chat | s1-extract | s2-plan | s3-chat |
//           s4-questions | s4-eval | s4-report
//   history: [{role:'user'|'model', text}] — only used by chat actions,
//            sent as Gemini contents while the prompt goes in
//            systemInstruction (avoids the old prompt-drop bug entirely).

const MODELS = [
  { model: 'gemini-3.5-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-pro',        api: 'v1beta' },
  { model: 'gemini-3.1-flash',      api: 'v1beta' },
  { model: 'gemini-3.1-flash-lite', api: 'v1beta' },
  { model: 'gemini-2.5-pro',        api: 'v1beta' },
  { model: 'gemini-2.5-flash',      api: 'v1beta' },
  { model: 'gemini-2.5-flash-lite', api: 'v1beta' },
];

async function callGemini(geminiKey, prompt, history, maxTokens) {
  let contents;
  let systemInstruction = null;
  if (Array.isArray(history) && history.length > 0) {
    const h = history
      .map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text || '') }] }))
      .filter(m => m.parts[0].text);
    while (h.length && h[0].role === 'model') h.shift();
    while (h.length && h[h.length - 1].role === 'model') h.pop();
    contents = h.length ? h : [{ role: 'user', parts: [{ text: 'Begin.' }] }];
    systemInstruction = { parts: [{ text: prompt }] };
  } else {
    contents = [{ role: 'user', parts: [{ text: prompt }] }];
  }

  for (const m of MODELS) {
    const url = `https://generativelanguage.googleapis.com/${m.api}/models/${m.model}:generateContent`;
    try {
      const body = { contents, generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8 } };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify(body)
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

const s = v => String(v ?? '');
const arr = v => (Array.isArray(v) ? v : []);

// ─── Prompt builders (verbatim templates from the old client) ────────────────

function simPrompt(p) {
  const tutorText = s(p.tutorText).substring(0, 500);
  const topic = s(p.topic) || 'this concept';
  const hobbies = s(p.hobbies) || 'everyday life';
  return `You are an expert at creating educational HTML5 Canvas animations.
A tutor just explained this to a student: "${tutorText}"
Topic: ${topic}
Student's interests: ${hobbies}

Create a self-contained HTML page with a Canvas animation that visually simulates what the tutor described.
STRICT REQUIREMENTS:
- Return a complete HTML document starting with <!DOCTYPE html>
- Canvas size: width=380 height=200
- Use requestAnimationFrame for smooth animation
- Background: #f1f5f9
- Colors: use #2563EB (blue), #16a34a (green), #dc2626 (red), #d97706 (amber), #94a3b8 (gray)
- Add a short label at bottom (12px, #64748b) describing what is shown
- Keep total code under 3000 characters
- No external libraries, pure vanilla JS Canvas API
- The animation must MOVE — objects must animate, not be static
- Base the visual on the student's interest: if hobbies include cricket, use a cricket ball; if gaming, use a game character; etc.
Return ONLY the complete HTML document. Nothing else. No markdown. Start with <!DOCTYPE html>.`;
}

function s1ChatPrompt(p) {
  const name = s(p.name) || 'Student';
  const hobbiesLine = p.hobbies ? `Hobbies and interests: ${s(p.hobbies)}` : '';
  const dislikesLine = p.dislikes ? `Things they dislike (NEVER use as examples): ${s(p.dislikes)}` : '';
  return `You are a friendly, curious learning companion having a short conversation with ${name} (${s(p.grade)} level, studying ${s(p.subj)}).
Your goal: quickly understand how ${name} thinks and what they know — in as few exchanges as possible.
Syllabus topics: ${s(p.syllabus) || 'Not provided.'}
${hobbiesLine}
${dislikesLine}

HOW TO BEHAVE:
- Sound like a curious friend, not an examiner. Ask ONE natural question at a time.
- Keep your messages SHORT — 1-2 sentences maximum. Never lecture.
- Use their hobbies to make questions feel relevant and fun.
- Cover: what they know, what confuses them, how they like to learn, their confidence level.

SMART COMPLETION RULE:
End the conversation as soon as you have enough to build a profile (usually 4-6 good exchanges).
8 exchanges is the absolute maximum.
When done, wrap up warmly in ONE sentence, then on a new line write exactly: SESSION_COMPLETE

FORMAT: Plain spoken English only. No asterisks, no symbols. Short responses.`;
}

function s1ExtractPrompt(p, history) {
  const name = s(p.name) || 'Student';
  const conv = arr(history).map(m => `${m.role === 'user' ? name : 'Tutor'}: ${s(m.text)}`).join('\n');
  return `Extract a structured learning profile from this conversation with ${name} (${s(p.subj)}, ${s(p.grade)}).
Conversation: ${conv}

Return ONLY valid JSON:
{"student":"${name}","subject":"${s(p.subj)}","grade":"${s(p.grade)}","hobbies":"${s(p.hobbies)}","dislikes":"${s(p.dislikes)}","summaryParagraph":"3-4 sentences","overallScore":2.5,"overallLevel":"Developing","learningStyle":"verbal|visual|example-based|story-based|logical-sequential","strongestDimension":"","growthArea":"","weakTopics":[],"knownTopics":[],"keyQuotes":[],"focusRecommendations":[{"area":"","action":"","why":""}],"rubricScores":{"explanation_of_issues":{"score":2,"observation":"","parentFriendly":""},"evidence_and_reasoning":{"score":2,"observation":"","parentFriendly":""},"context_awareness":{"score":2,"observation":"","parentFriendly":""},"problem_definition":{"score":2,"observation":"","parentFriendly":""},"solution_design":{"score":2,"observation":"","parentFriendly":""},"inquiry_and_curiosity":{"score":2,"observation":"","parentFriendly":""},"creative_synthesis":{"score":2,"observation":"","parentFriendly":""},"metacognition":{"score":2,"observation":"","parentFriendly":""}}}`;
}

function s2PlanPrompt(params) {
  const p = params.profile || {};
  const rs = p.rubricScores || p.rubric || {};
  const scores = Object.entries(rs).map(([k, v]) => `${k}: ${(v && v.score) || 1}/4`).join(', ');
  const weakList = arr(p.weakTopics).join(', ') || 'not identified';
  const knownList = arr(p.knownTopics).join(', ') || 'none';
  const focusList = JSON.stringify(p.focusRecommendations || []);
  return `You are an expert instructional designer. Generate a personalised content plan.
STUDENT PROFILE:
Name: ${s(p.student) || 'Student'}, Subject: ${s(p.subject) || 'General'}, Grade: ${s(p.grade) || 'middle'}
Overall: ${p.overallScore || 0}/4 (${s(p.overallLevel) || '—'}), Learning style: ${s(p.learningStyle) || 'unknown'}
Strongest dimension: ${s(p.strongestDimension) || '—'}, Growth area: ${s(p.growthArea) || '—'}
Rubric scores: ${scores}
Hobbies: ${s(p.hobbies) || 'not specified'} — ALL teaching angles must use these
Dislikes: ${s(p.dislikes) || 'none'} — never use these

WHAT THIS STUDENT NEEDS:
Weak topics: ${weakList}
Already knows: ${knownList}
Focus areas: ${focusList}

CRITICAL RULE: You must ONLY create learning entries for the weak topics listed. Do NOT add other topics.

MODALITIES: analogy, story, diagram, worked example, simulation, socratic conversation, real-world scenario, reflection prompt, visual map, step-by-step walkthrough, debate/counterargument

Return ONLY valid JSON, no markdown:
{"student":"","subject":"","planSummary":"","learningSequence":[{"order":1,"topic":"","priority":"high|medium|review","why":"","primaryRepresentation":"","primaryRationale":"","supportingRepresentations":["",""],"teachingAngle":"","estimatedSessions":1}],"globalStrategies":[]}`;
}

function s3ChatPrompt(p) {
  const name = s(p.name) || 'Student';
  const topic = s(p.topic) || 'this topic';
  const rep = s(p.rep) || 'conversation';
  const hobbies = s(p.hobbies);
  const persona = `You are ${name}'s personal tutor — warm, witty, and deeply attentive.
What you know about ${name}:
- Learning style: ${s(p.style) || 'verbal'}, Current level: ${s(p.level) || 'Developing'}
- Strongest thinking skill: ${s(p.strong) || 'curiosity'}, Area to grow: ${s(p.growth) || 'problem definition'}
- Topics they find hard: ${s(p.weakTopics) || 'not specified'}
- Hobbies and interests: ${hobbies || 'not specified'} ← USE THESE for all analogies
- Things they dislike: ${s(p.dislikes) || 'none'} ← NEVER reference these
- Something they said earlier: "${s(p.keyQuote) || 'showed real curiosity'}"
- Global teaching strategies: ${s(p.gs) || 'be patient, use concrete examples'}`;

  const phase = s(p.phase);
  if (phase === 'open') return `${persona}
Now teach "${topic}" using the "${rep}" approach.
Teaching angle: ${s(p.teachingAngle) || 'connect to something real in their life first.'}
RULES: Max 3 sentences of teaching. End with ONE short question. Total: 4-5 sentences MAX. No preamble.`;

  if (phase === 'respond') return `${persona}
You are mid-lesson teaching "${topic}" using "${rep}".
Adapt: understood well → go deeper | confused → concrete example | disengaged → surprising fact.
Max 3 sentences. ONE question at end. No compliments — just keep the conversation moving.`;

  if (phase === 'check') return `${persona}
Drop a natural real-world scenario or "what do you think would happen if…" question about "${topic}".
Do NOT say "let me check your understanding." Use their interests: ${hobbies || 'everyday life'}.
After their answer: if correct → celebrate warmly, summarise. If not → say "almost — here's the bit that trips most people up".`;

  if (phase === 'switch') return `${persona}
${name} asked for a different explanation of "${topic}". Switch completely to the "${rep}" approach.
Do not repeat anything already said. Start from a fresh angle. Acknowledge the switch naturally.`;

  if (phase === 'hint') return `${persona}
${name} needs a hint on "${topic}".
Give ONE warm encouraging sentence pointing them toward the answer without giving it away.`;

  return null;
}

function s4QuestionsPrompt(p) {
  const count = Math.min(8, Math.max(Number(p.count) || 3, 3));
  return `Design ${count} working assessment questions for ${s(p.name) || 'Student'} (${s(p.grade) || 'middle'}).
Subject being assessed: ${s(p.subj) || 'General'}
Topics actually studied: ${s(p.topics)}
Student interests to use in ALL scenarios: ${s(p.hobbies) || 'everyday life around them'}
Never reference: ${s(p.dislikes) || 'nothing'}

Each question must require the student to WORK — calculate, reason step-by-step, predict with explanation, or apply a concept to a novel situation. No recall or MCQ questions.

Return ONLY a valid JSON array — no markdown:
[{"topic":"","questionText":"2-3 sentence scenario question grounded in student interests","questionType":"calculation|prediction|explanation|application","hasEquation":false,"equation":"","imagePrompt":"vivid 1-sentence prompt for educational illustration using student interests","imageCaption":"","workingRequired":true,"hint1":"","hint2":"","hint3":"","expectedKeywords":[]}]`;
}

function s4EvalPrompt(p) {
  const q = p.q || {};
  const isLast = !!p.isLast;
  return `Evaluate ${s(p.name) || 'Student'}'s answer on ${s(p.subj) || 'General'}.
Question: ${s(q.questionText)}
Type: ${s(q.questionType)}
Key concepts expected: ${arr(q.expectedKeywords).join(', ')}
Hints used: ${Number(p.hintsUsed) || 0}/3
Answer: ${s(p.answerText)}

Give:
- feedbackText: 1-2 sentences — specific, warm, what they got right and one thing to improve. No grades.
- rubricScores: score each dimension 1-4: explanation_of_issues, evidence_and_reasoning, context_awareness, problem_definition, solution_design, inquiry_and_curiosity, creative_synthesis, metacognition
- conceptUnderstood: "yes"|"partial"|"no"

${isLast ? 'After feedback write: ASSESSMENT_COMPLETE' : `Then introduce the next question about "${s(p.nextTopic)}" using student interests (${s(p.hobbies)}):`}

Return ONLY valid JSON:
{"feedbackText":"","rubricScores":{"explanation_of_issues":1,"evidence_and_reasoning":1,"context_awareness":1,"problem_definition":1,"solution_design":1,"inquiry_and_curiosity":1,"creative_synthesis":1,"metacognition":1},"conceptUnderstood":"yes","nextQuestionIntro":""}`;
}

function s4ReportPrompt(p) {
  return `Generate final assessment report for ${s(p.name) || 'Student'} on ${s(p.subj) || 'General'}.
Per-question results: ${JSON.stringify(p.questionScores || [])}
Stage 1 rubric scores (before learning): ${JSON.stringify(p.stage1scores || {})}
Transcript excerpt: ${s(p.tx).substring(0, 2000)}

Return ONLY valid JSON:
{"overallScore":2,"overallLevel":"Developing","summaryParagraph":"3-4 warm honest sentences","topicScores":[{"topic":"","score":2,"level":"Milestone 2","observation":"","hintsUsed":0}],"rubricScores":{"explanation_of_issues":{"score":2,"observation":"","parentFriendly":""},"evidence_and_reasoning":{"score":2,"observation":"","parentFriendly":""},"context_awareness":{"score":2,"observation":"","parentFriendly":""},"problem_definition":{"score":2,"observation":"","parentFriendly":""},"solution_design":{"score":2,"observation":"","parentFriendly":""},"inquiry_and_curiosity":{"score":2,"observation":"","parentFriendly":""},"creative_synthesis":{"score":2,"observation":"","parentFriendly":""},"metacognition":{"score":2,"observation":"","parentFriendly":""}},"growthFromStage1":[{"dimension":"","before":2,"after":2,"note":""}],"strongestTopic":"","weakestTopic":"","readyForNextCycle":true,"nextCycleRecommendation":""}`;
}

function s3SummaryPrompt(p) {
  return `Write a warm 3-sentence summary of this learning session for ${s(p.name) || 'the student'}. Topics: ${s(p.topics)}. Total exchanges: ${Number(p.exchanges) || 0}.`;
}

// action → { build(params, history), defaultMaxTokens, usesHistory }
const ACTIONS = {
  'sim':          { build: (p) => simPrompt(p),            max: 4000, chat: false },
  's1-chat':      { build: (p) => s1ChatPrompt(p),         max: 1200, chat: true  },
  's1-extract':   { build: (p, h) => s1ExtractPrompt(p, h),max: 8000, chat: false },
  's2-plan':      { build: (p) => s2PlanPrompt(p),         max: 8000, chat: false },
  's3-chat':      { build: (p) => s3ChatPrompt(p),         max: 1200, chat: true  },
  's3-summary':   { build: (p) => s3SummaryPrompt(p),      max: 300,  chat: false },
  's4-questions': { build: (p) => s4QuestionsPrompt(p),    max: 4000, chat: false },
  's4-eval':      { build: (p) => s4EvalPrompt(p),         max: 1000, chat: false },
  's4-report':    { build: (p) => s4ReportPrompt(p),       max: 8000, chat: false },
};

const { requireStudent } = require('../student-auth');

module.exports = async function adaptiveRoutes(app) {
  // POST /api/adaptive
  app.post('/', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
  }, async (req, reply) => {
    const student = await requireStudent(req, reply, 2);
    if (!student) return;
    const { action, params, history, maxTokens, geminiKey } = req.body || {};
    if (!geminiKey) return reply.code(400).send({ error: 'No Gemini key provided' });
    const a = ACTIONS[action];
    if (!a) return reply.code(400).send({ error: 'Unknown action' });
    if (history && (!Array.isArray(history) || history.length > 80)) {
      return reply.code(400).send({ error: 'Invalid history' });
    }

    const prompt = a.build(params || {}, history || []);
    if (!prompt) return reply.code(400).send({ error: 'Could not build prompt (bad params)' });

    try {
      const result = await callGemini(
        geminiKey,
        prompt,
        a.chat ? (history || []) : [],
        Math.min(Number(maxTokens) || a.max, 8192)
      );
      return reply.send(result);
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });
};
