const pool = require('../db');
const { MILESTONE_TEMPLATES } = require('./milestone-templates');

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

