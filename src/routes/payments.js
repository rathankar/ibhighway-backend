const crypto = require('crypto');
const pool   = require('../db');
const email  = require('../email');

// Platform fee model:
//   First tutoring booking per teacher: Rs.1000 platform fee + 10% of remainder
//   Subsequent tutoring bookings: tiered commission (10% → 8% → 6% → 5%)
//   Guidance bookings (IA/EE/TOK): 10% platform commission
//   Minimum session fee: Rs.1500

const PLATFORM_ONBOARDING_FEE = 1000; // one-time per teacher (charged on first booking)

// Tiered commission ladder — based on total completed sessions by this teacher
// Milestones: <21 → 10%, 21–50 → 8%, 51–99 → 6%, 100+ → 5%
function getCommissionRate(completedSessions) {
  if (completedSessions >= 100) return 0.05;
  if (completedSessions >= 51)  return 0.06;
  if (completedSessions >= 21)  return 0.08;
  return 0.10;
}

function isRealRazorpay() {
  const id  = process.env.RAZORPAY_KEY_ID || '';
  const sec = process.env.RAZORPAY_KEY_SECRET || '';
  return id && sec &&
    (id.startsWith('rzp_test_') || id.startsWith('rzp_live_')) &&
    id !== 'rzp_test_sandbox';
}

async function createRazorpayOrder({ amount, currency = 'INR', receipt }) {
  const auth = Buffer.from(
    process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET
  ).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency, receipt, payment_capture: 1 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data?.error?.description) || 'Razorpay order failed');
  return data;
}

function verifyRazorpaySignature({ order_id, payment_id, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(order_id + '|' + payment_id)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature || '', 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Compute the split for a tutoring booking (uses commission ladder)
async function computeSplit(teacherId, amount) {
  const tpRes = await pool.query(
    'SELECT platform_fee_paid FROM teacher_profiles WHERE user_id=$1',
    [teacherId]
  );
  const platformFeePaid = tpRes.rows[0]?.platform_fee_paid || false;

  if (!platformFeePaid) {
    // First booking: flat Rs.1000 onboarding fee + 10% of remainder
    const remainder      = amount - PLATFORM_ONBOARDING_FEE;
    const split_teacher  = Number((remainder * 0.90).toFixed(2));
    const split_platform = Number((PLATFORM_ONBOARDING_FEE + remainder * 0.10).toFixed(2));
    return { split_teacher, split_platform, is_onboarding: true, commission_rate: 0.10 };
  }

  // Count completed sessions for this teacher to determine commission tier
  const sessRes = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM bookings WHERE teacher_id=$1 AND status='completed'",
    [teacherId]
  );
  const completedSessions = sessRes.rows[0]?.cnt || 0;
  const rate              = getCommissionRate(completedSessions);
  const teacherPct        = 1 - rate;

  const split_teacher  = Number((amount * teacherPct).toFixed(2));
  const split_platform = Number((amount * rate).toFixed(2));
  return { split_teacher, split_platform, is_onboarding: false, commission_rate: rate };
}

// Award 1 silver coin per tutoring payment to the coin ledger
async function awardTutoringCoin(studentId, bookingId) {
  try {
    await pool.query(
      `INSERT INTO coin_ledger (student_id, amount, source, description, ref_id)
       VALUES ($1, 1, 'tutoring_payment', '1 coin earned for tutoring session payment', $2)`,
      [studentId, bookingId]
    );
    console.log('✅ +1 coin awarded to student', studentId, 'for booking', bookingId);
  } catch (err) {
    console.error('awardTutoringCoin error:', err.message);
  }
}

module.exports = async function paymentRoutes(app) {

  // POST /api/payments/create-order
  app.post('/create-order', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { booking_id } = req.body || {};
    if (!booking_id) return reply.code(400).send({ error: 'booking_id is required' });

    const bRes = await pool.query(
      `SELECT b.*, tp.hourly_rate, b.booking_type
       FROM bookings b
       JOIN teacher_profiles tp ON b.teacher_id = tp.user_id
       WHERE b.id = $1`,
      [booking_id]
    );
    if (!bRes.rows[0]) return reply.code(404).send({ error: 'Booking not found' });

    const b = bRes.rows[0];
    if (req.user.role === 'student' && b.student_id !== req.user.id)
      return reply.code(403).send({ error: 'Not your booking.' });

    const amount       = parseFloat(b.hourly_rate);
    const bookingType  = b.booking_type || 'tutoring';

    // Guidance sessions: 10% platform commission
    let split_teacher, split_platform, is_onboarding = false, commission_rate = 0.10;
    if (bookingType !== 'tutoring') {
      split_platform = Number((amount * 0.10).toFixed(2));
      split_teacher  = Number((amount - split_platform).toFixed(2));
    } else {
      const split    = await computeSplit(b.teacher_id, amount);
      split_teacher  = split.split_teacher;
      split_platform = split.split_platform;
      is_onboarding  = split.is_onboarding;
      commission_rate = split.commission_rate;
    }

    let order_id, key_id_public, mock = false;
    try {
      if (isRealRazorpay()) {
        const order = await createRazorpayOrder({
          amount,
          currency: 'INR',
          receipt: 'bk_' + booking_id + '_' + Date.now(),
        });
        order_id      = order.id;
        key_id_public = process.env.RAZORPAY_KEY_ID;
      } else {
        mock          = true;
        order_id      = 'order_sandbox_' + Date.now();
        key_id_public = 'rzp_test_sandbox';
      }
    } catch (err) {
      req.log.error({ err }, 'create-order failed');
      return reply.code(502).send({ error: 'Payment gateway error: ' + err.message });
    }

    const pRes = await pool.query(
      `INSERT INTO payments (booking_id, razorpay_order_id, amount, split_teacher, split_platform)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [booking_id, order_id, amount, split_teacher, split_platform]
    );

    return {
      order_id,
      key_id:          key_id_public,
      payment_id:      pRes.rows[0].id,
      amount,
      currency:        'INR',
      split_teacher,
      split_platform,
      is_onboarding,
      commission_rate,
      mock,
    };
  });

  // POST /api/payments/verify
  app.post('/verify', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { payment_id, booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

    if (!payment_id || !booking_id)
      return reply.code(400).send({ error: 'payment_id and booking_id are required' });

    if (isRealRazorpay()) {
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
        return reply.code(400).send({ error: 'Missing Razorpay verification fields.' });
      const valid = verifyRazorpaySignature({
        order_id: razorpay_order_id, payment_id: razorpay_payment_id, signature: razorpay_signature,
      });
      if (!valid) {
        await pool.query("UPDATE payments SET status='failed' WHERE id=$1", [payment_id]);
        return reply.code(400).send({ error: 'Payment signature did not match.' });
      }
    }

    const rzpPid = razorpay_payment_id || ('pay_sandbox_' + Date.now());

    await pool.query("UPDATE payments SET status='paid', razorpay_payment_id=$1 WHERE id=$2", [rzpPid, payment_id]);
    await pool.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [booking_id]);

    // Award 1 silver coin to student for this tutoring payment
    const bkRes = await pool.query('SELECT teacher_id, booking_type, student_id FROM bookings WHERE id=$1', [booking_id]);
    const bk = bkRes.rows[0];
    if (bk && bk.booking_type === 'tutoring' && bk.student_id) {
      await awardTutoringCoin(bk.student_id, booking_id);
      // Mark platform_fee_paid on teacher (first booking onboarding fee)
      const tpRes = await pool.query('SELECT platform_fee_paid FROM teacher_profiles WHERE user_id=$1', [bk.teacher_id]);
      if (tpRes.rows[0] && !tpRes.rows[0].platform_fee_paid) {
        await pool.query(
          "UPDATE teacher_profiles SET platform_fee_paid=TRUE, platform_fee_paid_at=NOW() WHERE user_id=$1",
          [bk.teacher_id]
        );
      }
    }

    // Confirmation email (fire and forget)
    try {
      const bRes = await pool.query(
        `SELECT b.slot_start, b.meet_link,
                s.name AS student_name, s.email AS student_email,
                t.name AS teacher_name
         FROM bookings b
         JOIN users s ON b.student_id = s.id
         JOIN users t ON b.teacher_id = t.id
         WHERE b.id=$1`,
        [booking_id]
      );
      const row = bRes.rows[0];
      if (row?.student_email) {
        email.sendBookingConfirmation({
          to: row.student_email, studentName: row.student_name,
          teacherName: row.teacher_name, slotStart: row.slot_start, meetLink: row.meet_link,
        }).catch(() => {});
      }
    } catch { /* non-fatal */ }

    return {
      success: true,
      message: isRealRazorpay() ? 'Payment verified - booking confirmed.' : 'Payment confirmed (sandbox).',
    };
  });

  // Called internally when a booking is marked 'completed' by teacher
  // Awards booking milestone credits
  app.post('/session-complete', { onRequest: [app.authenticate] }, async (req) => {
    // Legacy session-complete hook — coin is now awarded on payment, not session completion
    return { ok: true };
  });

  // ADMIN: GET /api/payments/payout-queue — payments on hold or ready for payout
  app.get('/payout-queue', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    // Auto-advance: payments whose 24hr hold has expired move to ready_for_payout
    await pool.query(
      `UPDATE payments
       SET payout_status='ready_for_payout'
       WHERE payout_status='hold' AND held_until <= NOW()`
    );

    const res = await pool.query(`
      SELECT
        p.id AS payment_id, p.booking_id, p.amount,
        p.split_teacher, p.split_platform,
        p.payout_status, p.held_until,
        p.created_at AS paid_at,
        t.name AS teacher_name, t.email AS teacher_email,
        s.name AS student_name,
        b.slot_start
      FROM payments p
      JOIN bookings b  ON p.booking_id = b.id
      JOIN users    t  ON b.teacher_id = t.id
      JOIN users    s  ON b.student_id = s.id
      WHERE p.payout_status IN ('hold','ready_for_payout')
        AND p.status = 'paid'
      ORDER BY p.held_until ASC
    `);
    return res.rows;
  });

  // ADMIN: PATCH /api/payments/:id/release-payout — mark payment as released
  app.patch('/:id/release-payout', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    const res = await pool.query(
      `UPDATE payments
       SET payout_status='released'
       WHERE id=$1 AND payout_status='ready_for_payout' RETURNING *`,
      [req.params.id]
    );
    if (!res.rows[0])
      return reply.code(404).send({ error: 'Payment not found or not yet ready for payout' });
    return { ok: true, payment: res.rows[0] };
  });

  // GET /api/payments/booking/:booking_id
  app.get('/booking/:booking_id', { onRequest: [app.authenticate] }, async (req) => {
    const res = await pool.query(
      'SELECT * FROM payments WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.params.booking_id]
    );
    return res.rows[0] || null;
  });
};
