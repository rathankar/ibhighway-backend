const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool   = require('../db');
const email  = require('../email');

module.exports = async function adminRoutes(app) {

  async function adminOnly(req, reply) {
    await app.authenticate(req, reply);
    if (reply.sent) return;
    if (!req.user || req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin access only' });
  }

  // GET /api/admin/stats
  app.get('/stats', { onRequest: [adminOnly] }, async () => {
    const [users, bookings, payments, leads] = await Promise.all([
      pool.query('SELECT role, COUNT(*) as count FROM users GROUP BY role'),
      pool.query('SELECT status, COUNT(*) as count FROM bookings GROUP BY status'),
      pool.query('SELECT status, SUM(amount) as total, COUNT(*) as count FROM payments GROUP BY status'),
      pool.query('SELECT status, COUNT(*) as count FROM leads GROUP BY status'),
    ]);
    return { users: users.rows, bookings: bookings.rows, payments: payments.rows, leads: leads.rows };
  });

  // GET /api/admin/users
  app.get('/users', { onRequest: [adminOnly] }, async () => {
    const res = await pool.query(`
      SELECT u.id, u.name, u.email, u.role, u.phone, u.created_at,
             tp.hourly_rate, tp.subjects,
             COUNT(DISTINCT b.id) AS booking_count
      FROM users u
      LEFT JOIN teacher_profiles tp ON u.id = tp.user_id
      LEFT JOIN bookings b ON (b.student_id = u.id OR b.teacher_id = u.id)
      GROUP BY u.id, tp.hourly_rate, tp.subjects
      ORDER BY u.created_at DESC
    `);
    return res.rows;
  });

  // PATCH /api/admin/users/:id
  app.patch('/users/:id', { onRequest: [adminOnly] }, async (req) => {
    const { role } = req.body;
    if (role) {
      await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
    }
    return { success: true };
  });

  // DELETE /api/admin/users/:id
  app.delete('/users/:id', { onRequest: [adminOnly] }, async (req) => {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    return { success: true };
  });

  // GET /api/admin/bookings
  app.get('/bookings', { onRequest: [adminOnly] }, async () => {
    const res = await pool.query(`
      SELECT b.*,
             s.name AS student_name, s.email AS student_email,
             t.name AS teacher_name, t.email AS teacher_email,
             p.status AS payment_status, p.amount, p.split_teacher, p.split_platform
      FROM bookings b
      JOIN users s ON b.student_id = s.id
      JOIN users t ON b.teacher_id = t.id
      LEFT JOIN payments p ON p.booking_id = b.id
      ORDER BY b.created_at DESC
    `);
    return res.rows;
  });

  // PATCH /api/admin/bookings/:id
  app.patch('/bookings/:id', { onRequest: [adminOnly] }, async (req) => {
    const { status } = req.body;
    await pool.query('UPDATE bookings SET status=$1 WHERE id=$2', [status, req.params.id]);
    return { success: true };
  });

  // GET /api/admin/payments
  app.get('/payments', { onRequest: [adminOnly] }, async () => {
    const res = await pool.query(`
      SELECT p.*, b.slot_start, b.slot_end,
             s.name AS student_name,
             t.name AS teacher_name
      FROM payments p
      JOIN bookings b ON p.booking_id = b.id
      JOIN users s ON b.student_id = s.id
      JOIN users t ON b.teacher_id = t.id
      ORDER BY p.created_at DESC
    `);
    return res.rows;
  });

  // GET /api/admin/teacher-applications
  app.get('/teacher-applications', { onRequest: [adminOnly] }, async (req) => {
    const status = req.query && req.query.status;
    const res = status
      ? await pool.query(
          'SELECT * FROM teacher_applications WHERE status=$1 ORDER BY created_at DESC',
          [status]
        )
      : await pool.query('SELECT * FROM teacher_applications ORDER BY created_at DESC');
    return res.rows;
  });

  // GET /api/admin/teacher-applications/:id
  app.get('/teacher-applications/:id', { onRequest: [adminOnly] }, async (req, reply) => {
    const res = await pool.query(
      'SELECT * FROM teacher_applications WHERE id=$1',
      [req.params.id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Application not found' });
    return res.rows[0];
  });

  // POST /api/admin/teacher-applications/:id/approve
  app.post('/teacher-applications/:id/approve', { onRequest: [adminOnly] }, async (req, reply) => {
    const { youtube_video_url } = req.body || {};
    const id = Number(req.params.id);

    const appRes = await pool.query('SELECT * FROM teacher_applications WHERE id=$1', [id]);
    const application = appRes.rows[0];
    if (!application) return reply.code(404).send({ error: 'Application not found' });
    if (application.status === 'approved')
      return reply.code(409).send({ error: 'Application already approved' });
    // Registration is free — no payment check needed

    const tempPassword = crypto.randomBytes(8).toString('hex');
    const hash = await bcrypt.hash(tempPassword, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const uRes = await client.query(
        `INSERT INTO users (name, email, password_hash, role, phone)
         VALUES ($1,$2,$3,'teacher',$4)
         RETURNING id, name, email, role`,
        [application.name, application.email, hash, application.phone]
      );
      const user = uRes.rows[0];

      await client.query(
        `INSERT INTO teacher_profiles
           (user_id, bio, subjects, hourly_rate,
            photo_url, years_experience, institution,
            teaching_statement, gdrive_video_link, youtube_video_url,
            ia_guidance, ia_fee, ee_guidance, ee_fee, tok_guidance, tok_fee,
            is_public)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,TRUE)`,
        [
          user.id,
          application.teaching_statement,
          application.subjects,
          application.hourly_rate,
          application.photo_url,
          application.years_experience,
          application.institution,
          application.teaching_statement,
          application.gdrive_video_link,
          youtube_video_url || null,
          application.ia_guidance || false,
          application.ia_fee || 0,
          application.ee_guidance || false,
          application.ee_fee || 0,
          application.tok_guidance || false,
          application.tok_fee || 0,
        ]
      );

      await client.query(
        `UPDATE teacher_applications
         SET status='approved', user_id=$1, youtube_video_url=$2, updated_at=NOW()
         WHERE id=$3`,
        [user.id, youtube_video_url || null, id]
      );

      // Save availability slots if provided in application
      const availabilitySlots = Array.isArray(application.availability_json)
        ? application.availability_json
        : (() => { try { return JSON.parse(application.availability_json || '[]') } catch { return [] } })();
      if (availabilitySlots.length > 0) {
        await client.query('DELETE FROM availability WHERE teacher_id=$1', [user.id]);
        for (const s of availabilitySlots) {
          await client.query(
            'INSERT INTO availability (teacher_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)',
            [user.id, s.day_of_week, s.start_time, s.end_time]
          );
        }
      }

      await client.query('COMMIT');

      const appBase = process.env.APP_BASE_URL || 'https://ibhighway.com';
      email.sendTeacherApprovalEmail({
        email: application.email,
        name: application.name,
        appBase,
        tempPassword,
      }).catch(err => req.log.warn({ err }, 'teacher approval email failed'));

      return { ok: true, user_id: user.id, temp_password: tempPassword };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505')
        return reply.code(409).send({ error: 'A user account already exists for this email.' });
      req.log.error({ err }, 'teacher approval failed');
      return reply.code(500).send({ error: 'Could not create teacher account. Please try again.' });
    } finally {
      client.release();
    }
  });

  // POST /api/admin/teacher-applications/:id/reject
  app.post('/teacher-applications/:id/reject', { onRequest: [adminOnly] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { notes } = req.body || {};

    const res = await pool.query(
      `UPDATE teacher_applications
       SET status='rejected', admin_notes=$1, updated_at=NOW()
       WHERE id=$2 RETURNING *`,
      [notes || null, id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Application not found' });

    email.sendTeacherRejectionEmail({
      email: res.rows[0].email,
      name: res.rows[0].name,
      notes,
    }).catch(() => {});

    return { ok: true, application: res.rows[0] };
  });

};
