const crypto = require('crypto');
const pool   = require('../db');

// Guidance bookings (IA / EE / TOK)
// 0% platform commission — 100% of fee goes directly to the teacher.
// Disclaimer: IBHighway only connects teachers and students.

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
      'IBHighway only connects teachers and students. Payment for guidance sessions goes directly to the teacher. IBHighway earns no commission on guidance sessions.' });
  });

  // POST /api/guidance-bookings/:id/pay  - create Razorpay order
  app.post('/:id/pay', { onRequest: [app.authenticate] }, async (req, reply) => {
    const bRes = await pool.query('SELECT * FROM guidance_bookings WHERE id=$1', [req.params.id]);
    const b = bRes.rows[0];
    if (!b) return reply.code(404).send({ error: 'Booking not found' });
    if (b.student_id !== req.user.id) return reply.code(403).send({ error: 'Forbidden' });

    let order_id, key_id_public, mock = false;
    try {
      if (isRealRazorpay()) {
        const order = await createRazorpayOrder({
          amount: b.fee, currency: 'INR',
          receipt: 'guid_' + b.id + '_' + Date.now(),
        });
        order_id      = order.id;
        key_id_public = process.env.RAZORPAY_KEY_ID;
      } else {
        mock          = true;
        order_id      = 'order_sandbox_' + Date.now();
        key_id_public = 'rzp_test_sandbox';
      }
    } catch (err) {
      return reply.code(502).send({ error: 'Payment gateway error: ' + err.message });
    }

    await pool.query('UPDATE guidance_bookings SET payment_status=$1 WHERE id=$2', ['order_created', b.id]);

    return { order_id, key_id: key_id_public, amount: b.fee, currency: 'INR', booking_id: b.id, mock };
  });

  // POST /api/guidance-bookings/:id/verify
  app.post('/:id/verify', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const bRes = await pool.query('SELECT * FROM guidance_bookings WHERE id=$1', [req.params.id]);
    const b = bRes.rows[0];
    if (!b) return reply.code(404).send({ error: 'Booking not found' });
    if (b.student_id !== req.user.id) return reply.code(403).send({ error: 'Forbidden' });

    if (isRealRazorpay()) {
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
        return reply.code(400).send({ error: 'Missing Razorpay verification fields' });
      const valid = verifyRazorpaySignature({
        order_id: razorpay_order_id, payment_id: razorpay_payment_id, signature: razorpay_signature,
      });
      if (!valid) return reply.code(400).send({ error: 'Payment signature did not match' });
    }

    // 10% platform commission
    const platformFee   = parseFloat((b.fee * 0.10).toFixed(2));
    const teacherPayout = parseFloat((b.fee - platformFee).toFixed(2));

    await pool.query(
      `UPDATE guidance_bookings
       SET payment_status='paid', status='confirmed',
           platform_fee=$1, teacher_payout=$2
       WHERE id=$3`,
      [platformFee, teacherPayout, b.id]
    );

    // Award 2 coins to student if guidance fee ≥ ₹5,000
    if (parseFloat(b.fee) >= 5000) {
      try {
        await pool.query(
          `INSERT INTO coin_ledger (student_id, amount, source, description, ref_id)
           VALUES ($1, 2, 'guidance_payment', '2 coins earned — guidance booking ≥ ₹5,000', $2)`,
          [b.student_id, b.id]
        );
        console.log('✅ +2 coins for student', b.student_id, 'guidance booking', b.id);
      } catch (e) {
        console.error('Guidance coin award error:', e.message);
      }
    }

    return {
      ok: true,
      message: `Payment confirmed. Session booked. Platform fee: ₹${platformFee} (10%). Teacher receives: ₹${teacherPayout}.`,
    };
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
