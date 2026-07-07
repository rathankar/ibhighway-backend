'use strict';

/**
 * UniApply — University Application Writing Assistant (Tier 2)
 * Prefix: /api/uni-apply   (register in server.js)
 *
 *   app.register(require('./routes/uni-apply'), { prefix: '/api/uni-apply' });
 *
 * Platform conventions honoured:
 *   - ALL 200 discovery questions, system prompts, and document templates live
 *     here on the server. Nothing sensitive ships to the browser.
 *   - Gemini key arrives ONLY via X-Gemini-Key header. Missing/empty → HTTP 400.
 *   - process.env.GEMINI_API_KEY is NEVER used as a fallback. Hard rule.
 *   - Auth: JWT required (REQUIRE_AUTH = true). This is a Tier 2 tool.
 *   - All student data stored in PostgreSQL (profiles, answers, achievements).
 */

const pool = require('../db');

const REQUIRE_AUTH = true;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL   = 'gemini-2.5-flash';

// ── Minimum questions that must be answered (yes/no/in_progress) before
//    a document can be generated. "No" answers count — Gemini works with
//    whatever "yes" answers exist, but the student must have engaged with
//    at least this many relevant questions first.
const MIN_ANSWERS = {
  ucas:         25,
  commonapp:    25,
  'lor-brief':  20,
  sop:          20,
  supplemental: 15,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Auth
// ─────────────────────────────────────────────────────────────────────────────
function getUser(request, reply) {
  if (!REQUIRE_AUTH) return 1; // dev fallback
  try {
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const payload = request.server.jwt.verify(token);
    return payload.sub;
  } catch (_) {
    reply.code(401).send({ error: 'Invalid or expired token. Please log in again.' });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Gemini key
// ─────────────────────────────────────────────────────────────────────────────
function getGeminiKey(request, reply) {
  const key = (request.headers['x-gemini-key'] || '').trim();
  if (!key) {
    reply.code(400).send({ error: 'Gemini API key missing. Add it in your account settings.' });
    return null;
  }
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Gemini call
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(key, systemPrompt, userContent, model = DEFAULT_MODEL) {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${key}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function sendError(reply, err) {
  console.error('[uni-apply]', err.message);
  if (err.message.includes('API_KEY_INVALID') || err.message.includes('401')) {
    return reply.code(401).send({ error: 'Invalid Gemini API key.' });
  }
  if (err.message.includes('QUOTA') || err.message.includes('429')) {
    return reply.code(429).send({ error: 'Gemini quota exceeded. Try again later.' });
  }
  return reply.code(500).send({ error: 'AI generation failed. Please try again.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: Table initialisation
// ─────────────────────────────────────────────────────────────────────────────
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_apply_profiles (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER UNIQUE NOT NULL,
      name            TEXT,
      nationality     TEXT,
      ib_year         INTEGER,
      predicted_score INTEGER,
      actual_score    INTEGER,
      target_course   TEXT,
      target_countries TEXT,
      target_universities TEXT,
      applying_uk     BOOLEAN DEFAULT false,
      applying_us     BOOLEAN DEFAULT false,
      applying_other  TEXT,
      intended_career TEXT,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_apply_answers (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL,
      question_id      TEXT NOT NULL,
      status           TEXT NOT NULL,
      main_answer      TEXT,
      followup_answers TEXT,
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, question_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_apply_achievements (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      question_id  TEXT,
      category     TEXT,
      title        TEXT NOT NULL,
      description  TEXT,
      date_range   TEXT,
      impact_docs  TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
initTables().catch(e => console.error('[uni-apply] Table init error:', e.message));

// ─────────────────────────────────────────────────────────────────────────────
// THE 200-QUESTION DATABASE (server-side only — never sent to browser)
// ─────────────────────────────────────────────────────────────────────────────
// Each question:
//   id          — unique identifier (e.g. 'A01')
//   category    — letter code
//   catName     — human-readable category name
//   title       — short label
//   q           — the discovery question text
//   followups   — array of follow-up questions if student answers yes/in_progress
//   impact      — array: which docs this helps (ucas, commonapp, lor, sop, supplemental)
//   acquirable  — boolean: can the student still get this if they don't have it?
//   guide       — if acquirable: practical steps to acquire it
//   priority    — 1 (ask early), 2 (mid), 3 (later)
//   askIf       — field in profile that must be truthy before asking (e.g. 'applying_us')

const QUESTIONS = [
  // ── CATEGORY A: Academic Excellence ────────────────────────────────────────
  { id:'A01', category:'A', catName:'Academic Excellence', title:'IB Total Score', priority:1,
    q:'What is your predicted or actual IB total score?',
    followups:['Which subjects are you taking at HL?','Are any predicted 7s particularly surprising or hard-won?'],
    impact:['ucas','commonapp','lor','sop'] },

  { id:'A02', category:'A', catName:'Academic Excellence', title:'Extended Essay', priority:1,
    q:'What subject and topic did you choose for your Extended Essay, and what grade did you receive or expect?',
    followups:['What was your research question exactly?','Did your EE lead to any unexpected findings or change your thinking?'],
    impact:['ucas','sop','commonapp'], acquirable:false },

  { id:'A03', category:'A', catName:'Academic Excellence', title:'TOK Essay / Exhibition', priority:1,
    q:'What was the central knowledge question in your TOK essay, and which prompt did you choose?',
    followups:['What real-life situations or examples did you explore?','Did the TOK process change how you think about knowledge or certainty?'],
    impact:['ucas','commonapp'] },

  { id:'A04', category:'A', catName:'Academic Excellence', title:'Top HL Grade (7)', priority:1,
    q:'Have you received a 7 (or are predicted a 7) in any HL subject? Which one?',
    followups:['What did you do differently to achieve that grade?'],
    impact:['ucas','lor','commonapp'], acquirable:true,
    guide:'Consistent past-paper practice and deliberate review of mark schemes. Identify the exact command terms that examiner mark schemes reward and practise writing to them.' },

  { id:'A05', category:'A', catName:'Academic Excellence', title:'School Academic Prize', priority:2,
    q:'Have you received any academic prize, award, or certificate from your school — such as a top-student prize, principal\'s list, or subject excellence award?',
    followups:['What was the prize and what did you do to earn it?'],
    impact:['ucas','lor'], acquirable:true,
    guide:'Consistent top performance in 1–2 subjects over a full year is the usual pathway. Ask your teacher what the selection criteria are.' },

  { id:'A06', category:'A', catName:'Academic Excellence', title:'Academic Olympiad', priority:2,
    q:'Have you participated in any national or international academic competition — Maths Olympiad, Physics Olympiad, Chemistry, Biology, Astronomy, or similar?',
    followups:['What level did you reach — school, regional, national, or international?','What problem or challenge stretched you most?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'Register with your national olympiad body now. Even reaching the regional round is worth mentioning. For IMO: start with your country\'s national selection competition. Timeline: 6–12 months of preparation with past olympiad problems.' },

  { id:'A07', category:'A', catName:'Academic Excellence', title:'University Research Internship', priority:2,
    q:'Have you done any formal research internship or university lab attachment — even for a week or two?',
    followups:['What lab or department? What were you working on?','Did you produce anything from it — a report, poster, or data?'],
    impact:['ucas','sop','lor'], acquirable:true,
    guide:'Email 10–15 professors whose research you\'ve actually read, explaining your IB subjects and your specific interest in their work. Many accept motivated high school students for summer periods. One personalised email beats ten generic ones.' },

  { id:'A08', category:'A', catName:'Academic Excellence', title:'Published Research', priority:3,
    q:'Have you co-authored, contributed to, or been acknowledged in any published research paper, journal article, or formal research output?',
    followups:['What was the topic and where was it published?'],
    impact:['ucas','sop','commonapp'], acquirable:true,
    guide:'Ask your lab supervisor (from any attachment) whether your contribution warrants acknowledgement or co-authorship. Separately, journals like Curieux Academic Journal and Young Scientists Journal accept high-school research submissions.' },

  { id:'A09', category:'A', catName:'Academic Excellence', title:'Science Fair / Exhibition', priority:2,
    q:'Have you entered any science fair, innovation exhibition, or project competition — at school, regional, or national level?',
    followups:['What was your project about? What result or grade did you receive?','Did you advance to a higher level?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'ISEF and Google Science Fair accept international applicants. Your IB IA topic can often be developed further into a competition entry. 6–9 months is realistic for a strong submission.' },

  { id:'A10', category:'A', catName:'Academic Excellence', title:'Essay Competition', priority:2,
    q:'Have you won, placed, or been shortlisted in any essay competition — academic, literary, or interdisciplinary?',
    followups:['What was the topic and who ran the competition?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'The John Locke Institute essay competition is highly regarded by UK universities. The Economist Open Future essays and RSA Student Design Awards are also worth entering. Free to enter and take 2–4 weeks to prepare.' },

  { id:'A11', category:'A', catName:'Academic Excellence', title:'Mathematics Competition', priority:2,
    q:'Have you participated in any mathematics competition — AMC, AIME, UKMT, Simon Marais, national math league, or similar?',
    followups:['What was the competition and what level did you achieve?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'The UKMT Senior Mathematical Challenge (UK) and AMC 10/12 (US) are the most widely recognised. Register through your school. Strong performance feeds into national olympiad selection.' },

  { id:'A12', category:'A', catName:'Academic Excellence', title:'Debate / MUN Award', priority:2,
    q:'Have you competed in any debate tournament or Model United Nations conference and received an award or committee chair role?',
    followups:['What was the topic or resolution?','What position did you hold — delegate, chair, or Secretary General?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Hosting a MUN at your own school as Secretary General is more impressive than attending as a delegate — it shows organisational initiative.' },

  { id:'A13', category:'A', catName:'Academic Excellence', title:'Foreign Language Certification', priority:2,
    q:'Do you hold any formal certification in a language other than English — Cambridge C1/C2, DALF, Goethe, HSK, JLPT, DELE, or similar?',
    followups:['What language and level?','Have you used this language in an academic or professional context?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'Language certifications take 3–9 months to prepare for. Cambridge C1 Advanced is widely recognised. A third language at even B1/B2 signals cognitive flexibility and cultural openness.' },

  { id:'A14', category:'A', catName:'Academic Excellence', title:'Gifted / Enrichment Programme', priority:2,
    q:'Have you been selected for any gifted student programme, honours track, enrichment initiative, or academic excellence programme?',
    followups:['Who ran it and what did it involve?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Many universities run widening access programmes for high-achieving students — Sutton Trust, Villiers Park (UK), or university-specific summer schools. Check your target universities\' access pages.' },

  { id:'A15', category:'A', catName:'Academic Excellence', title:'MOOC / Online University Course', priority:2,
    q:'Have you completed any online university course with a verifiable certificate — Coursera, edX, MIT OpenCourseWare, Harvard Online, FutureLearn, or similar?',
    followups:['What was the course, which university offered it, and what grade did you receive?','Was it in your target subject area?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Choose a course directly related to your target degree. A verified certificate from MIT or Stanford costs $49–$150. Prioritise courses with graded assignments over watch-only certificates — they carry more credibility.' },

  // ── CATEGORY B: Leadership & Initiative ────────────────────────────────────
  { id:'B01', category:'B', catName:'Leadership & Initiative', title:'Student Council Executive', priority:1,
    q:'Have you held a student council executive position — president, vice president, secretary, or treasurer?',
    followups:['What was your main initiative or achievement in that role?'],
    impact:['ucas','commonapp','lor'] },

  { id:'B02', category:'B', catName:'Leadership & Initiative', title:'Head Boy / Head Girl / Prefect', priority:1,
    q:'Were you selected as Head Boy, Head Girl, or a school prefect?',
    followups:['What responsibilities did that role carry at your school?'],
    impact:['ucas','lor'] },

  { id:'B03', category:'B', catName:'Leadership & Initiative', title:'Club Founder', priority:1,
    q:'Have you started or founded any club, group, or initiative at your school that didn\'t exist before?',
    followups:['What is the club\'s purpose?','How many members does it have and is it still running?'],
    impact:['ucas','commonapp','lor'], acquirable:true,
    guide:'Starting a club is one of the most actionable things you can do right now. Pick a gap you\'ve noticed — a coding club, ethics discussion group, language exchange, or student podcast. Get 5 members and one teacher as advisor. Even 6 sessions over 3 months is worth mentioning.' },

  { id:'B04', category:'B', catName:'Leadership & Initiative', title:'Class Representative', priority:2,
    q:'Have you been elected or selected as a class representative or school captain?',
    followups:['What actions did you take in that role?'],
    impact:['ucas','lor'] },

  { id:'B05', category:'B', catName:'Leadership & Initiative', title:'House / Sports House Leadership', priority:2,
    q:'Have you served as a house captain, house committee member, or house representative?',
    followups:['What events or activities did you help organise through the house system?'],
    impact:['ucas','lor'] },

  { id:'B06', category:'B', catName:'Leadership & Initiative', title:'Community Project Leader', priority:2,
    q:'Have you independently organised a community project, drive, campaign, or event — outside of school requirements?',
    followups:['What was the project, how many people were involved, and what was the outcome?'],
    impact:['ucas','commonapp','supplemental'], acquirable:true,
    guide:'Something you organised on your own initiative — a tutoring programme for local kids, a neighbourhood clean-up, a fundraiser for a specific cause — carries more weight than required service. You need 3 months and one documented outcome.' },

  { id:'B07', category:'B', catName:'Leadership & Initiative', title:'Social Enterprise Founder', priority:2,
    q:'Have you started any business, social enterprise, or revenue-generating initiative — at any scale?',
    followups:['What problem does it solve?','Does it generate revenue, and how did you start it?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'Scale doesn\'t matter at this stage — the fact that you identified a problem and built a solution does. A tutoring service, graphic design practice, or educational social account with paid collaborations all count.' },

  { id:'B08', category:'B', catName:'Leadership & Initiative', title:'Youth Parliament / Ambassador', priority:2,
    q:'Have you participated in a youth parliament, youth legislature, young leaders forum, or similar civic programme?',
    followups:['What programme, what year, and what did you speak or vote on?'],
    impact:['ucas','commonapp'], acquirable:true },

  { id:'B09', category:'B', catName:'Leadership & Initiative', title:'MUN Secretary General / Chair', priority:2,
    q:'Have you served as Secretary General, Conference Director, or Committee Chair at a Model United Nations conference?',
    followups:['How many delegates did you manage?','What was the conference theme?'],
    impact:['ucas','commonapp'] },

  { id:'B10', category:'B', catName:'Leadership & Initiative', title:'School Newspaper / Magazine Editor', priority:2,
    q:'Are you editor, co-editor, or a regular contributor to your school newspaper, magazine, or literary journal?',
    followups:['What have you written or edited?','What impact has it had?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'If your school doesn\'t have a publication, starting one as founder-editor is better than joining one. A digital newsletter with 3 published issues is enough to mention.' },

  { id:'B11', category:'B', catName:'Leadership & Initiative', title:'TEDx Youth Speaker', priority:3,
    q:'Have you spoken at a TEDx Youth event or any formal public speaking platform with a recorded talk?',
    followups:['What was your talk about?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Search ted.com/tedx for upcoming youth events near you. A well-prepared application idea is 70% of the battle.' },

  { id:'B12', category:'B', catName:'Leadership & Initiative', title:'Peer Tutoring Programme Organiser', priority:2,
    q:'Have you set up or run a peer tutoring programme — not just helped one friend, but organised a system where multiple students receive regular help?',
    followups:['How many students, what subjects, and how long has it run?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Talk to your school counsellor about formalising a tutoring programme for younger students. A written acknowledgement from the school strengthens the claim.' },

  { id:'B13', category:'B', catName:'Leadership & Initiative', title:'Major School Event Organiser', priority:2,
    q:'Have you organised a major school event — cultural festival, inter-school competition, charity gala, or exhibition?',
    followups:['What was the event?','How many people attended, and what was your specific role?'],
    impact:['ucas','commonapp'] },

  { id:'B14', category:'B', catName:'Leadership & Initiative', title:'Online Community Builder', priority:3,
    q:'Have you built or led an online study community, Discord server, or social media community with substantial members and regular engagement?',
    followups:['What platform, how many members, and how active is it?'],
    impact:['commonapp'], acquirable:true },

  { id:'B15', category:'B', catName:'Leadership & Initiative', title:'Fundraising Campaign Leader', priority:2,
    q:'Have you led a fundraising campaign for a cause, with a specific target and a documented outcome?',
    followups:['What was the cause, how much was raised, and how did you do it?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY C: STEM & Technology ──────────────────────────────────────────
  { id:'C01', category:'C', catName:'STEM & Technology', title:'Software Project with Real Users', priority:2,
    q:'Have you built any software project — a website, web app, mobile app, tool, or script — that other people actually use?',
    followups:['What does it do and how many users does it have?','What language or framework did you use?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'Build something that solves a real problem. Even 10 genuine users is meaningful. Use GitHub to host the code publicly with regular commits over months — this signals sustained effort, not a weekend project.' },

  { id:'C02', category:'C', catName:'STEM & Technology', title:'Published Mobile App', priority:3,
    q:'Have you published an app on the App Store or Google Play Store?',
    followups:['What does the app do and how many downloads has it had?'],
    impact:['ucas','commonapp','sop'], acquirable:true },

  { id:'C03', category:'C', catName:'STEM & Technology', title:'Hackathon', priority:2,
    q:'Have you participated in a hackathon? Did you receive any awards or placements?',
    followups:['What problem did your team solve and what did you build in the time given?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'MLH and Devpost list hundreds of online hackathons. Most are free to enter and welcome beginners.' },

  { id:'C04', category:'C', catName:'STEM & Technology', title:'Robotics Team / Competition', priority:2,
    q:'Are you part of a robotics team, or have you competed in any robotics competition?',
    followups:['What competition — FRC, FTC, VEX, WRO?','What was your role — builder, programmer, or designer?'],
    impact:['ucas','commonapp'], acquirable:true },

  { id:'C05', category:'C', catName:'STEM & Technology', title:'AI / Machine Learning Project', priority:2,
    q:'Have you built or trained any AI or machine learning model — a Kaggle competition entry, personal project, or school project that goes beyond your IA?',
    followups:['What problem were you trying to solve?','What dataset did you use?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'Kaggle micro-courses are free and take 4–6 hours each. A submitted Kaggle competition entry, even without a top placement, demonstrates genuine engagement with real data and real evaluation.' },

  { id:'C06', category:'C', catName:'STEM & Technology', title:'Cybersecurity / CTF', priority:3,
    q:'Have you participated in any Capture The Flag (CTF) competition or cybersecurity challenge?',
    followups:['Which platforms — PicoCTF, HackTheBox, TryHackMe? What was your ranking or score?'],
    impact:['ucas','sop'], acquirable:true },

  { id:'C07', category:'C', catName:'STEM & Technology', title:'Hardware / Electronics Project', priority:2,
    q:'Have you built any electronics project — Arduino, Raspberry Pi, circuit design, or physical computing device?',
    followups:['What did it do and did you document it anywhere?'],
    impact:['ucas','commonapp'] },

  { id:'C08', category:'C', catName:'STEM & Technology', title:'3D Design / CAD', priority:3,
    q:'Have you done any 3D modelling, CAD design, or 3D printing project?',
    followups:['What software did you use — Fusion 360, SolidWorks, TinkerCAD?','What did you design?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Fusion 360 is free for students. One completed, documented design is enough to mention.' },

  { id:'C09', category:'C', catName:'STEM & Technology', title:'Data Science / Analysis Project', priority:2,
    q:'Have you worked with a real dataset — beyond classroom exercises — to investigate a question, find a pattern, or create a visualisation?',
    followups:['What question were you investigating and what did you find?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'Kaggle datasets, government open data portals, WHO and World Bank data are all free. A Jupyter notebook on GitHub showing your analysis is credible evidence.' },

  { id:'C10', category:'C', catName:'STEM & Technology', title:'Open Source Contribution', priority:3,
    q:'Have you contributed to any open source project on GitHub — a bug fix, documentation improvement, feature, or translation?',
    followups:['Which project and what was your contribution?'],
    impact:['sop','commonapp'], acquirable:true,
    guide:'The "good first issue" label on GitHub lists beginner-friendly tasks in active projects. One merged pull request is meaningful evidence of real-world coding ability.' },

  { id:'C11', category:'C', catName:'STEM & Technology', title:'Independent Science Research', priority:2,
    q:'Have you conducted any science research independently — not as part of your IB IA — where you designed the experiment, collected data, and drew your own conclusions?',
    followups:['What was your research question?'],
    impact:['ucas','sop'] },

  { id:'C12', category:'C', catName:'STEM & Technology', title:'Science Communication Content', priority:3,
    q:'Have you created any science communication content — blog posts, YouTube videos, or infographics — that explains scientific concepts to a general audience?',
    followups:['What platform and what topics?','How many followers or views does your content have?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Six months of consistent monthly posts on a topic you genuinely understand is more credible than a large following. The content should align with your intended degree.' },

  // ── CATEGORY D: Arts, Culture & Media ──────────────────────────────────────
  { id:'D01', category:'D', catName:'Arts, Culture & Media', title:'Music Performance Grade', priority:2,
    q:'Have you achieved a formal grade in any musical instrument or voice — ABRSM, Trinity, RCM, or a regional equivalent?',
    followups:['What instrument and what grade?','Have you performed publicly — recital, school concert, or competition?'],
    impact:['ucas','commonapp'] },

  { id:'D02', category:'D', catName:'Arts, Culture & Media', title:'Music Composition', priority:3,
    q:'Have you composed original music that has been performed or recorded?',
    followups:['What genre and instruments?','Was it performed for an audience?'],
    impact:['ucas','commonapp'] },

  { id:'D03', category:'D', catName:'Arts, Culture & Media', title:'Theatre / Drama — Significant Role', priority:2,
    q:'Have you had a lead or significant supporting role in a school or community theatre production?',
    followups:['Which production and what character?','Was it a public performance?'],
    impact:['ucas','commonapp'] },

  { id:'D04', category:'D', catName:'Arts, Culture & Media', title:'Dance — Formal Training', priority:2,
    q:'Do you have formal dance training — classical, contemporary, folk, or commercial — and have you performed or competed?',
    followups:['How many years of training and what level?'],
    impact:['ucas','commonapp'] },

  { id:'D05', category:'D', catName:'Arts, Culture & Media', title:'Visual Arts Exhibition / Award', priority:2,
    q:'Has your artwork been exhibited at a gallery, exhibition, or competition — beyond your IB Visual Arts portfolio?',
    followups:['What medium and what was the context — school exhibition, community gallery, or competition?'],
    impact:['ucas','commonapp'] },

  { id:'D06', category:'D', catName:'Arts, Culture & Media', title:'Photography — Published or Exhibited', priority:3,
    q:'Have you had any photography published, exhibited, or awarded in a competition?',
    followups:['What subject or style and where was it published or shown?'],
    impact:['ucas','commonapp'] },

  { id:'D07', category:'D', catName:'Arts, Culture & Media', title:'Film / Video Production', priority:3,
    q:'Have you produced, directed, or edited a short film, documentary, or video series that has been screened or publicly shared?',
    followups:['What was the film about and where was it shown?'],
    impact:['ucas','commonapp'] },

  { id:'D08', category:'D', catName:'Arts, Culture & Media', title:'Creative Writing Published / Awarded', priority:2,
    q:'Have you had any creative writing — fiction, poetry, essays, or scripts — published in a journal, anthology, or recognised competition?',
    followups:['What did you write and where was it published?'],
    impact:['ucas','commonapp'] },

  { id:'D09', category:'D', catName:'Arts, Culture & Media', title:'Graphic Design / Digital Art', priority:3,
    q:'Have you done graphic design or digital art work for clients, organisations, or publications — paid or as a significant volunteer contribution?',
    followups:['What kind of work and who were the clients?'],
    impact:['ucas','commonapp'], acquirable:true },

  { id:'D10', category:'D', catName:'Arts, Culture & Media', title:'Classical / Traditional Arts', priority:2,
    q:'Do you have formal training in a traditional or classical art form — Bharatanatyam, Carnatic music, Kathak, Chinese classical dance, or similar — with performance experience at formal events?',
    followups:['How many years of training?','What events have you performed at?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY E: Sports & Physical ──────────────────────────────────────────
  { id:'E01', category:'E', catName:'Sports & Physical', title:'Varsity School Sports Team', priority:1,
    q:'Are you on a varsity-level school sports team in any sport?',
    followups:['What sport and position?','What is the team\'s competitive level — interschool, district, or national?'],
    impact:['ucas','commonapp'] },

  { id:'E02', category:'E', catName:'Sports & Physical', title:'District / State / National Sports', priority:2,
    q:'Have you represented your district, state or province, or country in any sport?',
    followups:['What sport and what level?'],
    impact:['ucas','commonapp','lor'] },

  { id:'E03', category:'E', catName:'Sports & Physical', title:'Sports Captaincy', priority:2,
    q:'Have you served as captain of any sports team?',
    followups:['What team?','What did you do differently as captain compared to a regular player?'],
    impact:['ucas','commonapp','lor'] },

  { id:'E04', category:'E', catName:'Sports & Physical', title:'Individual Sport Achievement', priority:2,
    q:'Do you have a recognised achievement in an individual sport — martial arts belt rank, swimming competition times, tennis rating, or gymnastics level?',
    followups:['What sport and what specific achievement?'],
    impact:['ucas','commonapp'] },

  { id:'E05', category:'E', catName:'Sports & Physical', title:'Chess Rating / Tournament', priority:3,
    q:'Do you have a FIDE chess rating or have you won or placed in formal chess tournaments?',
    followups:['What is your rating?','What tournaments have you competed in?'],
    impact:['ucas','commonapp'] },

  { id:'E06', category:'E', catName:'Sports & Physical', title:'Adventure / Outdoor Achievement', priority:3,
    q:'Have you completed any adventure or outdoor programme — rock climbing certification, trekking expedition, sailing qualification, or mountaineering?',
    followups:['What was the achievement and when?'],
    impact:['ucas','commonapp'] },

  { id:'E07', category:'E', catName:'Sports & Physical', title:'Physical Fitness Instructor Certification', priority:3,
    q:'Are you certified as an instructor in any physical discipline — yoga, swimming, fitness training, or lifeguarding?',
    followups:['What certification, from whom?'],
    impact:['ucas','commonapp'] },

  { id:'E08', category:'E', catName:'Sports & Physical', title:'Sports Coaching or Refereeing', priority:3,
    q:'Do you coach, train, or referee for a sport in any official capacity — for school teams, community leagues, or youth programmes?',
    followups:['What sport and for how long?'],
    impact:['ucas','commonapp'] },

  { id:'E09', category:'E', catName:'Sports & Physical', title:'eSports / Competitive Gaming', priority:3,
    q:'Have you competed in any organised eSports or competitive gaming tournament — school-organised, platform-ranked, or regional?',
    followups:['What game?','What platform or organisation?'],
    impact:['commonapp'] },

  { id:'E10', category:'E', catName:'Sports & Physical', title:'Duke of Edinburgh Award', priority:2,
    q:'Are you working on or have you completed the Duke of Edinburgh Award, President\'s Award, or a similar national youth development award?',
    followups:['Which level — Bronze, Silver, or Gold?','What activities count toward your award?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'The Gold DofE is one of the most respected extracurricular credentials for UK university applications. If you\'re in Year 12, you can still complete Bronze and Silver. The four sections — Physical, Skill, Volunteering, Expedition — often align with things you\'re already doing.' },

  // ── CATEGORY F: Community Service & Social Impact ──────────────────────────
  { id:'F01', category:'F', catName:'Community Service', title:'Sustained Volunteering (100+ hours)', priority:1,
    q:'Do you have a sustained volunteer relationship with any organisation — 100 hours or more with the same organisation over a year or more?',
    followups:['Which organisation?','What do you do there and how many hours in total?'],
    impact:['ucas','commonapp','supplemental'], acquirable:true,
    guide:'Sustained is more impressive than diverse. One organisation for 200 hours tells a better story than five organisations for 20 hours each. Find something aligned with your intended field.' },

  { id:'F02', category:'F', catName:'Community Service', title:'Tutoring Underprivileged Students', priority:2,
    q:'Have you taught or tutored underprivileged students — not peers, but students with fewer resources than you?',
    followups:['What subject, how many students, and over how long?'],
    impact:['ucas','commonapp','supplemental'], acquirable:true },

  { id:'F03', category:'F', catName:'Community Service', title:'Environmental Project', priority:2,
    q:'Have you been part of or led an environmental project with a measurable outcome — trees planted, plastic collected, or water bodies cleaned?',
    followups:['What was the project and what was the specific measurable impact?'],
    impact:['ucas','commonapp'], acquirable:true },

  { id:'F04', category:'F', catName:'Community Service', title:'Health Awareness Campaign', priority:2,
    q:'Have you organised or led a health awareness campaign at your school or in your community?',
    followups:['What health issue?','What did the campaign achieve?'],
    impact:['ucas','commonapp'] },

  { id:'F05', category:'F', catName:'Community Service', title:'Blood Donation Drive', priority:3,
    q:'Have you organised a blood donation drive, or donated blood regularly yourself if you are of age?',
    followups:['How many donors?','Which organisation supported it?'],
    impact:['ucas','commonapp'] },

  { id:'F06', category:'F', catName:'Community Service', title:'NGO Internship / Significant Role', priority:2,
    q:'Have you done a formal internship or held a significant role with an NGO, charity, or non-profit organisation?',
    followups:['What organisation, what role, and what did you contribute?'],
    impact:['ucas','commonapp','sop'] },

  { id:'F07', category:'F', catName:'Community Service', title:'Mental Health / Peer Support Initiative', priority:2,
    q:'Have you initiated or contributed to any mental health awareness, peer support, or student wellbeing programme?',
    followups:['What did you do and who did it reach?'],
    impact:['ucas','commonapp'] },

  { id:'F08', category:'F', catName:'Community Service', title:'Engagement with Vulnerable Communities', priority:2,
    q:'Do you regularly visit or engage with elderly care homes, orphanages, or organisations serving vulnerable populations?',
    followups:['How often, for how long, and what do you do there?'],
    impact:['ucas','commonapp'] },

  { id:'F09', category:'F', catName:'Community Service', title:'Disability Support Volunteering', priority:3,
    q:'Have you volunteered specifically with people with physical or intellectual disabilities?',
    followups:['What organisation and what was your role?'],
    impact:['ucas','commonapp'] },

  { id:'F10', category:'F', catName:'Community Service', title:'International / Cross-border Service', priority:3,
    q:'Have you participated in or led a service or cultural exchange project involving collaboration with students or organisations in another country?',
    followups:['What project, which country, and how did it work?'],
    impact:['ucas','commonapp'] },

  { id:'F11', category:'F', catName:'Community Service', title:'CAS Project (IB)', priority:1,
    q:'What was the most significant CAS project you undertook as part of your IB programme, and what was the outcome?',
    followups:['Did it have an impact beyond the school?','Did it continue after it was required?'],
    impact:['ucas','commonapp'] },

  { id:'F12', category:'F', catName:'Community Service', title:'Animal Welfare / Conservation', priority:3,
    q:'Have you volunteered with animal shelters, wildlife rehabilitation centres, conservation projects, or environmental monitoring programmes?',
    followups:['What organisation and what did you do?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY G: Professional Experience ────────────────────────────────────
  { id:'G01', category:'G', catName:'Professional Experience', title:'Formal Internship', priority:1,
    q:'Have you done any formal internship — paid or unpaid — with a company, organisation, or institution?',
    followups:['Company name, sector, duration, and your role?','What were you actually doing day to day?'],
    impact:['ucas','commonapp','sop','lor'] },

  { id:'G02', category:'G', catName:'Professional Experience', title:'Part-time or Holiday Job', priority:2,
    q:'Have you held a part-time job or worked during school holidays?',
    followups:['What was the role and employer?'],
    impact:['ucas','commonapp'] },

  { id:'G03', category:'G', catName:'Professional Experience', title:'Freelance Work', priority:2,
    q:'Have you done any freelance work — coding, design, writing, photography, or tutoring — for paying clients?',
    followups:['What services, how many clients, and how long have you been doing it?'],
    impact:['ucas','commonapp','sop'] },

  { id:'G04', category:'G', catName:'Professional Experience', title:'Family Business Involvement', priority:2,
    q:'Do you play a meaningful role in your family\'s business — not just being aware of it, but doing actual work, contributing to decisions, or learning from it?',
    followups:['What is the business and what do you do?'],
    impact:['ucas','commonapp'] },

  { id:'G05', category:'G', catName:'Professional Experience', title:'Medical / Clinical Shadowing', priority:1,
    q:'Have you done any medical or clinical shadowing — observing doctors, nurses, physiotherapists, or other healthcare professionals at work?',
    followups:['Where, for how long, and what did you observe?'],
    impact:['ucas','lor','sop'], acquirable:true,
    guide:'For Medicine and Dentistry applications, clinical shadowing is typically expected. Email hospitals, GP practices, and clinics directly. Even a week of observation is meaningful evidence of informed commitment to the profession.' },

  { id:'G06', category:'G', catName:'Professional Experience', title:'Legal / Corporate Shadowing', priority:2,
    q:'Have you done any work experience shadowing with a legal firm, consulting firm, investment bank, or government office?',
    followups:['Where and for how long?'],
    impact:['ucas','sop'], acquirable:true },

  { id:'G07', category:'G', catName:'Professional Experience', title:'Research Lab Attachment', priority:2,
    q:'Have you had any formal attachment to a research lab or academic department — even a short visit or observation period?',
    followups:['What lab, what subject, and what did you see or do?'],
    impact:['ucas','sop'] },

  { id:'G08', category:'G', catName:'Professional Experience', title:'Teaching / Lab Assistant at School', priority:2,
    q:'Have you formally assisted a teacher in delivering lessons or running a school lab — in a recognised role, not just helping a friend?',
    followups:['Which subject, which teacher, and how often?'],
    impact:['ucas','lor'] },

  // ── CATEGORY H: Personal Projects & Initiatives ─────────────────────────────
  { id:'H01', category:'H', catName:'Personal Projects', title:'Educational Blog / YouTube Channel', priority:2,
    q:'Do you run a blog, YouTube channel, or educational social media account that teaches or explains something in your subject area?',
    followups:['What topics?','How many posts or videos, and what platform?','What is your most-viewed or most-read piece?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'Consistent is better than viral. Six months of monthly posts on a topic you understand deeply is more credible than a quick burst. Content should align with your intended degree.' },

  { id:'H02', category:'H', catName:'Personal Projects', title:'Podcast', priority:3,
    q:'Have you produced and published a podcast with at least 5 episodes?',
    followups:['What topic and how many listeners or downloads on average?'],
    impact:['ucas','commonapp'] },

  { id:'H03', category:'H', catName:'Personal Projects', title:'Book Written', priority:3,
    q:'Have you written a complete manuscript, novel, or non-fiction book — even if not yet published?',
    followups:['What is it about?','Has anyone read it — a teacher, publisher, or competition?'],
    impact:['ucas','commonapp'] },

  { id:'H04', category:'H', catName:'Personal Projects', title:'Independent Research Project', priority:2,
    q:'Have you independently investigated a question that wasn\'t assigned by school — reading the literature, forming a hypothesis, analysing data, and reaching a conclusion?',
    followups:['What was your question and what did you find?'],
    impact:['ucas','sop'] },

  { id:'H05', category:'H', catName:'Personal Projects', title:'Third Language (Conversational+)', priority:2,
    q:'Do you speak any language at a conversational level or higher, beyond your school\'s language requirements?',
    followups:['What language, how did you learn it, and in what contexts do you use it?'],
    impact:['ucas','commonapp','sop'] },

  { id:'H06', category:'H', catName:'Personal Projects', title:'Significant Cultural Immersion / Travel', priority:2,
    q:'Have you had a significant travel or cultural immersion experience — not a holiday, but something that changed your perspective?',
    followups:['Where, for how long, and what did you encounter that challenged your assumptions?'],
    impact:['commonapp','ucas'] },

  { id:'H07', category:'H', catName:'Personal Projects', title:'Financial Literacy Self-Education', priority:3,
    q:'Have you taught yourself about personal finance, investing, or economics beyond the classroom — through books, courses, or practice?',
    followups:['What do you know and have you applied it in any way?'],
    impact:['ucas','commonapp','sop'] },

  { id:'H08', category:'H', catName:'Personal Projects', title:'Social Media Educator', priority:3,
    q:'Do you create educational content on social media — Instagram, TikTok, LinkedIn, or Twitter/X — linked to your academic interests, with consistent posting and a growing audience?',
    followups:['What subject?','What platform and how many followers and average views?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY I: Certifications & Programmes ─────────────────────────────────
  { id:'I01', category:'I', catName:'Certifications & Programmes', title:'NCC / Scouts Senior Rank', priority:2,
    q:'Have you attained a senior rank in NCC, Scouts, Girl Guides, or an equivalent national youth programme?',
    followups:['What rank, and what was the most significant thing you did in that programme?'],
    impact:['ucas','commonapp'] },

  { id:'I02', category:'I', catName:'Certifications & Programmes', title:'Rotary RYLA / Youth Ambassador', priority:2,
    q:'Have you participated in Rotary Youth Exchange, RYLA (Rotary Youth Leadership Awards), or any similar youth ambassador programme?',
    followups:['What programme, which year, and what did you do?'],
    impact:['ucas','commonapp'] },

  { id:'I03', category:'I', catName:'Certifications & Programmes', title:'First Aid / CPR Certification', priority:2,
    q:'Are you certified in First Aid or CPR?',
    followups:['Which certification body? Is it still valid?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'A First Aid certification takes 1–2 days and costs under £50/$60. Particularly relevant for Medicine, Nursing, and Sports Science applications.' },

  { id:'I04', category:'I', catName:'Certifications & Programmes', title:'Tech Certification (Google / Microsoft / AWS)', priority:2,
    q:'Do you hold any professional technology certification — Google Digital Marketing, Microsoft Azure, AWS Cloud Practitioner, Adobe Certified Professional, or similar?',
    followups:['Which certification and when did you earn it?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'Many are free or low-cost and can be completed in a few weeks. Google Digital Garage, AWS Cloud Practitioner Essentials, and Microsoft Learn are good starting points.' },

  { id:'I05', category:'I', catName:'Certifications & Programmes', title:'Design Thinking / Innovation Programme', priority:2,
    q:'Have you participated in a formal design thinking, innovation, or entrepreneurship programme — Stanford d.school workshops, NEN, Startup Weekend, or similar?',
    followups:['Which programme and what did you design or build?'],
    impact:['ucas','commonapp','sop'], acquirable:true },

  { id:'I06', category:'I', catName:'Certifications & Programmes', title:'Entrepreneurship Programme', priority:2,
    q:'Have you participated in an entrepreneurship programme with a business pitch or company simulation — Young Enterprise, NFTE, Junior Achievement, or Startup Weekend?',
    followups:['Which programme? Did your team win, place, or produce anything?'],
    impact:['ucas','commonapp'], acquirable:true },

  // ── CATEGORY J: Subject-Specific Intellectual Engagement ────────────────────
  { id:'J01', category:'J', catName:'Intellectual Engagement', title:'Book Beyond the Textbook', priority:1,
    q:'Can you name one or two books — not school textbooks — that you\'ve read out of genuine interest in your target subject area?',
    followups:['What did the book make you think about, question, or want to explore further?','Did it change your understanding of the subject in any way?'],
    impact:['ucas','commonapp'] },

  { id:'J02', category:'J', catName:'Intellectual Engagement', title:'Academic Paper Read', priority:2,
    q:'Have you read any academic journal article or research paper — not just a summary of it — in your intended subject area?',
    followups:['What was it about?','What did you find difficult or fascinating in it?','Did it make you question anything you\'d been taught in class?'],
    impact:['ucas','sop'], acquirable:true,
    guide:'Google Scholar and PubMed have free access to many papers. Find one paper cited in your IB textbook and read the original. Noticing what you don\'t understand and why is itself worth writing about.' },

  { id:'J03', category:'J', catName:'Intellectual Engagement', title:'University-Level Lecture Watched', priority:2,
    q:'Have you watched any university lecture, academic talk, or publicly available degree-level course video — MIT OpenCourseWare, Oxford podcasts, Numberphile, or similar?',
    followups:['What was the lecture or series?','What idea from it stayed with you?'],
    impact:['ucas','commonapp'], acquirable:true,
    guide:'MIT, Stanford, Oxford, and Yale all post full courses on YouTube for free. Watch one lecture from a degree-level course in your subject. The gap between what you understand and what you don\'t is interesting to write about.' },

  { id:'J04', category:'J', catName:'Intellectual Engagement', title:'Museum / Site Visit Related to Subject', priority:2,
    q:'Have you visited any museum, science centre, gallery, historical site, courtroom, hospital, or institution that relates to your intended field?',
    followups:['What did you observe or learn that you couldn\'t get from a textbook?'],
    impact:['ucas','commonapp'] },

  { id:'J05', category:'J', catName:'Intellectual Engagement', title:'Documentary That Influenced Thinking', priority:2,
    q:'Is there a documentary, film, or TV series that significantly shaped your thinking about your intended subject or field?',
    followups:['What was it and what specific idea or question did it raise for you?','Did it make you want to investigate something further?'],
    impact:['ucas','commonapp'] },

  { id:'J06', category:'J', catName:'Intellectual Engagement', title:'Academic Podcast / Radio Programme', priority:2,
    q:'Do you regularly listen to any academic podcasts or intellectual programmes related to your subject — In Our Time, Freakonomics, Ologies, Hidden Brain, or similar?',
    followups:['Which one and which episode or topic influenced your thinking most?'],
    impact:['ucas','commonapp'] },

  { id:'J07', category:'J', catName:'Intellectual Engagement', title:'Topic That Fascinates You', priority:1,
    q:'What is one specific topic, question, or debate within your intended subject that genuinely fascinates you — that you find yourself thinking about outside of class?',
    followups:['Why does it fascinate you?','What have you done to explore it further?','Is there a particular unresolved question in that area you\'d want to answer?'],
    impact:['ucas','commonapp','sop'] },

  { id:'J08', category:'J', catName:'Intellectual Engagement', title:'Idea That Changed Their Thinking', priority:1,
    q:'Can you describe one academic idea, theory, or concept — from your reading or coursework — that genuinely changed the way you see something?',
    followups:['What was the idea and what did it change?','Did encountering this idea lead you to explore anything else?'],
    impact:['ucas','commonapp'] },

  { id:'J09', category:'J', catName:'Intellectual Engagement', title:'Connection Between Two Subjects', priority:2,
    q:'Have you noticed an interesting or unexpected connection between your target subject and one of your other IB subjects — a concept that appears in both, or a method that transfers across?',
    followups:['What is the connection and how did you notice it?'],
    impact:['ucas','commonapp'] },

  { id:'J10', category:'J', catName:'Intellectual Engagement', title:'Current Debate in the Field', priority:2,
    q:'Are you following any current debate, controversy, or development in your intended subject?',
    followups:['What is it and what do you think about it?','Have you formed a view, or do you find it genuinely hard to take a side?'],
    impact:['ucas','commonapp','sop'] },

  { id:'J11', category:'J', catName:'Intellectual Engagement', title:'University Module Research', priority:1,
    q:'Have you looked at the specific modules offered in your target degree at your shortlisted universities — the actual module list, not just the degree name?',
    followups:['Which module or area of the degree excites you most and why?','Did any module surprise or challenge your assumptions about what the degree covers?'],
    impact:['ucas','supplemental'] },

  { id:'J12', category:'J', catName:'Intellectual Engagement', title:'Open Question in the Field', priority:2,
    q:'Is there an open question in your intended subject — something experts don\'t yet agree on, or a problem that remains unsolved — that intrigues you?',
    followups:['What is the question and why does it matter?'],
    impact:['ucas','sop'] },

  { id:'J13', category:'J', catName:'Intellectual Engagement', title:'Theory They Are Sceptical About', priority:3,
    q:'Is there a mainstream view or accepted theory in your subject that you feel sceptical about — where you think the evidence is weaker than usually claimed?',
    followups:['What is it and what makes you doubtful?'],
    impact:['ucas'] },

  { id:'J14', category:'J', catName:'Intellectual Engagement', title:'Subject Publication Reading', priority:2,
    q:'Do you regularly read any publication — newspaper, magazine, or journal digest — to keep up with developments in your target subject?',
    followups:['Which publication and what article or story recently caught your attention?'],
    impact:['ucas','commonapp'] },

  { id:'J15', category:'J', catName:'Intellectual Engagement', title:'University Taster / Masterclass', priority:2,
    q:'Have you attended any university taster day, sixth-form conference, masterclass, or academic event at a university — in person or online?',
    followups:['Which university, which subject, and what did you take away?'],
    impact:['ucas','supplemental'] },

  // ── CATEGORY K: Application Preparation & Logistics ─────────────────────────
  { id:'K01', category:'K', catName:'Application Logistics', title:'Target Countries Confirmed', priority:1,
    q:'Have you confirmed which countries you are applying to — UK, USA, Canada, Australia, Singapore, Netherlands, India, Europe, or a combination?',
    followups:['What is driving that choice — course quality, fees, career plans, or family considerations?'],
    impact:['ucas','commonapp','sop'] },

  { id:'K02', category:'K', catName:'Application Logistics', title:'Shortlisted Universities with Course Codes', priority:1,
    q:'Have you built a shortlist of specific universities with the specific course code or name — not just "a good UK university" but the actual institution and programme?',
    followups:['List them: university name, course name, and what attracts you to each?','Have you ordered them by stretch, match, and safety?'],
    impact:['ucas','commonapp','supplemental'] },

  { id:'K03', category:'K', catName:'Application Logistics', title:'Admissions Tests', priority:1,
    q:'Does any of your target university or course require an admissions test — UCAT, BMAT, LNAT, MAT, STEP, TSA, PAT, HAT, or others?',
    followups:['Have you registered for it?','Have you started preparation?'],
    impact:['ucas'], acquirable:true,
    guide:'Missing registration deadlines costs offers. UCAT registration opens in May. LNAT is September to January. MAT and PAT are in October and November. Check the admissions test requirements for each course on the university\'s own website.' },

  { id:'K04', category:'K', catName:'Application Logistics', title:'Interview Preparation', priority:2,
    q:'Are any of your target universities or courses known for interviews — Oxford, Cambridge, Medicine, Law, or Architecture?',
    followups:['Have you done any mock interviews — with a teacher, online, or through a programme?','Do you know what interview style to expect — problem-solving, motivational, or ethical scenarios?'],
    impact:['ucas'], acquirable:true,
    guide:'Oxford and Cambridge tutors interview in December. MMI Medicine interviews are October to February. Start mock interviews 2 months before interview season. Ask your school counsellor about arranging mock interviews.' },

  { id:'K05', category:'K', catName:'Application Logistics', title:'Reference Teacher Identified', priority:1,
    q:'Have you identified the teacher or teachers who will write your reference or letter of recommendation, and spoken to them about it?',
    followups:['What subject do they teach you and why did you choose them?','Have you given them a briefing about what to cover and your deadline?'],
    impact:['lor'] },

  { id:'K06', category:'K', catName:'Application Logistics', title:'Application Deadlines Mapped', priority:1,
    q:'Have you written down the specific deadlines for each university and application system you are using?',
    followups:['What is your earliest deadline?'],
    impact:['ucas','commonapp'] },

  { id:'K07', category:'K', catName:'Application Logistics', title:'SAT / ACT (US applicants)', priority:1,
    askIf:'applying_us',
    q:'Are you taking or have you taken the SAT or ACT alongside your IB?',
    followups:['What were your scores?','Are you planning a retake?'],
    impact:['commonapp'] },

  { id:'K08', category:'K', catName:'Application Logistics', title:'Early Decision / Early Action Strategy', priority:2,
    askIf:'applying_us',
    q:'Are you planning to apply Early Decision (binding) or Early Action (non-binding) to any US university?',
    followups:['Which university and why?','Do you understand the binding commitment if you apply ED?'],
    impact:['commonapp'] },

  { id:'K09', category:'K', catName:'Application Logistics', title:'Scholarship Research', priority:2,
    q:'Have you researched any scholarships you might be eligible for — at your target universities or from external bodies?',
    followups:['Which ones are you planning to apply for?','Do any require separate essays or forms?'],
    impact:['ucas','commonapp','sop'] },

  { id:'K10', category:'K', catName:'Application Logistics', title:'Financial Aid (US)', priority:2,
    askIf:'applying_us',
    q:'Are you planning to apply for need-based financial aid at US universities?',
    followups:['Do you know whether each target university is need-blind or need-aware for international students?','Have you looked into CSS Profile or FAFSA requirements?'],
    impact:['commonapp'] },

  { id:'K11', category:'K', catName:'Application Logistics', title:'Gap Year Consideration', priority:2,
    q:'Are you considering a gap year — either by necessity or by choice?',
    followups:['If yes, what do you plan to do during the gap year?','Have you checked whether your target universities accept gap year deferments?'],
    impact:['ucas','commonapp'] },

  { id:'K12', category:'K', catName:'Application Logistics', title:'Application Progress Check', priority:1,
    q:'How far along are you in the application process right now — have you started any drafts, had any feedback, or submitted anything?',
    followups:['What is the single biggest bottleneck in your application right now?'],
    impact:['ucas','commonapp','sop'] },

  // ── CATEGORY L: Personal Narrative & Formative Moments ──────────────────────
  { id:'L01', category:'L', catName:'Personal Narrative', title:'The Turning Point', priority:1,
    q:'Can you describe the moment — or series of moments — when you decided you wanted to study your target subject? Was there a specific experience, conversation, or encounter?',
    followups:['Before that turning point, what did you think you wanted to do?','How has your understanding of the subject changed since that moment?'],
    impact:['ucas','commonapp','sop'] },

  { id:'L02', category:'L', catName:'Personal Narrative', title:'A Significant Failure', priority:2,
    q:'Can you describe a time when you failed at something that genuinely mattered — an exam, a competition, a project, or a leadership role? What happened, and what did it teach you?',
    followups:['What did you do differently afterwards?','How do you think about failure now compared to before?'],
    impact:['commonapp'] },

  { id:'L03', category:'L', catName:'Personal Narrative', title:'A Person Who Changed Their Direction', priority:2,
    q:'Is there a teacher, family member, mentor, or person outside school who significantly influenced your academic or personal direction?',
    followups:['What did they do or say that stuck with you?','Did they challenge your thinking, or support you through something difficult?'],
    impact:['ucas','commonapp','lor'] },

  { id:'L04', category:'L', catName:'Personal Narrative', title:'Moment Outside Comfort Zone', priority:2,
    q:'Can you describe a time you did something genuinely outside your comfort zone — not just difficult, but uncomfortable in a way that changed how you see yourself?',
    followups:['Why did you do it?','What did you discover about yourself?'],
    impact:['commonapp'] },

  { id:'L05', category:'L', catName:'Personal Narrative', title:'Changed Their Mind', priority:2,
    q:'Have you changed your view on something important — academic, social, or personal — because of evidence, an argument, or an experience?',
    followups:['What changed it? Was it gradual or sudden?'],
    impact:['ucas','commonapp'] },

  { id:'L06', category:'L', catName:'Personal Narrative', title:'Disagreement Handled Well', priority:3,
    q:'Can you describe a time when you disagreed with someone — a teacher, a peer, an authority figure — and how you navigated it?',
    followups:['Did you stay with your position or change it? Why?','How did the other person respond?'],
    impact:['commonapp'] },

  { id:'L07', category:'L', catName:'Personal Narrative', title:'Led Under Pressure', priority:2,
    q:'Can you describe a specific moment when you had to lead or make a decision under real pressure — with time constraints, conflicting views, or high stakes?',
    followups:['What did you decide and what happened?','Would you make the same decision again?'],
    impact:['ucas','commonapp'] },

  { id:'L08', category:'L', catName:'Personal Narrative', title:'Moment of Genuine Curiosity', priority:1,
    q:'Can you describe a time when you found yourself completely absorbed in learning about something — not for an exam, but because you genuinely wanted to know?',
    followups:['What was it and how deep did you go?','Did it lead anywhere — a project, a conversation, a decision?'],
    impact:['ucas','commonapp'] },

  { id:'L09', category:'L', catName:'Personal Narrative', title:'Witnessed an Injustice', priority:2,
    q:'Have you encountered or witnessed something that struck you as fundamentally unfair — socially, structurally, locally, or globally?',
    followups:['What was it and how did it affect you?','Did it make you want to do something about it?'],
    impact:['commonapp','supplemental'] },

  { id:'L10', category:'L', catName:'Personal Narrative', title:'Worked With Very Different People', priority:2,
    q:'Can you describe a time when you worked closely with someone whose background, values, or way of thinking was very different from your own?',
    followups:['What did you learn from them?','Did it change how you approach collaboration?'],
    impact:['commonapp','supplemental'] },

  { id:'L11', category:'L', catName:'Personal Narrative', title:'Hardest Intellectual Challenge', priority:2,
    q:'What is the hardest intellectual challenge you\'ve faced so far — a concept, a course, or a project — that you had to work really hard to understand?',
    followups:['How did you approach it? What did you try that didn\'t work?','What finally made it click?'],
    impact:['ucas','commonapp'] },

  { id:'L12', category:'L', catName:'Personal Narrative', title:'Perspective Others Don\'t Have', priority:2,
    q:'Is there an experience in your life — family background, place you\'ve lived, something you\'ve witnessed — that has given you a perspective your classmates likely don\'t share?',
    followups:['What is it and how does it shape how you see your subject or the world?'],
    impact:['commonapp','supplemental'] },

  { id:'L13', category:'L', catName:'Personal Narrative', title:'Mistake With Consequences', priority:2,
    q:'Is there a time when a mistake you made had real consequences — for you or for others — and how did you respond?',
    followups:['What did you do when you realised what had happened?','What would you do differently?'],
    impact:['commonapp'] },

  { id:'L14', category:'L', catName:'Personal Narrative', title:'Something They Do When No One Is Watching', priority:3,
    q:'Is there something you do regularly — a habit, practice, or interest — that you don\'t often talk about because it seems unrelated to your academic profile?',
    followups:['What is it and why do you do it?','Does it connect in any unexpected way to who you are or what you want to do?'],
    impact:['commonapp'] },

  { id:'L15', category:'L', catName:'Personal Narrative', title:'What They\'d Contribute to University Life', priority:2,
    q:'Beyond your academic work, what do you see yourself contributing to a university community — to your course, college, or the wider student body?',
    followups:['Is this based on something you already do, or something you\'d want to start?'],
    impact:['ucas','commonapp','supplemental'] },

  // ── CATEGORY M: Identity, Background & Diversity ─────────────────────────────
  { id:'M01', category:'M', catName:'Identity & Background', title:'First Generation University', priority:1,
    q:'Will you be the first in your immediate family to attend university?',
    followups:['What has that meant for your journey — in terms of guidance, pressure, or motivation?'],
    impact:['commonapp','supplemental'] },

  { id:'M02', category:'M', catName:'Identity & Background', title:'Parents\' Background', priority:1,
    q:'What is your parents\' educational background — did either attend university, and what fields did they work in?',
    followups:[],
    impact:['commonapp'] },

  { id:'M03', category:'M', catName:'Identity & Background', title:'Socioeconomic Constraints', priority:2,
    q:'Did your family face any significant financial constraints during your school years that affected your ability to access certain opportunities?',
    followups:['Were there activities, programmes, or resources you couldn\'t access because of cost?'],
    impact:['commonapp','supplemental'] },

  { id:'M04', category:'M', catName:'Identity & Background', title:'Cultural or Religious Identity', priority:2,
    q:'Is your cultural, religious, or ethnic identity an important part of how you see yourself, and has it shaped your academic interests or the way you approach problems?',
    followups:['Is there a specific experience where your background gave you a perspective others didn\'t share?'],
    impact:['commonapp','supplemental'] },

  { id:'M05', category:'M', catName:'Identity & Background', title:'Language Background', priority:1,
    q:'What language or languages do you speak at home? Is English your first language, second, or something in between?',
    followups:['Has navigating more than one language given you any particular way of thinking or communicating?'],
    impact:['ucas','commonapp'] },

  { id:'M06', category:'M', catName:'Identity & Background', title:'Immigration or Relocation', priority:2,
    q:'Have you or your family moved countries, relocated significantly, or navigated immigration at any point?',
    followups:['How did that experience shape who you are or how you approach change?'],
    impact:['commonapp','supplemental'] },

  { id:'M07', category:'M', catName:'Identity & Background', title:'Health or Disability', priority:2,
    q:'Have you faced any significant health challenge, disability, or learning difference during your school years?',
    followups:['How did it affect your learning and how did you adapt?'],
    impact:['ucas','commonapp'] },

  { id:'M08', category:'M', catName:'Identity & Background', title:'Family Responsibilities', priority:2,
    q:'Have you had significant family responsibilities — caring for a sibling or parent, or contributing substantially to household income or management?',
    followups:['How did you manage this alongside your IB studies?'],
    impact:['ucas','commonapp'] },

  { id:'M09', category:'M', catName:'Identity & Background', title:'Adversity or Disruption', priority:2,
    q:'Has there been a significant disruption, loss, or adversity in your life — illness in the family, bereavement, financial crisis, or school disruption — that affected your educational journey?',
    followups:['How did you manage to continue?','What supported you?'],
    impact:['ucas','commonapp'] },

  { id:'M10', category:'M', catName:'Identity & Background', title:'What Admissions Should Know', priority:2,
    q:'Is there anything about your background, circumstances, or personal situation that you feel is important context for understanding who you are — that doesn\'t fit anywhere else in the application?',
    followups:['Why does this feel important to include?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY N: Soft Skills With Evidence ────────────────────────────────────
  { id:'N01', category:'N', catName:'Soft Skills', title:'Managing Extreme Workload', priority:2,
    q:'Can you describe a specific period — exam season or multiple simultaneous deadlines — when you had to manage an unusually heavy workload? How did you structure it?',
    followups:['What was your system?','Did it work or did you have to adapt?'],
    impact:['ucas','commonapp'] },

  { id:'N02', category:'N', catName:'Soft Skills', title:'Solving a Problem Alone', priority:2,
    q:'Can you describe a time when you hit a problem — academic or practical — where you couldn\'t get help, and had to figure it out entirely on your own?',
    followups:['What was the problem and what did you try?','How long did it take and what was the solution?'],
    impact:['ucas','commonapp'] },

  { id:'N03', category:'N', catName:'Soft Skills', title:'Teaching Something Difficult', priority:2,
    q:'Can you describe a time when you had to explain a difficult concept or idea to someone else — a younger student, a parent, or a peer from a different subject?',
    followups:['How did you figure out how to explain it?','Did the process of explaining it teach you something you hadn\'t realised before?'],
    impact:['ucas','commonapp'] },

  { id:'N04', category:'N', catName:'Soft Skills', title:'Difficult Team Situation', priority:2,
    q:'Can you describe a group project or team situation where things got difficult — conflicting views, uneven work, or a falling out?',
    followups:['What did you do? Did you address it directly?','What was the outcome?'],
    impact:['ucas','commonapp'] },

  { id:'N05', category:'N', catName:'Soft Skills', title:'Persisting When It Wasn\'t Working', priority:2,
    q:'Can you describe something you stayed with even when it wasn\'t working — a subject, a project, or a skill — when it would have been easier to stop?',
    followups:['What kept you going?','Did persistence pay off, or not — and what did you learn either way?'],
    impact:['ucas','commonapp'] },

  { id:'N06', category:'N', catName:'Soft Skills', title:'Receiving Difficult Feedback', priority:2,
    q:'Can you describe a time when you received critical feedback — on your work, your leadership, or your behaviour — that was hard to hear?',
    followups:['What did you do with it?','Looking back, was the feedback right?'],
    impact:['ucas','commonapp'] },

  { id:'N07', category:'N', catName:'Soft Skills', title:'Balancing Multiple Commitments', priority:2,
    q:'At your busiest, what were you managing simultaneously — subjects, extracurriculars, family responsibilities, and personal projects? How did you prioritise?',
    followups:['Was there something you had to sacrifice? What and why?'],
    impact:['ucas','commonapp'] },

  { id:'N08', category:'N', catName:'Soft Skills', title:'Taking Unsolicited Initiative', priority:2,
    q:'Can you describe a time when you identified something that needed to be done and did it — without being asked, assigned, or required?',
    followups:['What did you notice that others hadn\'t?','What did you do about it?'],
    impact:['ucas','commonapp'] },

  { id:'N09', category:'N', catName:'Soft Skills', title:'Adapting When Plans Failed', priority:2,
    q:'Can you describe a situation where your original plan fell apart and you had to adapt quickly?',
    followups:['What happened and what did you do instead?','How comfortable are you in situations without a plan?'],
    impact:['ucas','commonapp'] },

  { id:'N10', category:'N', catName:'Soft Skills', title:'Working With Limited Resources', priority:2,
    q:'Can you describe a project or goal you achieved with significantly limited resources — money, time, equipment, or support?',
    followups:['What did you do to work around those constraints?'],
    impact:['ucas','commonapp'] },

  { id:'N11', category:'N', catName:'Soft Skills', title:'Supporting Someone Through Difficulty', priority:2,
    q:'Can you describe a time when someone — a classmate, younger student, or friend — was struggling and you helped them through it?',
    followups:['How did you know what they needed?','What was the outcome?'],
    impact:['ucas','commonapp'] },

  { id:'N12', category:'N', catName:'Soft Skills', title:'Decision Under Uncertainty', priority:2,
    q:'Can you describe an important decision you made when you didn\'t have all the information you needed?',
    followups:['What did you do with the uncertainty?','Looking back, was it the right call?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY O: Digital Presence ─────────────────────────────────────────────
  { id:'O01', category:'O', catName:'Digital Presence', title:'LinkedIn Profile', priority:2,
    q:'Do you have a LinkedIn profile that represents your academic and extracurricular profile professionally?',
    followups:['Is it complete — photo, headline, education, activities?'],
    impact:['commonapp'], acquirable:true },

  { id:'O02', category:'O', catName:'Digital Presence', title:'Personal Website or Portfolio', priority:2,
    q:'Do you have a personal website or online portfolio?',
    followups:['What does it show — projects, writing, artwork, or code?','What is the URL?'],
    impact:['ucas','commonapp','sop'], acquirable:true,
    guide:'GitHub Pages, Notion public pages, or Squarespace can host a student portfolio free or for low cost. A single-page site with your projects, a brief bio, and contact information is more than most applicants have.' },

  { id:'O03', category:'O', catName:'Digital Presence', title:'GitHub Profile (Tech applicants)', priority:2,
    q:'Do you have a public GitHub profile with repositories that show your projects?',
    followups:['What are your most active or polished repositories?','Are your README files written so an outsider can understand the project?'],
    impact:['ucas','sop'], acquirable:true },

  { id:'O04', category:'O', catName:'Digital Presence', title:'Published Work Online', priority:2,
    q:'Do you have any published writing, articles, creative work, or projects accessible online with a URL?',
    followups:['What and where?'],
    impact:['ucas','commonapp'] },

  { id:'O05', category:'O', catName:'Digital Presence', title:'Video Evidence of Performance', priority:3,
    q:'Is there any video online — on YouTube, Vimeo, or a school website — that shows a performance, presentation, or skill you\'ve claimed in your application?',
    followups:['What is it and where is it?'],
    impact:['ucas','commonapp'] },

  { id:'O06', category:'O', catName:'Digital Presence', title:'Academic Work Online', priority:3,
    q:'Is any of your academic or research work available to view online — an IA that was shared, a paper submitted to a journal, or a project on a public platform?',
    followups:['Where is it?'],
    impact:['ucas','sop'] },

  { id:'O07', category:'O', catName:'Digital Presence', title:'Professional Social Media', priority:3,
    q:'Do you have any public social media presence — Twitter/X, Instagram, or TikTok — explicitly linked to your academic or professional identity?',
    followups:['What handle, what content, and what following?'],
    impact:['commonapp'] },

  { id:'O08', category:'O', catName:'Digital Presence', title:'Online Awards or Features', priority:3,
    q:'Have you received any recognition, award, or feature online — in a news article, blog, or organisation\'s website — that can be linked to?',
    followups:['What was it and where is it accessible?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY P: Application Strategy ─────────────────────────────────────────
  { id:'P01', category:'P', catName:'Application Strategy', title:'Core Narrative Thread', priority:1,
    q:'If you had to describe yourself in one sentence — not your achievements, but what kind of thinker or person you are — what would it be?',
    followups:['Does that description connect your academic interests, activities, and experiences into a coherent story?'],
    impact:['ucas','commonapp','sop'] },

  { id:'P02', category:'P', catName:'Application Strategy', title:'Spike vs Well-Rounded', priority:2,
    q:'Looking at everything you\'ve done — do you have one area of exceptional depth (a "spike"), or are you strong across many different areas?',
    followups:['If spike: what is it and does everything connect to it?','If well-rounded: what is the common thread across your activities?'],
    impact:['ucas','commonapp'] },

  { id:'P03', category:'P', catName:'Application Strategy', title:'What They\'d Do Instead', priority:3,
    q:'If you weren\'t applying to university right now, what would you be doing instead?',
    followups:['What does that tell you about what genuinely drives you?'],
    impact:['commonapp'] },

  { id:'P04', category:'P', catName:'Application Strategy', title:'Weakest Part of Application', priority:2,
    q:'What do you think is the weakest part of your application right now — the thing that might give an admissions reader pause?',
    followups:['Is there anything you can do to address or contextualise it?'],
    impact:['ucas','commonapp'] },

  { id:'P05', category:'P', catName:'Application Strategy', title:'Strongest Part of Application', priority:2,
    q:'What do you think is the strongest part of your application — the thing most likely to make an admissions reader remember you?',
    followups:['Is that strength clearly communicated in your personal statement or essays, or is it buried?'],
    impact:['ucas','commonapp'] },

  { id:'P06', category:'P', catName:'Application Strategy', title:'What Differentiates Them', priority:2,
    q:'If 500 students with similar IB scores were applying to the same course, what makes your application different?',
    followups:['Is that difference clearly visible in your current drafts?'],
    impact:['ucas','commonapp','sop'] },

  { id:'P07', category:'P', catName:'Application Strategy', title:'Support Available', priority:1,
    q:'What support do you have for your application — a school counsellor, independent consultant, supportive teacher, experienced parent, or mostly doing it alone?',
    followups:['Are there any gaps in support that this tool should help fill?'],
    impact:['ucas','commonapp'] },

  { id:'P08', category:'P', catName:'Application Strategy', title:'Existing Drafts', priority:1,
    q:'Have you written any drafts of your personal statement, main essay, or supplemental essays yet?',
    followups:['What feedback have you received?','What do you think isn\'t working?'],
    impact:['ucas','commonapp'] },

  { id:'P09', category:'P', catName:'Application Strategy', title:'Time Available', priority:1,
    q:'How much time per week can you realistically give to application work right now, alongside your IB coursework?',
    followups:[],
    impact:['ucas','commonapp'] },

  { id:'P10', category:'P', catName:'Application Strategy', title:'Target Outcome', priority:1,
    q:'What does success look like to you — getting into a specific university, any university in a specific country, the best possible programme for a specific subject, or something else?',
    followups:['What is your honest expectation — are you aiming for a long shot, or are you confident in your shortlist?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY Q: Scholarship & Financial Planning ──────────────────────────────
  { id:'Q01', category:'Q', catName:'Scholarships & Finance', title:'Scholarship Research', priority:2,
    q:'Have you researched scholarships you might be eligible for — at your target universities or from government, corporate, or foundation sources?',
    followups:['Which ones are you planning to apply for?','What do they require — separate essays, grade thresholds, subject, or nationality?'],
    impact:['ucas','commonapp','sop'] },

  { id:'Q02', category:'Q', catName:'Scholarships & Finance', title:'Government Scholarships', priority:2,
    q:'Does your home country or government offer scholarships for studying abroad — DAAD, Chevening, Fulbright, ASEAN scholarships, or similar?',
    followups:['Are you eligible? What is the process and deadline?'],
    impact:['ucas','commonapp','sop'] },

  { id:'Q03', category:'Q', catName:'Scholarships & Finance', title:'University Merit Aid', priority:2,
    q:'Do any of your target universities offer automatic merit scholarships based on grades, or competitive scholarships requiring a separate application?',
    followups:['What are the grade thresholds or requirements?'],
    impact:['ucas','commonapp'] },

  { id:'Q04', category:'Q', catName:'Scholarships & Finance', title:'Need-Based Aid (US)', priority:2,
    askIf:'applying_us',
    q:'Are you planning to apply for need-based financial aid at US universities?',
    followups:['Do you know whether each target university is need-blind or need-aware for international students?'],
    impact:['commonapp'] },

  { id:'Q05', category:'Q', catName:'Scholarships & Finance', title:'Fee Planning', priority:2,
    q:'Have you and your family had a concrete conversation about what universities you can afford — including tuition, living costs, and travel?',
    followups:['Is there a budget threshold that makes certain universities non-viable even if admitted?'],
    impact:['ucas','commonapp'] },

  { id:'Q06', category:'Q', catName:'Scholarships & Finance', title:'Part-time Work During University', priority:3,
    q:'Are you planning to work part-time during university to contribute to costs?',
    followups:['Are you aware of the visa restrictions on working hours for international students in your target countries?'],
    impact:['commonapp'] },

  { id:'Q07', category:'Q', catName:'Scholarships & Finance', title:'Loan Availability', priority:3,
    q:'Are student loans available to you for your target countries, and have you researched the terms and repayment conditions?',
    followups:[],
    impact:['commonapp'] },

  { id:'Q08', category:'Q', catName:'Scholarships & Finance', title:'Scholarship Essay Preparation', priority:2,
    q:'Do any of your target scholarships require a separate essay or personal statement? Have you started working on it?',
    followups:['What is the prompt and how is it different from your UCAS or Common App essay?'],
    impact:['ucas','commonapp'] },

  // ── CATEGORY R: Contextual Information ───────────────────────────────────────
  { id:'R01', category:'R', catName:'Context', title:'School IB Performance Context', priority:1,
    q:'How does your school perform in the IB on average — is it a high-performing IB school, an average performer, or a school where IB results tend to be modest?',
    followups:['How does your performance compare to your school\'s average?'],
    impact:['ucas','commonapp'] },

  { id:'R02', category:'R', catName:'Context', title:'Resource Access at School', priority:2,
    q:'Did your school provide strong IB support — experienced teachers, good resources, a stable environment — or were there gaps in certain areas?',
    followups:['Were there subjects where teacher quality or resources were a significant constraint?'],
    impact:['ucas','commonapp'] },

  { id:'R03', category:'R', catName:'Context', title:'Major Disruption to Education', priority:2,
    q:'Did your IB journey involve any significant disruptions — COVID closures, school changes, teacher shortages, or political or civil unrest?',
    followups:['How did that affect your learning and what did you do to manage?'],
    impact:['ucas','commonapp'] },

  { id:'R04', category:'R', catName:'Context', title:'Extracurricular Access Constraints', priority:2,
    q:'Were there any extracurricular activities you wanted to pursue but couldn\'t — because of location, cost, family responsibilities, or school limitations?',
    followups:['How did you find alternatives within those constraints?'],
    impact:['ucas','commonapp'] },

  { id:'R05', category:'R', catName:'Context', title:'Language of Instruction', priority:1,
    q:'Was your IB instruction in English, or primarily in another language?',
    followups:['If in another language, how did you manage English-language requirements?'],
    impact:['ucas','commonapp'] },

  { id:'R06', category:'R', catName:'Context', title:'Multiple Schools Attended', priority:2,
    q:'Have you attended more than one school during your IB or secondary school years?',
    followups:['Why did you change schools?','Did it cause any disruption to your learning?'],
    impact:['ucas','commonapp'] },

  { id:'R07', category:'R', catName:'Context', title:'Geographic or Cultural Uniqueness', priority:2,
    q:'Does where you grew up or where you studied give you a specific perspective that might not be obvious from your academic record?',
    followups:['What aspects of your context have most shaped how you think about your subject?'],
    impact:['ucas','commonapp','supplemental'] },

  { id:'R08', category:'R', catName:'Context', title:'Family Obligations Alongside IB', priority:2,
    q:'Did any family obligations — supporting siblings, translating for parents, or managing household responsibilities — run alongside your IB studies?',
    followups:['Did this limit any activities or opportunities?'],
    impact:['ucas','commonapp'] },

  { id:'R09', category:'R', catName:'Context', title:'Learning Differences', priority:2,
    q:'Do you have any diagnosed learning differences — dyslexia, ADHD, or processing disorders — that affected how you studied, took exams, or managed coursework?',
    followups:['Did you have accommodations?','Did they help?'],
    impact:['ucas','commonapp'] },

  { id:'R10', category:'R', catName:'Context', title:'Anything Else to Acknowledge', priority:2,
    q:'Is there anything in your background, family situation, or school experience that would help an admissions reader understand your application more accurately — that doesn\'t fit anywhere else?',
    followups:[],
    impact:['ucas','commonapp'] },
];

// ─────────────────────────────────────────────────────────────────────────────
// GAP ANALYSIS LOGIC (server-side)
// ─────────────────────────────────────────────────────────────────────────────
function computeGaps(answers, profile) {
  const yesIds  = new Set(answers.filter(a => a.status === 'yes').map(a => a.question_id));
  const gaps    = [];

  const has = id => yesIds.has(id);

  // Medicine-specific
  if ((profile.target_course || '').toLowerCase().match(/medicine|medical|mbbs|mbchb|dentist/)) {
    if (!has('G05')) gaps.push({ severity:'critical', id:'G05', message:'Medicine applications typically require clinical shadowing. This is usually expected. See the guide for how to arrange it.' });
    if (!has('A06') && !has('A09')) gaps.push({ severity:'moderate', id:'A06', message:'Top medical schools value evidence of scientific enquiry beyond the classroom — an olympiad, science fair, or independent project.' });
  }

  // Law-specific
  if ((profile.target_course || '').toLowerCase().match(/law|llb|jurisprudence/)) {
    if (!has('A10') && !has('A12')) gaps.push({ severity:'moderate', id:'A10', message:'Law applications benefit from essay competitions or debate awards — evidence that you can argue a case under constraint.' });
    if (!has('G06')) gaps.push({ severity:'moderate', id:'G06', message:'Work shadowing at a legal firm gives you concrete evidence that you understand what legal work actually involves.' });
  }

  // UK applicants
  if (profile.applying_uk) {
    if (!has('J01') && !has('J07')) gaps.push({ severity:'critical', id:'J01', message:'UCAS personal statements require evidence of reading and intellectual engagement beyond the classroom. Without this, even strong grades can result in rejection from top UK universities.' });
    if (!has('K03')) gaps.push({ severity:'critical', id:'K03', message:'Some UK courses require admissions tests (UCAT, LNAT, MAT, etc.). Check requirements for each course immediately — missing registration deadlines is unrecoverable.' });
    if (!has('E10')) gaps.push({ severity:'low', id:'E10', message:'The Gold Duke of Edinburgh Award is well regarded for UK university applications, particularly at competitive institutions.' });
  }

  // US applicants
  if (profile.applying_us) {
    if (!has('L01') && !has('L08')) gaps.push({ severity:'critical', id:'L01', message:'Common App essays require a compelling personal narrative. Without a clear turning-point or intellectual curiosity story, the essay will read as a list rather than a character study.' });
    if (!has('M01') && !has('M03') && !has('M09')) gaps.push({ severity:'moderate', id:'M01', message:'US universities practise holistic review and actively look for first-gen, socioeconomic, or adversity context. If this applies to you, not disclosing it is leaving context on the table.' });
  }

  // Leadership gap
  if (!has('B01') && !has('B02') && !has('B03') && !has('B07') && !has('B12')) {
    gaps.push({ severity:'moderate', id:'B03', message:'No leadership role has been identified yet. Starting a club or organising a community project is still achievable if time allows.' });
  }

  // Research / academic depth
  if (!has('A07') && !has('A08') && !has('A09') && !has('C11') && !has('H04')) {
    gaps.push({ severity:'moderate', id:'A07', message:'No independent research or inquiry has been identified. A university lab attachment, science fair entry, or structured independent project would significantly strengthen research-oriented applications.' });
  }

  // Service
  if (!has('F01') && !has('F02') && !has('F06')) {
    gaps.push({ severity:'low', id:'F01', message:'No sustained community service has been identified. A few months of consistent volunteering with one organisation would strengthen the character section of any application.' });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS (server-side only)
// ─────────────────────────────────────────────────────────────────────────────
function buildUCASPrompt(profile, answers) {
  return `You are an expert UK university application counsellor with 15 years of experience helping students gain offers from Oxford, Cambridge, Imperial, UCL, and Russell Group universities.

Generate a UCAS personal statement for the student whose profile and questionnaire answers are provided below.

CONTENT RULES:
1. Maximum 3,900 characters. This is a hard limit — UCAS rejects statements over 4,000 characters.
2. No bullet points. Continuous prose only, flowing academic paragraphs.
3. Do NOT begin with the word "I". This is a UCAS convention — it reads as weak.
4. Every claim must be grounded in a specific detail from the student's profile. No generic platitudes.
5. Structure: (a) Hook + subject motivation, (b) Academic engagement and intellectual curiosity beyond the classroom, (c) Extracurricular and personal qualities that connect to the subject, (d) Future aspirations and contribution to the field.
6. Tone: Formal, intellectual, evidence-specific. Avoid: "passionate", "always", "dream", "ever since I was young".
7. The statement must feel written by THIS student for THEIR subject — not a template with names swapped.
8. If the student has read specific books or papers, name them in the statement.
9. If the student has done research, shadowing, or a lab attachment, make it central.

OUTPUT FORMAT — CRITICAL:
- Do NOT use any markdown whatsoever: no #, ##, ###, **, *, _, ~~, ---, or similar symbols.
- Output ONLY paragraphs of plain prose separated by blank lines.
- This is a continuous personal statement — it has NO section headings. Write it as flowing paragraphs.
- Do not label sections like "Hook:" or "Section 1:". Just write the prose.

Target subject: ${profile.target_course || 'not specified'}
Target universities: ${profile.target_universities || 'not specified'}
Student profile and answers below.`;
}

function buildCommonAppPrompt(profile, answers) {
  return `You are an expert US college admissions counsellor with extensive experience placing students at Ivy League, MIT, Stanford, and liberal arts colleges.

Generate a Common App essay for the student whose profile and questionnaire answers are provided below.

Choose the most suitable Common App prompt based on the student's answers. State the chosen prompt number on the very first line, then write the essay.

CONTENT RULES:
1. Maximum 640 words. NEVER exceed 650 words.
2. First-person narrative, authentic voice.
3. Tell ONE story in depth — not a highlight reel. The essay must have a specific scene, a specific moment.
4. Show the moment — do NOT just describe the outcome. Scene-set: where are you, what do you see, what do you feel?
5. The insight or growth must emerge from the story, not be announced.
6. End with a forward-looking reflection — where does this take you?
7. Avoid: lists of achievements, clichés like "from a young age", generic conclusions like "I learned that anything is possible".
8. The essay must feel impossible to have been written by anyone other than this specific student.

OUTPUT FORMAT — CRITICAL:
- Do NOT use any markdown whatsoever: no #, ##, ###, **, *, _, ~~, ---, or similar symbols.
- The first line should be: Prompt chosen: [number and prompt name]
- Then a blank line, then the essay in flowing paragraphs separated by blank lines.
- No section headings within the essay. Pure prose.
- Do not bold or italicise any words.

Target major: ${profile.target_course || 'not specified'}
Target universities: ${profile.target_universities || 'not specified'}
Student profile and answers below.`;
}

function buildLORPrompt(profile, answers, teacherSubject) {
  return `You are helping a student prepare a briefing document for their teacher who will write a Letter of Recommendation.

Generate a structured LOR briefing document — NOT the letter itself. This is a document the STUDENT gives to the TEACHER to help the teacher write a strong letter.

The document should include these sections in order:
1. A salutation to the teacher
2. Context: which universities and courses this letter is for, and what those programmes value
3. Key qualities this teacher is uniquely placed to speak to (based on their subject)
4. Specific incidents or moments from class the teacher witnessed and could reference
5. What other recommenders are likely covering (to avoid duplication)
6. Concrete asks: specific examples, skills, or qualities the student hopes will be mentioned
7. Tone and length guidance for the teacher
8. A polite closing

OUTPUT FORMAT — CRITICAL:
- Do NOT use any markdown: no #, ##, ###, **, *, _, ~~, ---, or similar symbols.
- Use plain section headings written in title case on their own line, followed by the text (e.g. "Context" then the paragraph below it).
- Write the salutation (Dear [Teacher name or "Dear Sir/Madam"]) as the first line.
- Write the closing sign-off as the last line.
- Paragraphs should be separated by a blank line.
- No bullet points — write each point as a sentence or short paragraph.

Teacher's subject: ${teacherSubject || 'not specified'}
Target universities: ${profile.target_universities || 'not specified'}
Student profile and answers below.`;
}

function buildSOPPrompt(profile, answers) {
  return `You are an expert graduate admissions counsellor.

Generate a Statement of Purpose for the student whose profile and questionnaire answers are provided below.

CONTENT RULES:
1. 600–900 words. Academic and professional in tone.
2. Structure: (a) Specific research interest or professional motivation, (b) Academic background and relevant achievements, (c) Specific relevant experience, (d) Why this particular programme, (e) Career goals.
3. Every claim must be grounded in a specific detail from the profile.
4. Name specific faculty members or research groups at the target university if provided.
5. Avoid: generic statements of ambition, vague claims of passion, listing grades without context.

OUTPUT FORMAT — CRITICAL:
- Do NOT use any markdown: no #, ##, ###, **, *, _, ~~, ---, or similar symbols.
- Write in flowing paragraphs only. No section headings — the sections should flow naturally.
- Paragraphs separated by a blank line.
- No bullet points. Pure prose.

Target programme: ${profile.target_course || 'not specified'}
Target universities: ${profile.target_universities || 'not specified'}
Student profile and answers below.`;
}

function buildSupplementalPrompt(profile, answers, university, essayPrompt) {
  return `You are an expert US college admissions counsellor.

Generate a supplemental essay for the student's application to ${university}.

Essay prompt: "${essayPrompt}"

CONTENT RULES:
1. 300–350 words unless a different limit is specified in the prompt.
2. Be specific to THIS university — generic "I love this school" essays fail.
3. If "Why Us?": reference specific programmes, faculty, research centres, clubs, or traditions. Never say "prestigious" or "diverse community".
4. If "Diversity/Identity": connect the student's background to what they will contribute to campus life.
5. First-person. Authentic voice. Specific details.

OUTPUT FORMAT — CRITICAL:
- Do NOT use any markdown: no #, ##, ###, **, *, _, ~~, ---, or similar symbols.
- Write in flowing paragraphs only. No headings. No labels.
- Paragraphs separated by a blank line.
- No bullet points. Pure prose.

Student profile and answers below.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLUGIN
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function uniApply(fastify) {

  // Health
  fastify.get('/health', async () => ({ tool: 'uni-apply', status: 'ok', questions: QUESTIONS.length }));

  // ── GET /profile ────────────────────────────────────────────────────────────
  fastify.get('/profile', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    try {
      const { rows } = await pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]);
      return reply.send({ profile: rows[0] || null });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /profile ───────────────────────────────────────────────────────────
  fastify.post('/profile', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const b = request.body || {};
    try {
      await pool.query(`
        INSERT INTO uni_apply_profiles
          (user_id, name, nationality, ib_year, predicted_score, actual_score,
           target_course, target_countries, target_universities,
           applying_uk, applying_us, applying_other, intended_career, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT(user_id) DO UPDATE SET
          name=$2, nationality=$3, ib_year=$4, predicted_score=$5, actual_score=$6,
          target_course=$7, target_countries=$8, target_universities=$9,
          applying_uk=$10, applying_us=$11, applying_other=$12,
          intended_career=$13, updated_at=NOW()
      `, [
        userId,
        (b.name || '').substring(0, 120),
        (b.nationality || '').substring(0, 80),
        b.ib_year || null,
        b.predicted_score || null,
        b.actual_score || null,
        (b.target_course || '').substring(0, 200),
        (b.target_countries || '').substring(0, 400),
        (b.target_universities || '').substring(0, 2000),
        b.applying_uk || false,
        b.applying_us || false,
        (b.applying_other || '').substring(0, 200),
        (b.intended_career || '').substring(0, 300),
      ]);
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── GET /doc-progress ───────────────────────────────────────────────────────
  // Returns per-document-type progress: how many required questions answered,
  // how many remain, and whether the generation threshold is met.
  fastify.get('/doc-progress', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    try {
      const answersRes = await pool.query(
        'SELECT question_id, status FROM uni_apply_answers WHERE user_id = $1',
        [userId]
      );
      const answered = new Set(answersRes.rows.map(r => r.question_id));
      const progress = {};
      for (const [docType, minRequired] of Object.entries(MIN_ANSWERS)) {
        // questions relevant to this doc type
        const relevant = QUESTIONS.filter(q => q.impact.includes(docType === 'lor-brief' ? 'lor' : docType));
        const answeredCount = relevant.filter(q => answered.has(q.id)).length;
        progress[docType] = {
          required:      minRequired,
          answered:      answeredCount,
          total:         relevant.length,
          remaining:     Math.max(0, minRequired - answeredCount),
          can_generate:  answeredCount >= minRequired,
          pct:           Math.min(100, Math.round((answeredCount / minRequired) * 100)),
        };
      }
      return reply.send({ progress });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── GET /questions/for-doc ───────────────────────────────────────────────────
  // Returns the next unanswered questions for a specific document type,
  // along with progress toward the generation threshold.
  fastify.get('/questions/for-doc', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const docType = (request.query.type || '').toLowerCase();
    const impactKey = docType === 'lor-brief' ? 'lor' : docType;
    const count   = Math.min(parseInt(request.query.count || '5', 10), 10);

    if (!MIN_ANSWERS[docType]) {
      return reply.code(400).send({ error: `Unknown document type: ${docType}` });
    }

    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status FROM uni_apply_answers WHERE user_id = $1', [userId]),
      ]);
      const profile     = profileRes.rows[0] || {};
      const answeredMap = new Map(answersRes.rows.map(r => [r.question_id, r.status]));

      // Get all questions relevant to this doc type
      const relevant = QUESTIONS.filter(q => {
        if (!q.impact.includes(impactKey)) return false;
        if (q.askIf && !profile[q.askIf]) return false;
        return true;
      });

      const unanswered = relevant
        .filter(q => !answeredMap.has(q.id))
        .sort((a, b) => (a.priority || 2) - (b.priority || 2))
        .slice(0, count)
        .map(q => ({
          id: q.id, category: q.category, catName: q.catName,
          title: q.title, question: q.q,
          followups: q.followups, acquirable: q.acquirable || false,
          guide: q.guide || null, impact: q.impact,
        }));

      const answeredCount = relevant.filter(q => answeredMap.has(q.id)).length;
      const minRequired   = MIN_ANSWERS[docType];

      return reply.send({
        questions:     unanswered,
        doc_type:      docType,
        answered:      answeredCount,
        required:      minRequired,
        remaining:     Math.max(0, minRequired - answeredCount),
        can_generate:  answeredCount >= minRequired,
        total_relevant: relevant.length,
        pct:           Math.min(100, Math.round((answeredCount / minRequired) * 100)),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── GET /questions/next ─────────────────────────────────────────────────────
  // Returns the next N questions the student hasn't answered yet
  fastify.get('/questions/next', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const count = Math.min(parseInt(request.query.count || '4', 10), 8);
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id FROM uni_apply_answers WHERE user_id = $1', [userId]),
      ]);
      const profile    = profileRes.rows[0] || {};
      const answeredIds = new Set(answersRes.rows.map(r => r.question_id));

      const eligible = QUESTIONS.filter(q => {
        if (answeredIds.has(q.id)) return false;
        if (q.askIf) {
          if (!profile[q.askIf]) return false;
        }
        return true;
      });

      // Sort by priority then original order
      eligible.sort((a, b) => (a.priority || 2) - (b.priority || 2));
      const next = eligible.slice(0, count).map(q => ({
        id: q.id,
        category: q.category,
        catName: q.catName,
        title: q.title,
        question: q.q,
        followups: q.followups,
        acquirable: q.acquirable || false,
        guide: q.guide || null,
        impact: q.impact,
      }));

      return reply.send({
        questions: next,
        remaining: eligible.length,
        total: QUESTIONS.length,
        answered: answeredIds.size,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /questions/answer ──────────────────────────────────────────────────
  fastify.post('/questions/answer', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const { question_id, status, main_answer, followup_answers } = request.body || {};
    if (!question_id || !status) return reply.code(400).send({ error: 'question_id and status required' });
    if (!['yes','no','in_progress','skipped'].includes(status)) {
      return reply.code(400).send({ error: 'status must be yes, no, in_progress, or skipped' });
    }
    const q = QUESTIONS.find(q => q.id === question_id);
    if (!q) return reply.code(404).send({ error: 'Unknown question ID' });

    try {
      await pool.query(`
        INSERT INTO uni_apply_answers
          (user_id, question_id, status, main_answer, followup_answers, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT(user_id, question_id) DO UPDATE SET
          status=$3, main_answer=$4, followup_answers=$5, updated_at=NOW()
      `, [
        userId,
        question_id,
        status,
        (main_answer || '').substring(0, 4000),
        followup_answers ? JSON.stringify(followup_answers).substring(0, 6000) : null,
      ]);

      // Auto-create achievement entry for yes answers
      if (status === 'yes' && main_answer) {
        await pool.query(`
          INSERT INTO uni_apply_achievements
            (user_id, question_id, category, title, description, impact_docs)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT DO NOTHING
        `, [
          userId,
          question_id,
          q.category,
          q.title,
          (main_answer || '').substring(0, 2000),
          q.impact.join(','),
        ]).catch(() => {}); // non-fatal if fails due to no unique constraint
      }

      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── GET /answers ────────────────────────────────────────────────────────────
  fastify.get('/answers', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    try {
      const { rows } = await pool.query(
        'SELECT question_id, status, main_answer, followup_answers, updated_at FROM uni_apply_answers WHERE user_id = $1 ORDER BY updated_at DESC',
        [userId]
      );
      // Enrich with question metadata (title, category) — safe to share
      const enriched = rows.map(r => {
        const q = QUESTIONS.find(q => q.id === r.question_id);
        return {
          ...r,
          title: q?.title || r.question_id,
          category: q?.category || '?',
          catName: q?.catName || '',
          impact: q?.impact || [],
        };
      });
      return reply.send({ answers: enriched });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── GET /summary ─────────────────────────────────────────────────────────────
  // Profile completeness + progress stats
  fastify.get('/summary', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status FROM uni_apply_answers WHERE user_id = $1', [userId]),
      ]);
      const profile   = profileRes.rows[0] || {};
      const answers   = answersRes.rows;
      const yesCount  = answers.filter(a => a.status === 'yes').length;
      const totalAnswered = answers.length;
      const pct = Math.round((totalAnswered / QUESTIONS.length) * 100);

      // Category breakdown
      const cats = {};
      for (const q of QUESTIONS) {
        if (!cats[q.category]) cats[q.category] = { name: q.catName, total: 0, answered: 0, yes: 0 };
        cats[q.category].total++;
        const ans = answers.find(a => a.question_id === q.id);
        if (ans) { cats[q.category].answered++; if (ans.status === 'yes') cats[q.category].yes++; }
      }

      return reply.send({
        profile_set: !!profileRes.rows[0],
        profile,
        total_questions: QUESTIONS.length,
        answered: totalAnswered,
        yes_count: yesCount,
        completion_pct: pct,
        categories: cats,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── GET /gap-analysis ────────────────────────────────────────────────────────
  fastify.get('/gap-analysis', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status FROM uni_apply_answers WHERE user_id = $1', [userId]),
      ]);
      const profile = profileRes.rows[0] || {};
      const answers = answersRes.rows;
      const gaps    = computeGaps(answers, profile);

      // Also find questions that are acquirable and not yet yes
      const yesIds  = new Set(answers.filter(a => a.status === 'yes').map(a => a.question_id));
      const acquirableOpportunities = QUESTIONS
        .filter(q => q.acquirable && !yesIds.has(q.id) && q.guide)
        .slice(0, 8)
        .map(q => ({ id: q.id, title: q.title, category: q.catName, guide: q.guide, impact: q.impact }));

      return reply.send({ gaps, acquirable: acquirableOpportunities });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /generate/ucas ───────────────────────────────────────────────────────
  fastify.post('/generate/ucas', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const key = getGeminiKey(request, reply);
    if (!key) return;
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status, main_answer, followup_answers FROM uni_apply_answers WHERE user_id = $1 AND status = $2', [userId, 'yes']),
      ]);
      const profile = profileRes.rows[0] || {};
      const answers = answersRes.rows;

      // Threshold check: count answered (any status) questions relevant to UCAS
      const allAnswersRes = await pool.query(
        'SELECT question_id FROM uni_apply_answers WHERE user_id = $1', [userId]
      );
      const answeredIds   = new Set(allAnswersRes.rows.map(r => r.question_id));
      const ucasAnswered  = QUESTIONS.filter(q => q.impact.includes('ucas') && answeredIds.has(q.id)).length;
      if (ucasAnswered < MIN_ANSWERS.ucas) {
        return reply.code(400).send({
          error: `Answer at least ${MIN_ANSWERS.ucas} UCAS-related questions before generating. You've answered ${ucasAnswered} so far — ${MIN_ANSWERS.ucas - ucasAnswered} more to go.`,
          answered: ucasAnswered, required: MIN_ANSWERS.ucas,
        });
      }

      const systemPrompt = buildUCASPrompt(profile, answers);
      const userContent  = `STUDENT PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nCOMPLETED QUESTIONNAIRE (yes answers only):\n${answers.map(a => {
        const q = QUESTIONS.find(q => q.id === a.question_id);
        return `[${a.question_id}] ${q?.title || ''}\nAnswer: ${a.main_answer || ''}\n${a.followup_answers ? 'Details: ' + a.followup_answers : ''}`;
      }).join('\n\n')}`;

      const model = (request.body || {}).model || DEFAULT_MODEL;
      const text  = await callGemini(key, systemPrompt, userContent, model);
      return reply.send({ document: text, type: 'ucas' });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /generate/commonapp ──────────────────────────────────────────────────
  fastify.post('/generate/commonapp', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const key = getGeminiKey(request, reply);
    if (!key) return;
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status, main_answer, followup_answers FROM uni_apply_answers WHERE user_id = $1 AND status = $2', [userId, 'yes']),
      ]);
      const profile = profileRes.rows[0] || {};
      const answers = answersRes.rows;

      const allAnswersRes2 = await pool.query(
        'SELECT question_id FROM uni_apply_answers WHERE user_id = $1', [userId]
      );
      const answeredIds2   = new Set(allAnswersRes2.rows.map(r => r.question_id));
      const caAnswered     = QUESTIONS.filter(q => q.impact.includes('commonapp') && answeredIds2.has(q.id)).length;
      if (caAnswered < MIN_ANSWERS.commonapp) {
        return reply.code(400).send({
          error: `Answer at least ${MIN_ANSWERS.commonapp} Common App-related questions before generating. You've answered ${caAnswered} so far — ${MIN_ANSWERS.commonapp - caAnswered} more to go.`,
          answered: caAnswered, required: MIN_ANSWERS.commonapp,
        });
      }

      const systemPrompt = buildCommonAppPrompt(profile, answers);
      const userContent  = `STUDENT PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nQUESTIONNAIRE ANSWERS:\n${answers.map(a => {
        const q = QUESTIONS.find(q => q.id === a.question_id);
        return `[${a.question_id}] ${q?.title || ''}\nAnswer: ${a.main_answer || ''}\n${a.followup_answers ? 'Details: ' + a.followup_answers : ''}`;
      }).join('\n\n')}`;

      const model = (request.body || {}).model || DEFAULT_MODEL;
      const text  = await callGemini(key, systemPrompt, userContent, model);
      return reply.send({ document: text, type: 'commonapp' });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /generate/lor-brief ──────────────────────────────────────────────────
  fastify.post('/generate/lor-brief', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const key = getGeminiKey(request, reply);
    if (!key) return;
    const teacherSubject = ((request.body || {}).teacher_subject || '').substring(0, 120);
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status, main_answer, followup_answers FROM uni_apply_answers WHERE user_id = $1 AND status = $2', [userId, 'yes']),
      ]);
      const profile = profileRes.rows[0] || {};
      const answers = answersRes.rows;

      const allAnswersRes3 = await pool.query(
        'SELECT question_id FROM uni_apply_answers WHERE user_id = $1', [userId]
      );
      const answeredIds3  = new Set(allAnswersRes3.rows.map(r => r.question_id));
      const lorAnswered   = QUESTIONS.filter(q => q.impact.includes('lor') && answeredIds3.has(q.id)).length;
      if (lorAnswered < MIN_ANSWERS['lor-brief']) {
        return reply.code(400).send({
          error: `Answer at least ${MIN_ANSWERS['lor-brief']} questions relevant to your LOR before generating. You've answered ${lorAnswered} so far — ${MIN_ANSWERS['lor-brief'] - lorAnswered} more to go.`,
          answered: lorAnswered, required: MIN_ANSWERS['lor-brief'],
        });
      }

      const systemPrompt = buildLORPrompt(profile, answers, teacherSubject);
      const userContent  = `STUDENT PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nQUESTIONNAIRE ANSWERS:\n${answers.map(a => {
        const q = QUESTIONS.find(q => q.id === a.question_id);
        return `[${a.question_id}] ${q?.title || ''}\nAnswer: ${a.main_answer || ''}`;
      }).join('\n\n')}`;

      const model = (request.body || {}).model || DEFAULT_MODEL;
      const text  = await callGemini(key, systemPrompt, userContent, model);
      return reply.send({ document: text, type: 'lor-brief', teacher_subject: teacherSubject });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /generate/sop ───────────────────────────────────────────────────────
  fastify.post('/generate/sop', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const key = getGeminiKey(request, reply);
    if (!key) return;
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status, main_answer, followup_answers FROM uni_apply_answers WHERE user_id = $1 AND status = $2', [userId, 'yes']),
      ]);
      const profile = profileRes.rows[0] || {};
      const answers = answersRes.rows;

      const allAnswersRes4 = await pool.query(
        'SELECT question_id FROM uni_apply_answers WHERE user_id = $1', [userId]
      );
      const answeredIds4  = new Set(allAnswersRes4.rows.map(r => r.question_id));
      const sopAnswered   = QUESTIONS.filter(q => q.impact.includes('sop') && answeredIds4.has(q.id)).length;
      if (sopAnswered < MIN_ANSWERS.sop) {
        return reply.code(400).send({
          error: `Answer at least ${MIN_ANSWERS.sop} SOP-related questions before generating. You've answered ${sopAnswered} so far — ${MIN_ANSWERS.sop - sopAnswered} more to go.`,
          answered: sopAnswered, required: MIN_ANSWERS.sop,
        });
      }

      const systemPrompt = buildSOPPrompt(profile, answers);
      const userContent  = `STUDENT PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nQUESTIONNAIRE ANSWERS:\n${answers.map(a => {
        const q = QUESTIONS.find(q => q.id === a.question_id);
        return `[${a.question_id}] ${q?.title || ''}\nAnswer: ${a.main_answer || ''}`;
      }).join('\n\n')}`;

      const model = (request.body || {}).model || DEFAULT_MODEL;
      const text  = await callGemini(key, systemPrompt, userContent, model);
      return reply.send({ document: text, type: 'sop' });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── POST /generate/supplemental ──────────────────────────────────────────────
  fastify.post('/generate/supplemental', async (request, reply) => {
    const userId = getUser(request, reply);
    if (!userId) return;
    const key = getGeminiKey(request, reply);
    if (!key) return;
    const { university, essay_prompt, model } = request.body || {};
    if (!university || !essay_prompt) return reply.code(400).send({ error: 'university and essay_prompt required' });
    try {
      const [profileRes, answersRes] = await Promise.all([
        pool.query('SELECT * FROM uni_apply_profiles WHERE user_id = $1', [userId]),
        pool.query('SELECT question_id, status, main_answer, followup_answers FROM uni_apply_answers WHERE user_id = $1 AND status = $2', [userId, 'yes']),
      ]);
      const profile = profileRes.rows[0] || {};
      const answers = answersRes.rows;

      const allAnswersRes5 = await pool.query('SELECT question_id FROM uni_apply_answers WHERE user_id = $1', [userId]);
      const answeredIds5   = new Set(allAnswersRes5.rows.map(r => r.question_id));
      const suppAnswered   = QUESTIONS.filter(q => q.impact.includes('supplemental') && answeredIds5.has(q.id)).length;
      if (suppAnswered < MIN_ANSWERS.supplemental) {
        return reply.code(400).send({
          error: `Answer at least ${MIN_ANSWERS.supplemental} questions before generating a supplemental essay. You have answered ${suppAnswered} so far.`,
          answered: suppAnswered, required: MIN_ANSWERS.supplemental,
        });
      }

      const systemPrompt = buildSupplementalPrompt(profile, answers, university, essay_prompt);
      const userContent  = `STUDENT PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nQUESTIONNAIRE ANSWERS:\n${answers.map(a => {
        const q = QUESTIONS.find(q => q.id === a.question_id);
        return `[${a.question_id}] ${q?.title || ''}\nAnswer: ${a.main_answer || ''}`;
      }).join('\n\n')}`;

      const text = await callGemini(key, systemPrompt, userContent, model || DEFAULT_MODEL);
      return reply.send({ document: text, type: 'supplemental' });
    } catch (err) {
      return sendError(reply, err);
    }
  });

};
r) {
      return sendError(reply, err);
    }
  });

};
