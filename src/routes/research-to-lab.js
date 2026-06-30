// research-to-lab.js — IBHighway backend route
// POST /api/research-to-lab  — find papers + generate IB-feasible RQs

const MODELS = [
  { model: 'gemini-2.5-flash',      api: 'v1beta' },
  { model: 'gemini-2.5-pro',        api: 'v1beta' },
  { model: 'gemini-2.0-flash',      api: 'v1beta' },
  { model: 'gemini-1.5-pro',        api: 'v1beta' },
  { model: 'gemini-1.5-flash',      api: 'v1beta' },
];

const IB_SUBJECTS = ['Physics', 'Chemistry', 'Biology', 'ESS'];

const IB_SYLLABUS_CHECK = `You are an IB examiner and curriculum expert. 
Determine if the following research topic/paper is within the IB Diploma Programme syllabus for Physics, Chemistry, Biology, or ESS (Environmental Systems & Societies).

OUTSIDE IB SYLLABUS (reject these):
- Quantum field theory, particle physics beyond basic nuclear
- Rocket propulsion, aerospace engineering  
- Advanced organic synthesis beyond IB Chemistry
- Genetic engineering / CRISPR at research level
- Astrophysics beyond IB scope (black holes, gravitational waves)
- Any topic requiring equipment costing >$500 or specialist university facilities

WITHIN IB SYLLABUS (accept these):
- Mechanics, waves, electricity, magnetism, thermodynamics, optics (Physics)
- Acids/bases, kinetics, equilibrium, electrochemistry, organic basics (Chemistry)  
- Cell biology, ecology, genetics basics, physiology (Biology)
- Climate, biodiversity, pollution, sustainability (ESS)

Respond with JSON only:
{"within_syllabus": true/false, "subject": "Physics|Chemistry|Biology|ESS|Unknown", "reason": "one sentence", "core_concept": "the IB topic this maps to"}`;

const RQ_GENERATION = (topic, paperSummary, subject) => `You are an experienced IB ${subject} teacher helping students develop original Internal Assessment ideas.

A student is interested in this research area: "${topic}"

Here is a summary of relevant published research in this area:
${paperSummary}

Your task: Generate 6 distinct, original Research Questions that a student could investigate in a school lab, inspired by (but NOT copying) this research.

STRICT REQUIREMENTS for each RQ:
1. Must be answerable with standard school lab equipment (no specialist instruments)
2. Must be safe (no toxic chemicals, no high voltages, no hazardous organisms)
3. Must be completable in 3-5 lab sessions
4. Must have a clear, measurable independent variable and dependent variable
5. Must be within IB ${subject} syllabus
6. Must NOT be answerable by simply looking up data — must require real experimental work
7. Each RQ must be genuinely different from the others

For each RQ provide:
- rq: the full research question (starts with "How does..." or "To what extent does..." or "What is the effect of...")
- iv: independent variable
- dv: dependent variable  
- method_hint: one sentence on how to measure the DV
- equipment: 3-5 key pieces of equipment needed (all available in a school lab)
- difficulty: Easy / Medium / Challenging
- why_ib: one sentence on which IB ${subject} syllabus topic this connects to
- feasibility_score: 1-10 (10 = easiest to do in school lab)

Return ONLY a JSON array of 6 objects. No markdown, no explanation.`;

async function callGemini(prompt, geminiKey, useSearch = false) {
  let lastError = null;
  for (const m of MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/${m.api}/models/${m.model}:generateContent?key=${geminiKey}`;
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8000 }
      };
      if (useSearch) {
        body.tools = [{ googleSearch: {} }];
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts;
        if (parts) {
          const text = parts.map(p => p.text || '').join('');
          if (text) return { text, model: m.model };
        }
      }
      const errData = await res.json().catch(() => ({}));
      lastError = errData.error?.message || `HTTP ${res.status}`;
      const modelIssue = ['deprecated','not found','does not exist','quota','unavailable'].some(e => lastError.toLowerCase().includes(e));
      if (!modelIssue) throw new Error(lastError);
    } catch(e) {
      lastError = e.message;
      const modelIssue = ['deprecated','not found','does not exist','quota','unavailable'].some(e2 => e.message.toLowerCase().includes(e2));
      if (!modelIssue) throw e;
    }
  }
  throw new Error('All Gemini models failed. Last: ' + lastError);
}

module.exports = async function researchToLabRoutes(app) {
  app.post('/research-to-lab', async (req, reply) => {
    const { topic, geminiKey } = req.body || {};
    if (!topic || !geminiKey) {
      return reply.status(400).send({ error: 'topic and geminiKey are required' });
    }
    if (topic.length > 300) {
      return reply.status(400).send({ error: 'Topic too long (max 300 chars)' });
    }

    try {
      // Step 1: Syllabus check
      const syllabusResult = await callGemini(
        IB_SYLLABUS_CHECK + `\n\nTopic/paper: "${topic}"`,
        geminiKey,
        false
      );
      let syllabusData;
      try {
        const clean = syllabusResult.text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        syllabusData = JSON.parse(clean);
      } catch(e) {
        syllabusData = { within_syllabus: true, subject: 'Physics', reason: 'Could not parse', core_concept: topic };
      }

      if (!syllabusData.within_syllabus) {
        return reply.send({
          status: 'outside_syllabus',
          reason: syllabusData.reason,
          subject: syllabusData.subject
        });
      }

      const subject = IB_SUBJECTS.includes(syllabusData.subject) ? syllabusData.subject : 'Physics';

      // Step 2: Web search for papers on this topic
      const searchPrompt = `Search for 2-3 recent published research papers about: "${topic}" in the context of ${subject}.

For each paper found, provide:
- title
- authors (first author + et al.)  
- journal and year
- key methodology (2-3 sentences)
- key findings (2-3 sentences)
- main variables studied

Then write a combined 200-word summary of the research landscape in this area that could inspire a school student.

Format your response as:
PAPERS:
[list each paper]

SUMMARY:
[combined summary]`;

      const searchResult = await callGemini(searchPrompt, geminiKey, true);

      // Step 3: Generate RQs
      const rqResult = await callGemini(
        RQ_GENERATION(topic, searchResult.text, subject),
        geminiKey,
        false
      );

      let rqs;
      try {
        const clean = rqResult.text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        rqs = JSON.parse(clean);
      } catch(e) {
        throw new Error('Failed to parse RQ output: ' + rqResult.text.substring(0, 200));
      }

      // Sort by feasibility
      rqs.sort((a, b) => (b.feasibility_score || 5) - (a.feasibility_score || 5));

      return reply.send({
        status: 'ok',
        subject,
        core_concept: syllabusData.core_concept,
        paper_summary: searchResult.text,
        rqs,
        model: rqResult.model
      });

    } catch(e) {
      app.log.error(e);
      return reply.status(500).send({ error: e.message });
    }
  });
};
