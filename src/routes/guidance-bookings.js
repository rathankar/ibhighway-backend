const pool = require('../db');

// Guidance bookings (IA / EE / TOK)
// No in-platform payment — fee is settled directly between student and
// teacher outside IBHighway. The only Razorpay payment on the platform is
// the Tier 1/Tier 2 tool subscription (see routes/subscriptions.js).
// Disclaimer: IBHighway only connects teachers and students.

module.exports = async function guidanceBookingRoutes(app) {

  // POST /api/guidance-bookings  - student books a guidance session
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Only students can book guidance sessions' });

    const { teacher_id, guidance_type, slot_start, notes } = req.body || {};
    if (!teacher_id || !guidance_type || !slot_start)
      return reply.code(400).send({ error: 'teacher_id, guidance_type, and slot_start are required' });

    const validTypes = ['ia','ee','tok'];
    if (!validTypes.includes(guidance_type))
      return reply.code(400).send({ error: 'guidance_type must be ia, ee, or tok' });

    // Verify teacher offers this guidance type and get fee
    const tpRes = await pool.query(
      `SELECT ia_guidance, ia_fee, ee_guidance, ee_fee, tok_guidance, tok_fee
       FROM teacher_profiles WHERE user_id=$1`,
      [teacher_id]
    );
    const tp = tpRes.rows[0];
    if (!tp) return reply.code(404).send({ error: 'Teacher profile not found' });

    const guidanceField = guidance_type + '_guidance';
    const feeField      = guidance_type + '_fee';
    if (!tp[guidanceField])
      return reply.code(400).send({ error: 'This teacher does not offer ' + guidance_type.toUpperCase() + ' guidance' });

    const fee      = parseFloat(tp[feeField]) || 0;
    const start    = new Date(slot_start);
    const end      = new Date(start.getTime() + 60 * 60 * 1000);
    const meetCode = Math.random().toString(36).substring(2,5) + '-' +
                     Math.random().toString(36).substring(2,7) + '-' +
                     Math.random().toString(36).substring(2,5);
    const meet_link = 'https://meet.google.com/' + meetCode;

    const res = await pool.query(
      `INSERT INTO guidance_bookings
         (student_id, teacher_id, guidance_type, slot_start, slot_end, fee, meet_link, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, teacher_id, guidance_type, start, end, fee, meet_link, notes || null]
    );

    return reply.code(201).send({ booking: res.rows[0], fee, disclaimer:
      'IBHighway only connects teachers and students. Payment for guidance sessions is settled directly between student and teacher, outside the platform.' });
  });

  // GET /api/guidance-bookings  - get my guidance bookings
  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const { id, role } = req.user;
    let res;
    if (role === 'student') {
      res = await pool.query(
        `SELECT gb.*, u.name AS teacher_name FROM guidance_bookings gb
         JOIN users u ON gb.teacher_id = u.id
         WHERE gb.student_id=$1 ORDER BY gb.slot_start DESC`,
        [id]
      );
    } else {
      res = await pool.query(
        `SELECT gb.*, u.name AS student_name FROM guidance_bookings gb
         JOIN users u ON gb.student_id = u.id
         WHERE gb.teacher_id=$1 ORDER BY gb.slot_start DESC`,
        [id]
      );
    }
    return res.rows;
  });

  // PATCH /api/guidance-bookings/:id/status
  app.patch('/:id/status', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { status } = req.body || {};
    const allowed = ['confirmed','completed','cancelled','absent'];
    if (!allowed.includes(status)) return reply.code(400).send({ error: 'Invalid status' });

    const bRes = await pool.query('SELECT * FROM guidance_bookings WHERE id=$1', [req.params.id]);
    const b = bRes.rows[0];
    if (!b) return reply.code(404).send({ error: 'Booking not found' });

    const { role, id: uid } = req.user;
    if (role === 'student' && b.student_id !== uid) return reply.code(403).send({ error: 'Forbidden' });
    if (role === 'teacher' && b.teacher_id !== uid) return reply.code(403).send({ error: 'Forbidden' });

    await pool.query('UPDATE guidance_bookings SET status=$1 WHERE id=$2', [status, b.id]);
    return { ok: true, status };
  });
};
