// ── Teacher Terms One-Time-Link Routes ────────────────────────────────────────
// Flow:
//   1. Admin approves teacher → POST /api/admin/teacher-applications/:id/approve
//      already creates user account. Admin then calls POST /api/teacher-terms/send
//      to generate and email a one-time terms link.
//   2. Teacher clicks link → GET /api/teacher-terms/verify/:token
//      Returns teacher name + status (valid / expired / already_used).
//   3. Teacher clicks "I Agree" → POST /api/teacher-terms/accept/:token
//      Marks token as used, sets terms_accepted=TRUE on teacher_profiles.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const pool   = require('../db');
const email  = require('../email');

module.exports = async function teacherTermsRoutes(app) {

  // ADMIN: POST /api/teacher-terms/send
  // Generate a one-time terms token and email it to the teacher.
  app.post('/send', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    const { user_id, application_id } = req.body || {};
    if (!user_id)
      return reply.code(400).send({ error: 'user_id is required' });

    // Fetch teacher details
    const uRes = await pool.query('SELECT id, name, email FROM users WHERE id=$1 AND role=$2', [user_id, 'teacher']);
    if (!uRes.rows[0])
      return reply.code(404).send({ error: 'Teacher user not found' });
    const teacher = uRes.rows[0];

    // Invalidate any existing unused tokens for this teacher
    await pool.query(
      `UPDATE teacher_terms_tokens SET used_at=NOW()
       WHERE user_id=$1 AND used_at IS NULL`,
      [user_id]
    );

    // Generate new token
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO teacher_terms_tokens (token, user_id, application_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
      [token, user_id, application_id || null]
    );

    const appBase = process.env.APP_BASE_URL || 'https://ibhighway.com';
    const termsUrl = `${appBase}/teacher-terms/${token}`;

    // Send email
    try {
      await email.sendTeacherTermsLink({
        to:      teacher.email,
        name:    teacher.name,
        termsUrl,
      });
    } catch (err) {
      req.log.warn({ err }, 'teacher terms email failed');
      // Don't fail the request — admin can copy the link manually
    }

    return { ok: true, terms_url: termsUrl, teacher_email: teacher.email };
  });

  // PUBLIC: GET /api/teacher-terms/verify/:token
  // Returns teacher name and token status. No auth required (the token is the credential).
  app.get('/verify/:token', async (req, reply) => {
    const { token } = req.params;
    const res = await pool.query(
      `SELECT t.*, u.name AS teacher_name, u.email AS teacher_email,
              tp.terms_accepted
       FROM teacher_terms_tokens t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN teacher_profiles tp ON tp.user_id = t.user_id
       WHERE t.token = $1`,
      [token]
    );
    if (!res.rows[0])
      return reply.code(404).send({ error: 'Invalid or expired link. Please contact admin.' });

    const row = res.rows[0];

    if (row.used_at)
      return { status: 'already_accepted', teacher_name: row.teacher_name, teacher_email: row.teacher_email };

    if (new Date(row.expires_at) < new Date())
      return { status: 'expired', teacher_name: row.teacher_name, teacher_email: row.teacher_email };

    if (row.terms_accepted)
      return { status: 'already_accepted', teacher_name: row.teacher_name, teacher_email: row.teacher_email };

    return {
      status:         'valid',
      teacher_name:   row.teacher_name,
      teacher_email:  row.teacher_email,
      expires_at:     row.expires_at,
    };
  });

  // PUBLIC: POST /api/teacher-terms/accept/:token
  // Teacher accepts the terms. Consumes the token and marks teacher_profiles.
  app.post('/accept/:token', async (req, reply) => {
    const { token } = req.params;
    const res = await pool.query(
      `SELECT t.*, u.name AS teacher_name, tp.terms_accepted
       FROM teacher_terms_tokens t
       JOIN users u ON t.user_id = u.id
       LEFT JOIN teacher_profiles tp ON tp.user_id = t.user_id
       WHERE t.token = $1`,
      [token]
    );
    if (!res.rows[0])
      return reply.code(404).send({ error: 'Invalid link. Please contact admin.' });

    const row = res.rows[0];

    if (row.used_at)
      return reply.code(409).send({ error: 'Terms already accepted. You can log in to your dashboard.' });

    if (new Date(row.expires_at) < new Date())
      return reply.code(410).send({ error: 'This link has expired. Please contact admin for a new link.' });

    // Consume token and mark terms accepted
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE teacher_terms_tokens SET used_at=NOW() WHERE id=$1`,
        [row.id]
      );

      await client.query(
        `UPDATE teacher_profiles SET terms_accepted=TRUE, terms_accepted_at=NOW() WHERE user_id=$1`,
        [row.user_id]
      );

      // Also mark on teacher_applications if linked
      if (row.application_id) {
        await client.query(
          `UPDATE teacher_applications SET terms_accepted=TRUE, terms_accepted_at=NOW() WHERE id=$1`,
          [row.application_id]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return { ok: true, message: 'Terms accepted. You can now log in to your IBHighway Teacher Dashboard.' };
  });
};
