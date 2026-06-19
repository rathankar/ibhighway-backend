const pool = require('../db');

// Exported so tools-auth.js can use it for the standalone deadline tool
const MILESTONE_TEMPLATES = {
  ia: [
    { key: 'rq',                title: 'Finalize Research Question',     weeksOffset: -8, order: 1,
      description: 'Lock in a precise, measurable RQ with clearly defined independent, dependent, and controlled variables. Criterion A starts here.' },
    { key: 'background',        title: 'Complete Background Theory',     weeksOffset: -7, order: 2,
      description: 'Write the scientific context relevant to your RQ. Justify your experimental approach with theory.' },
    { key: 'methodology',       title: 'Finalize Methodology & Safety',  weeksOffset: -6, order: 3,
      description: 'Confirm your procedure, list all equipment, define controls, and document safety/ethical considerations.' },
    { key: 'data_collection',   title: 'Complete Data Collection',       weeksOffset: -5, order: 4,
      description: 'Record all raw data in well-labelled tables with correct units and uncertainties.' },
    { key: 'data_processing',   title: 'Process & Analyse Data',         weeksOffset: -4, order: 5,
      description: 'Calculate processed results, plot graphs with error bars, propagate uncertainties.' },
    { key: 'first_draft',       title: 'Write First Complete Draft',     weeksOffset: -3, order: 6,
      description: 'Write a complete draft covering all criteria. Include bibliography and check word count.' },
    { key: 'supervisor_review', title: 'Submit for Supervisor Review',   weeksOffset: -2, order: 7,
      description: 'Give your teacher the draft. This is your formal feedback round — act on every comment.' },
    { key: 'final_revision',    title: 'Final Revision & Format Check',  weeksOffset: -1, order: 8,
      description: 'Apply all feedback, verify citations, check 12-page maximum, export as PDF.' },
    { key: 'submission',        title: '🏁 School Submission Deadline',  weeksOffset:  0, order: 9,
      description: 'Submit your final IA to your school coordinator.' },
  ],
  ee: [
    { key: 'topic_rq',           title: 'Finalize Topic & Research Question', weeksOffset: -16, order: 1,
      description: 'Confirm your subject and narrow your topic. Use the EE Compass tool to check RQ viability.' },
    { key: 'research',           title: 'Complete Primary Research',          weeksOffset: -13, order: 2,
      description: 'Read all sources, annotate, and identify gaps. Keep a research log for your RPPF.' },
    { key: 'rppf_1',             title: 'Write RPPF Entry 1',                 weeksOffset: -12, order: 3,
      description: 'Reflect on your initial planning, topic choice, and research strategy (~300 words).' },
    { key: 'outline',            title: 'Create Detailed Essay Outline',      weeksOffset: -10, order: 4,
      description: 'Structure your argument: intro, body sections with claims and counter-claims, conclusion.' },
    { key: 'first_draft',        title: 'Write First Draft (~4,000 words)',   weeksOffset: -8, order: 5,
      description: 'Get your full argument down in writing. Do not self-censor — revise later.' },
    { key: 'supervisor_1',       title: 'Supervisor Review Session 1',        weeksOffset: -7, order: 6,
      description: 'Submit draft to your supervisor. Document the session — it feeds into RPPF.' },
    { key: 'second_draft',       title: 'Write Second Draft',                 weeksOffset: -5, order: 7,
      description: 'Revise incorporating supervisor feedback. Focus on critical analysis quality.' },
    { key: 'rppf_2',             title: 'Write RPPF Entry 2',                 weeksOffset: -4, order: 8,
      description: 'Reflect on your research journey, challenges, and how your argument evolved.' },
    { key: 'supervisor_2',       title: 'Supervisor Review Session 2',        weeksOffset: -3, order: 9,
      description: 'Final supervisor session. Agree on remaining changes. Document for RPPF Entry 3.' },
    { key: 'final_revision',     title: 'Final Revision & Word Count Check',  weeksOffset: -2, order: 10,
      description: 'Max 4,000 words. Consistent citation style. Proofread everything.' },
    { key: 'rppf_3',             title: 'Write RPPF Entry 3 (Final)',         weeksOffset: -1, order: 11,
      description: 'Final reflection: what did you learn? How did this change your thinking?' },
    { key: 'submission',         title: '🏁 School Submission Deadline',      weeksOffset:  0, order: 12,
      description: 'Submit final EE + RPPF to your school coordinator.' },
  ],
  tok: [
    { key: 'title_selection',  title: 'Choose Your Prescribed Title',         weeksOffset: -8, order: 1,
      description: 'Read all six titles carefully. Choose the one that genuinely interests you — you will spend weeks with it.' },
    { key: 'kq_development',   title: 'Develop Your Knowledge Questions',     weeksOffset: -7, order: 2,
      description: 'Identify the central KQs driving your essay. Each body paragraph should address a distinct KQ.' },
    { key: 'outline',          title: 'Write Argument Outline with RLS',      weeksOffset: -6, order: 3,
      description: 'Map: claim → counter-claim → mini-conclusion per section. Attach one Real-Life Situation to each claim.' },
    { key: 'first_draft',      title: 'Write First Draft (~1,600 words)',     weeksOffset: -5, order: 4,
      description: 'Write the full essay using TOK vocabulary: claims, counter-claims, implications, RLS.' },
    { key: 'teacher_review',   title: 'Teacher Review Session',               weeksOffset: -3, order: 5,
      description: 'Submit to your TOK teacher. They can advise structurally but not correct content — note the difference.' },
    { key: 'second_draft',     title: 'Write Second Draft',                   weeksOffset: -2, order: 6,
      description: 'Revise incorporating feedback. Ensure argument flows logically and all KQs are addressed.' },
    { key: 'final_polish',     title: 'Final Polish & Proofread',             weeksOffset: -1, order: 7,
      description: 'Check max 1,600 words. Citation format. Ensure your prescribed title is stated explicitly.' },
    { key: 'submission',       title: '🏁 School Submission Deadline',        weeksOffset:  0, order: 8,
      description: 'Submit your final TOK essay to your school coordinator.' },
  ],
  fa: [
    { key: 'film_analysis',    title: 'Choose & Analyse Film Text',          weeksOffset: -6, order: 1,
      description: 'Select your film(s). Watch analytically with notes on cinematography, editing, sound, and narrative. Identify the specific aspect you will write about.' },
    { key: 'outline',          title: 'Write Analysis Outline',              weeksOffset: -4, order: 2,
      description: 'Plan your argument: which filmic techniques will you analyse, and what claim will your analysis make?' },
    { key: 'first_draft',      title: 'Write First Draft',                   weeksOffset: -3, order: 3,
      description: 'Write the full Film Assessment using precise film terminology. Check word limit.' },
    { key: 'teacher_review',   title: 'Teacher Review',                      weeksOffset: -2, order: 4,
      description: 'Submit to your Film teacher for feedback. Note: they can comment on structure but not content in detail.' },
    { key: 'submission',       title: '🏁 Film Assessment Submission',       weeksOffset:  0, order: 5,
      description: 'Submit your final Film Assessment to your school coordinator.' },
  ],
  portfolio: [
    { key: 'work_selection',   title: 'Select Work to Include',              weeksOffset: -5, order: 1,
      description: 'Decide which pieces best represent your learning journey. Check the minimum and maximum requirements from your subject guide.' },
    { key: 'write_rationale',  title: 'Write Rationale / Reflections',       weeksOffset: -3, order: 2,
      description: 'Write the accompanying reflective commentary or rationale for each selected piece.' },
    { key: 'compile',          title: 'Compile & Format Portfolio',          weeksOffset: -2, order: 3,
      description: 'Assemble all pieces, rationale, and any cover page. Check formatting and page/word limits.' },
    { key: 'submission',       title: '🏁 Portfolio Submission Deadline',    weeksOffset:  0, order: 4,
      description: 'Submit your completed portfolio to your school coordinator.' },
  ],
  mock: [
    { key: 'revision_start',   title: 'Begin Structured Revision',           weeksOffset: -3, order: 1,
      description: 'Start active revision — use past papers, mark schemes, and topic summaries. Cover all syllabus topics systematically.' },
    { key: 'past_papers',      title: 'Complete Past Paper Practice',        weeksOffset: -1, order: 2,
      description: 'Complete at least 2 full past papers under timed conditions. Mark them honestly using mark schemes.' },
    { key: 'submission',       title: '📝 Mock Exam Day',                    weeksOffset:  0, order: 3,
      description: 'Your mock exam. Arrive on time, bring approved equipment, and read each question carefully before answering.' },
  ],
  custom: [
    { key: 'start',            title: 'Begin Work on Submission',            weeksOffset: -3, order: 1,
      description: 'Start working on this submission. Clarify requirements with your teacher if anything is unclear.' },
    { key: 'draft',            title: 'Complete Draft / First Version',      weeksOffset: -1, order: 2,
      description: 'Have a complete draft ready for review or self-checking against submission requirements.' },
    { key: 'submission',       title: '🏁 Submission Deadline',              weeksOffset:  0, order: 3,
      description: 'Submit your final work by this date.' },
  ],
};

const VALID_TYPES = ['ia', 'ee', 'tok', 'fa', 'portfolio', 'mock', 'custom'];

// Accept YYYY-MM-DD or DD-MM-YYYY (or DD/MM/YYYY), always return YYYY-MM-DD
function normalizeDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // DD-MM-YYYY or DD/MM/YYYY
  const m = str.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function generateMilestoneDates(schoolDeadline, templates) {
  const deadline = new Date(schoolDeadline + 'T00:00:00');
  return templates.map(t => {
    const due = new Date(deadline);
    due.setDate(due.getDate() + t.weeksOffset * 7);
    return { ...t, due_date: due.toISOString().split('T')[0] };
  });
}

module.exports = async function deadlineRoutes(app) {

  // POST /api/deadlines — create deadline + auto-generated milestones
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    const { assessment_type, subject, title, call_consent, days_before_reminder } = req.body || {};
    const rawDeadline = req.body?.school_deadline;
    const daysReminder = parseInt(days_before_reminder) || 7;

    if (!assessment_type || !rawDeadline)
      return reply.code(400).send({ error: 'assessment_type and school_deadline are required' });

    const normalizedType = (assessment_type || '').toLowerCase().trim();
    if (!VALID_TYPES.includes(normalizedType))
      return reply.code(400).send({ error: `assessment_type must be one of: ${VALID_TYPES.join(', ')}` });

    const school_deadline = normalizeDate(rawDeadline);
    if (!school_deadline)
      return reply.code(400).send({ error: 'school_deadline must be in YYYY-MM-DD or DD-MM-YYYY format (e.g. 2025-11-30 or 30-11-2025)' });

    const effectiveSubject = subject || title || 'General';
    const milestones = generateMilestoneDates(school_deadline, MILESTONE_TEMPLATES[normalizedType]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (call_consent === true || call_consent === false) {
        await client.query(
          'UPDATE users SET call_consent=$1 WHERE id=$2',
          [!!call_consent, req.user.id]
        );
      }

      const dRes = await client.query(
        `INSERT INTO student_deadlines (student_id, assessment_type, subject, title, school_deadline, days_before_reminder)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
         ON CONFLICT DO NOTHING`,
        [req.user.id, normalizedType, effectiveSubject, title || null, school_deadline, daysReminder]
      ).catch(() => client.query(
        `INSERT INTO student_deadlines (student_id, assessment_type, subject, title, school_deadline)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.user.id, normalizedType, effectiveSubject, title || null, school_deadline]
      ));
      const deadlineId = dRes.rows[0].id;

      for (const m of milestones) {
        await client.query(
          `INSERT INTO deadline_milestones (deadline_id, milestone_key, title, description, due_date, order_index)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [deadlineId, m.key, m.title, m.description, m.due_date, m.order]
        );
      }

      await client.query('COMMIT');

      const full = await pool.query(
        `SELECT d.*, json_agg(m ORDER BY m.order_index) AS milestones
         FROM student_deadlines d
         LEFT JOIN deadline_milestones m ON m.deadline_id = d.id
         WHERE d.id=$1 GROUP BY d.id`,
        [deadlineId]
      );
      return reply.code(201).send(full.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /api/deadlines — list my active deadlines with milestones
  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    if (req.user.role !== 'student') return { deadlines: [] };
    const res = await pool.query(
      `SELECT d.*, json_agg(m ORDER BY m.order_index) AS milestones
       FROM student_deadlines d
       LEFT JOIN deadline_milestones m ON m.deadline_id = d.id
       WHERE d.student_id=$1 AND d.is_active=TRUE
       GROUP BY d.id ORDER BY d.school_deadline ASC`,
      [req.user.id]
    );
    return { deadlines: res.rows };
  });

  // PATCH /api/deadlines/milestones/:id — toggle milestone complete
  app.patch('/milestones/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });
    const { is_completed } = req.body || {};
    const chk = await pool.query(
      `SELECT m.id FROM deadline_milestones m
       JOIN student_deadlines d ON m.deadline_id=d.id
       WHERE m.id=$1 AND d.student_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!chk.rows[0]) return reply.code(404).send({ error: 'Milestone not found' });
    await pool.query(
      `UPDATE deadline_milestones SET is_completed=$1, completed_at=$2 WHERE id=$3`,
      [!!is_completed, is_completed ? new Date() : null, req.params.id]
    );
    return { ok: true };
  });

  // DELETE /api/deadlines/:id — soft-delete a deadline
  app.delete('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });
    const res = await pool.query(
      `UPDATE student_deadlines SET is_active=FALSE, updated_at=NOW()
       WHERE id=$1 AND student_id=$2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Deadline not found' });
    return { ok: true };
  });
};

module.exports.MILESTONE_TEMPLATES = MILESTONE_TEMPLATES;
