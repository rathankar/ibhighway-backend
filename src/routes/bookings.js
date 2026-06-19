const pool = require('../db');
const { awardTeacherSessionCoin } = require('./coins');
const { refreshTeacherBadge }     = require('./teachers');

// ── Twilio helper — send a WhatsApp message (fire-and-forget, non-fatal) ──────
async function sendWhatsApp(phone, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return; // not configured

  // Normalise to E.164
  const digits = phone.replace(/\D/g, '');
  let e164 = phone;
  if (digits.length === 10)                         e164 = '+91' + digits;
  else if (digits.startsWith('91') && digits.length === 12) e164 = '+' + digits;

  try {
    const body = new URLSearchParams({
      From: `whatsapp:${fromNumber}`,
      To:   `whatsapp:${e164}`,
      Body: message,
    }).toString();
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        },
        body,
      }
    );
  } catch (err) {
    console.error('[sendWhatsApp] error:', err.message);
  }
}

// Check if student has an active subscription
async function hasActiveSubscription(studentId) {
  const res = await pool.query(
    `SELECT id FROM subscriptions
     WHERE user_id=$1 AND type='student_annual'
       AND status='active' AND expires_at > NOW()
     LIMIT 1`,
    [studentId]
  );
  return res.rows.length > 0;
}

module.exports = async function bookingRoutes(app) {

  // POST /api/bookings  - student creates a booking
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Only students can book sessions' });

    // ── Subscription gate ──────────────────────────────────────────────
    const subscribed = await hasActiveSubscription(req.user.id);
    if (!subscribed)
      return reply.code(403).send({
        error: 'An active subscription is required to book sessions. Please subscribe at ibhighway.com/subscribe.',
        code: 'SUBSCRIPTION_REQUIRED',
      });

    const { teacher_id, slot_start, notes } = req.body;
    if (!teacher_id || !slot_start)
      return reply.code(400).send({ error: 'teacher_id and slot_start are required' });

    const start = new Date(slot_start);
    const end   = new Date(start.getTime() + 60 * 60 * 1000);

    const conflict = await pool.query(
      `SELECT id, status FROM bookings
       WHERE teacher_id=$1 AND slot_start=$2
         AND status NOT IN ('cancelled')`,
      [teacher_id, start]
    );
    if (conflict.rows.length > 0)
      return reply.code(409).send({ error: 'That slot is already booked. Please choose another.' });

    // Use teacher's own Google Meet link from their profile
    const teacherProfile = await pool.query(
      'SELECT meet_link FROM teacher_profiles WHERE user_id=$1',
      [teacher_id]
    );
    const meet_link = teacherProfile.rows[0]?.meet_link || null;

    try {
      const res = await pool.query(
        `INSERT INTO bookings (student_id, teacher_id, slot_start, slot_end, status, meet_link, notes)
         VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING *`,
        [req.user.id, teacher_id, start, end, meet_link, notes || null]
      );
      return reply.code(201).send(res.rows[0]);
    } catch (err) {
      if (err.code === '23505')
        return reply.code(409).send({ error: 'That slot was just booked by someone else.' });
      throw err;
    }
  });

  // GET /api/bookings  - get my bookings (student or teacher view)
  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const { id, role } = req.user;
    let res;

    if (role === 'student') {
      res = await pool.query(`
        SELECT b.*, u.name AS teacher_name, u.email AS teacher_email,
               p.status AS payment_status, p.id AS payment_id
        FROM bookings b
        JOIN users u ON b.teacher_id = u.id
        LEFT JOIN payments p ON p.booking_id = b.id
        WHERE b.student_id = $1
        ORDER BY b.slot_start DESC
      `, [id]);
    } else {
      res = await pool.query(`
        SELECT b.*, u.name AS student_name, u.email AS student_email, u.phone AS student_phone
        FROM bookings b
        JOIN users u ON b.student_id = u.id
        WHERE b.teacher_id = $1
        ORDER BY b.slot_start DESC
      `, [id]);
    }
    return res.rows;
  });

  // PATCH /api/bookings/:id/status
  // For 'cancelled' and 'absent': single-party action (teacher or admin).
  // For 'completed': dual-confirmation required — both student AND teacher must confirm.
  //   - Student calls PATCH with { status: 'completed' } → sets student_confirmed=true
  //   - Teacher calls PATCH with { status: 'completed' } → sets teacher_confirmed=true
  //   - When both are true → booking.status flips to 'completed', coins awarded, badge refreshed,
  //     payment put on 24hr hold, WhatsApp review prompt sent to student.
  app.patch('/:id/status', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['pending','confirmed','cancelled','completed','absent'];
    if (!allowed.includes(status))
      return reply.code(400).send({ error: 'Invalid status' });

    const bRes = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
    if (!bRes.rows[0]) return reply.code(404).send({ error: 'Booking not found' });

    const b    = bRes.rows[0];
    const { role, id: uid } = req.user;
    if (role === 'student' && b.student_id !== uid)
      return reply.code(403).send({ error: 'Forbidden' });
    if (role === 'teacher' && b.teacher_id !== uid)
      return reply.code(403).send({ error: 'Forbidden' });

    // ── Dual-confirmation path for 'completed' ───────────────────────────────
    if (status === 'completed') {
      if (role === 'student') {
        await pool.query(
          'UPDATE bookings SET student_confirmed=TRUE, student_confirmed_at=NOW() WHERE id=$1',
          [id]
        );
      } else if (role === 'teacher') {
        await pool.query(
          'UPDATE bookings SET teacher_confirmed=TRUE, teacher_confirmed_at=NOW() WHERE id=$1',
          [id]
        );
      }

      // Re-read to check if both sides have now confirmed
      const checkRes = await pool.query(
        'SELECT student_confirmed, teacher_confirmed, student_id, teacher_id FROM bookings WHERE id=$1',
        [id]
      );
      const bk = checkRes.rows[0];

      if (bk.student_confirmed && bk.teacher_confirmed) {
        // Both sides confirmed — mark completed and trigger all downstream effects
        await pool.query(
          "UPDATE bookings SET status='completed' WHERE id=$1",
          [id]
        );

        // Put the payment on 24-hour hold (payout_status → 'hold', held_until = now + 24hrs)
        await pool.query(
          `UPDATE payments
           SET payout_status='hold', held_until=NOW() + INTERVAL '24 hours'
           WHERE booking_id=$1 AND status='paid'`,
          [id]
        );

        // Award teacher +1 coin (+ possible monthly bonus)
        await awardTeacherSessionCoin(bk.teacher_id, id);

        // Refresh teacher badge
        await refreshTeacherBadge(bk.teacher_id);

        // Send WhatsApp review prompt to student (fire-and-forget)
        const userRes = await pool.query(
          `SELECT s.phone AS student_phone, s.name AS student_name, t.name AS teacher_name
           FROM users s JOIN users t ON t.id=$2 WHERE s.id=$1`,
          [bk.student_id, bk.teacher_id]
        );
        const u = userRes.rows[0];
        if (u?.student_phone) {
          sendWhatsApp(
            u.student_phone,
            `📚 *IBHighway — Session Complete!*\n\n` +
            `Hi ${u.student_name}! Your session with ${u.teacher_name} has been marked complete.\n\n` +
            `How did it go? Leave a review on their profile — it helps other students and rewards your teacher with bonus coins! 🌟\n\n` +
            `👉 https://ibhighway.com/teachers`
          ).catch(() => {});
        }

        return { success: true, status: 'completed', message: 'Session confirmed by both sides.' };
      }

      // Only one side confirmed so far
      const waiting = role === 'student' ? 'teacher' : 'student';
      return {
        success: true,
        status: 'pending_confirmation',
        message: `Your confirmation recorded. Waiting for the ${waiting} to confirm.`,
        student_confirmed: bk.student_confirmed,
        teacher_confirmed: bk.teacher_confirmed,
      };
    }

    // ── Non-completion status change (cancelled, absent, etc.) ───────────────
    await pool.query('UPDATE bookings SET status=$1 WHERE id=$2', [status, id]);
    return { success: true, status };
  });

  // GET /api/bookings/:id/confirmation-status — check dual-confirmation state
  app.get('/:id/confirmation-status', { onRequest: [app.authenticate] }, async (req, reply) => {
    const res = await pool.query(
      `SELECT id, status, student_confirmed, teacher_confirmed,
              student_confirmed_at, teacher_confirmed_at
       FROM bookings WHERE id=$1`,
      [req.params.id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Booking not found' });
    const b = res.rows[0];
    if (req.user.role === 'student' && b.student_id !== req.user.id)
      return reply.code(403).send({ error: 'Forbidden' });
    return res.rows[0];
  });
};
