const crypto = require('crypto');
const pool   = require('../db');

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

const STUDENT_FEE = 1500; // Rs.1500/year (includes 1 IB Project Diary credit)

module.exports = async function subscriptionRoutes(app) {

  // POST /api/subscriptions/create-order
  app.post('/create-order', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Only students can subscribe' });

    const existing = await pool.query(
      `SELECT id, expires_at FROM subscriptions
       WHERE user_id=$1 AND type='student_annual'
         AND status='active' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (existing.rows[0]) {
      return reply.code(409).send({
        error: 'You already have an active subscription.',
        expires_at: existing.rows[0].expires_at,
      });
    }

    let order_id, key_id_public, mock = false;
    try {
      if (isRealRazorpay()) {
        const order = await createRazorpayOrder({
          amount: STUDENT_FEE, currency: 'INR',
          receipt: 'student_sub_' + req.user.id + '_' + Date.now(),
        });
        order_id      = order.id;
        key_id_public = process.env.RAZORPAY_KEY_ID;
      } else {
        mock          = true;
        order_id      = 'order_sandbox_' + Date.now();
        key_id_public = 'rzp_test_sandbox';
      }
    } catch (err) {
      req.log.error({ err }, 'subscription create-order failed');
      return reply.code(502).send({ error: 'Payment gateway error: ' + err.message });
    }

    const subRes = await pool.query(
      `INSERT INTO subscriptions (user_id, type, razorpay_order_id, amount, status)
       VALUES ($1,'student_annual',$2,$3,'pending') RETURNING id`,
      [req.user.id, order_id, STUDENT_FEE]
    );

    return {
      subscription_id: subRes.rows[0].id,
      order_id, key_id: key_id_public, amount: STUDENT_FEE, currency: 'INR', mock,
    };
  });

  // POST /api/subscriptions/verify
  app.post('/verify', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { subscription_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!subscription_id)
      return reply.code(400).send({ error: 'subscription_id is required' });

    const subRes = await pool.query(
      'SELECT * FROM subscriptions WHERE id=$1 AND user_id=$2',
      [subscription_id, req.user.id]
    );
    const sub = subRes.rows[0];
    if (!sub) return reply.code(404).send({ error: 'Subscription record not found' });
    if (sub.status === 'active') return reply.code(409).send({ error: 'Already activated' });

    if (isRealRazorpay()) {
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
        return reply.code(400).send({ error: 'Missing Razorpay verification fields' });
      const valid = verifyRazorpaySignature({
        order_id: razorpay_order_id, payment_id: razorpay_payment_id, signature: razorpay_signature,
      });
      if (!valid) {
        await pool.query("UPDATE subscriptions SET status='failed' WHERE id=$1", [subscription_id]);
        return reply.code(400).send({ error: 'Payment signature did not match' });
      }
    }

    const rzpPid    = razorpay_payment_id || ('pay_sandbox_' + Date.now());
    const startsAt  = new Date();
    const expiresAt = new Date(startsAt);
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    await pool.query(
      `UPDATE subscriptions
       SET status='active', razorpay_payment_id=$1, starts_at=$2, expires_at=$3
       WHERE id=$4`,
      [rzpPid, startsAt, expiresAt, subscription_id]
    );

    // Award 1 registration credit (IB Project Diary — diary mode)
    const existingCredit = await pool.query(
      "SELECT id FROM student_credits WHERE student_id=$1 AND coin_type='registration'",
      [req.user.id]
    );
    if (existingCredit.rows.length === 0) {
      await pool.query(
        `INSERT INTO student_credits (student_id, coin_type, source, runs_total)
         VALUES ($1,'registration','subscription_payment',1)`,
        [req.user.id]
      );
    }

    return {
      ok: true,
      expires_at: expiresAt,
      message: 'Subscription activated! You have received 1 IB Project Diary credit.',
    };
  });

  // GET /api/subscriptions/status
  app.get('/status', { onRequest: [app.authenticate] }, async (req) => {
    const res = await pool.query(
      `SELECT id, status, starts_at, expires_at
       FROM subscriptions
       WHERE user_id=$1 AND type='student_annual'
       ORDER BY expires_at DESC LIMIT 1`,
      [req.user.id]
    );
    const sub = res.rows[0];
    if (!sub) return { active: false, expires_at: null };
    const active = sub.status === 'active' && new Date(sub.expires_at) > new Date();
    return { active, expires_at: sub.expires_at, status: sub.status };
  });
};
