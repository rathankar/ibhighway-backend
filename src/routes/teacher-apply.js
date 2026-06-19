const pool  = require('../db');
const email = require('../email');

// Teacher registration is FREE.
// Platform earns Rs.1000 from the teacher's FIRST student booking,
// then 10% of every subsequent session fee.

const MIN_HOURLY_RATE = 1500; // Rs. minimum per session

module.exports = async function teacherApplyRoutes(app) {

  const publicLimit = {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  };

  // POST /api/teacher-apply
  app.post('/', publicLimit, async (req, reply) => {
    const b = req.body || {};
    const required = [
      'name','email','phone','teaching_statement',
      'id_card_drive_link','proof_drive_link','gdrive_video_link',
      'subjects','levels','years_experience','hourly_rate',
    ];
    for (const k of required) {
      if (!b[k] || (Array.isArray(b[k]) ? b[k].length === 0 : String(b[k]).trim() === '')) {
        return reply.code(400).send({ error: k + ' is required' });
      }
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) {
      return reply.code(400).send({ error: 'Please provide a valid email address' });
    }
    if (parseFloat(b.hourly_rate) < MIN_HOURLY_RATE) {
      return reply.code(400).send({ error: 'Minimum hourly rate is Rs.' + MIN_HOURLY_RATE });
    }

    const ia_guidance  = !!b.ia_guidance;
    const ia_fee       = ia_guidance  ? parseFloat(b.ia_fee  || 0) : 0;
    const ee_guidance  = !!b.ee_guidance;
    const ee_fee       = ee_guidance  ? parseFloat(b.ee_fee  || 0) : 0;
    const tok_guidance = !!b.tok_guidance;
    const tok_fee      = tok_guidance ? parseFloat(b.tok_fee || 0) : 0;

    const [dupApp, dupUser] = await Promise.all([
      pool.query('SELECT id FROM teacher_applications WHERE email=$1', [b.email.trim().toLowerCase()]),
      pool.query('SELECT id FROM users WHERE email=$1', [b.email.trim().toLowerCase()]),
    ]);
    if (dupApp.rows[0] || dupUser.rows[0]) {
      return reply.code(409).send({ error: 'An application or account already exists for this email address.' });
    }

    try {
      // terms_accepted from application form — formal acceptance via one-time link after approval
      const termsAccepted = !!b.terms_accepted;

      const appRes = await pool.query(
        `INSERT INTO teacher_applications (
           name, email, phone, teaching_statement, institution,
           id_card_drive_link, proof_drive_link, gdrive_video_link,
           subjects, levels, years_experience, hourly_rate, photo_url,
           ia_guidance, ia_fee, ee_guidance, ee_fee, tok_guidance, tok_fee,
           payment_status, terms_accepted, terms_accepted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::text[],$11,$12,$13,$14,$15,$16,$17,$18,$19,'pending',$20,NOW())
         RETURNING id`,
        [
          b.name.trim(),
          b.email.trim().toLowerCase(),
          b.phone.trim(),
          b.teaching_statement.trim(),
          b.institution ? b.institution.trim() : null,
          b.id_card_drive_link.trim(),
          b.proof_drive_link.trim(),
          b.gdrive_video_link.trim(),
          Array.isArray(b.subjects) ? b.subjects : [b.subjects],
          Array.isArray(b.levels)   ? b.levels   : [b.levels],
          parseInt(b.years_experience) || 0,
          parseFloat(b.hourly_rate),
          b.photo_url ? b.photo_url.trim() : null,
          ia_guidance, ia_fee,
          ee_guidance, ee_fee,
          tok_guidance, tok_fee,
          JSON.stringify(Array.isArray(b.availability) ? b.availability : []),
          termsAccepted,
        ]
      );
      const applicationId = appRes.rows[0].id;

      email.notifyAdminNewTeacherApplication({ ...b, ia_guidance, ee_guidance, tok_guidance })
        .catch(err => req.log.warn({ err }, 'admin notification failed'));

      return reply.code(201).send({
        ok: true,
        application_id: applicationId,
        message: 'Application submitted. We will review within 2 business days and email you.',
      });
    } catch (err) {
      req.log.error({ err, pg_message: err.message, pg_code: err.code }, 'teacher-apply failed');
      return reply.code(500).send({ error: err.message || 'Could not submit application. Please try again.' });
    }
  });

  // GET /api/teacher-apply/status/:id
  app.get('/status/:id', publicLimit, async (req, reply) => {
    const res = await pool.query(
      'SELECT id, name, email, status, payment_status, admin_notes, created_at FROM teacher_applications WHERE id=$1',
      [req.params.id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Application not found' });
    return res.rows[0];
  });

  // GET /api/teacher-apply/subjects
  app.get('/subjects', async () => {
    const res = await pool.query(
      'SELECT id, group_name, subject, level, display_label FROM ib_subjects ORDER BY group_name, subject, level'
    );
    const grouped = {};
    for (const row of res.rows) {
      if (!grouped[row.group_name]) grouped[row.group_name] = [];
      grouped[row.group_name].push(row);
    }
    return grouped;
  });
};
