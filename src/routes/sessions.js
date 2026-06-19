const pool             = require('../db');
const { handleSessionNoShow } = require('../elevenlabs');

// Delay before calling the absent party (10 minutes in ms).
const NO_SHOW_DELAY_MS = 10 * 60 * 1000;

module.exports = async function sessionRoutes(app) {

  // ── POST /api/sessions/:booking_id/join ───────────────────────
  app.post('/:booking_id/join', { onRequest: [app.authenticate] }, async (req, reply) => {
    const bookingId = Number(req.params.booking_id);
    const userId    = req.user.id;

    const bRes = await pool.query(
      `SELECT * FROM bookings WHERE id=$1 AND status='confirmed'`,
      [bookingId]
    );
    const booking = bRes.rows[0];
    if (!booking) {
      return reply.code(404).send({ error: 'Confirmed booking not found' });
    }
    if (booking.student_id !== userId && booking.teacher_id !== userId) {
      return reply.code(403).send({ error: 'You are not part of this session' });
    }

    await pool.query(
      `INSERT INTO session_presence (booking_id, user_id)
       VALUES ($1, $2) ON CONFLICT (booking_id, user_id) DO NOTHING`,
      [bookingId, userId]
    );

    const presenceCount = await pool.query(
      'SELECT COUNT(*) FROM session_presence WHERE booking_id=$1',
      [bookingId]
    );
    if (parseInt(presenceCount.rows[0].count) === 1) {
      setTimeout(() => {
        handleSessionNoShow(bookingId);
      }, NO_SHOW_DELAY_MS);
      console.log(`⏱  Session #${bookingId}: first join recorded. No-show check in 10 min.`);
    }

    return {
      ok: true,
      meet_link: booking.meet_link,
      message: 'You have joined the session. Good luck!',
    };
  });

  // ── GET /api/sessions/:booking_id/presence ───────────────────
  app.get('/:booking_id/presence', { onRequest: [app.authenticate] }, async (req, reply) => {
    const bookingId = Number(req.params.booking_id);

    const bRes = await pool.query(
      'SELECT student_id, teacher_id FROM bookings WHERE id=$1',
      [bookingId]
    );
    if (!bRes.rows[0]) return reply.code(404).send({ error: 'Booking not found' });
    const { student_id, teacher_id } = bRes.rows[0];

    if (student_id !== req.user.id && teacher_id !== req.user.id) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const pRes = await pool.query(
      'SELECT user_id, joined_at FROM session_presence WHERE booking_id=$1',
      [bookingId]
    );
    const joined = pRes.rows.map(r => r.user_id);

    return {
      student_joined: joined.includes(student_id),
      teacher_joined: joined.includes(teacher_id),
      presence: pRes.rows,
    };
  });
};
