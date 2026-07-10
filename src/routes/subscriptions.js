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

// Tier pricing -- the ONLY payment on the platform
// Tier 1: Rs.1,999/year, Tier 2: Rs.3,999/year
const TIER_PRICES = { 1: 1999, 2: 3999 };

// Promo code: "ibphysicswithrao"
// Bypasses Razorpay entirely and activates the chosen tier for free --
// but ONLY while the promo window is open (through 31 Jul 2026, IST).
// Whatever day it's redeemed, access still hard-expires at midnight
// 1 Aug 2026 IST (not a rolling year). From 1 Aug 2026 the code is
// rejected unconditionally and students must pay the real price.
const PROMO_CODE        = 'ibphysicswithrao';
// 31 Jul 2026 23:59:59 IST  ==  2026-07-31T18:29:59Z
const PROMO_CUTOFF_UTC  = new Date('2026-07-31T18:29:59Z');
// 1 Aug 2026 00:00:00 IST   ==  2026-07-31T18:30:00Z
const PROMO_HARD_EXPIRY = new Date('2026-07-31T18:30:00Z');

function isPromoWindowOpen() {
  return new Date() <= PROMO_CUTOFF_UTC;
}

module.exports = async function subscriptionRoutes(app) {

  // POST /api/subscriptions/create-order
  // Body: { tier: 1|2, promo_code?: string }
  app.post('/create-order', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Only students can subscribe' });

    const { tier, promo_code } = req.body || {};
    const tierNum = parseInt(tier, 10);
    if (![1, 2].includes(tierNum))
      return reply.code(400).send({ error: 'tier must be 1 or 2' });

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

    // Promo code path -- skips Razorpay entirely, only until 31 Jul
    if (promo_code) {
      if (String(promo_code).trim().toLowerCase() !== PROMO_CODE) {
        return reply.code(400).send({ error: 'Invalid promo code.' });
      }
      if (!isPromoWindowOpen()) {
        return reply.code(410).send({
          error: 'The promo code "ibphysicswithrao" expired on 31 July and no longer works. Please subscribe with payment.',
        });
      }

      const startsAt = new Date();
      const subRes = await pool.query(
        `INSERT INTO subscriptions (user_id, type, tier, amount, status, is_promo, starts_at, expires_at)
         VALUES ($1,'student_annual',$2,0,'active',TRUE,$3,$4) RETURNING id`,
        [req.user.id, tierNum, startsAt, PROMO_HARD_EXPIRY]
      );

      return {
        promo: true,
        subscription_id: subRes.rows[0].id,
        tier: tierNum,
        expires_at: PROMO_HARD_EXPIRY,
        message: 'Tier ' + tierNum + ' activated free via promo code -- valid only until 31 July. ' +
          'From 1 August you will need to pay Rs.' + TIER_PRICES[tierNum] + ' to keep access. ' +
          'Anything you save before then stays safe and becomes visible again as soon as you pay.',
      };
    }

    // Paid path
    const amount = TIER_PRICES[tierNum];
    let order_id, key_id_public, mock = false;
    try {
      if (isRealRazorpay()) {
        const order = await createRazorpayOrder({
          amount, currency: 'INR',
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
      `INSERT INTO subscriptions (user_id, type, tier, razorpay_order_id, amount, status)
       VALUES ($1,'student_annual',$2,$3,$4,'pending') RETURNING id`,
      [req.user.id, tierNum, order_id, amount]
    );

    return {
      subscription_id: subRes.rows[0].id,
      order_id, key_id: key_id_public, amount, tier: tierNum, currency: 'INR', mock,
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

    // Award 1 registration credit (IB Project Diary -- diary mode)
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

    // Real payment always re-opens full access to this account, so any
    // diary/tool work saved earlier (e.g. during a promo period that then
    // lapsed) becomes visible and downloadable again immediately -- nothing
    // is ever deleted when access is locked, only gated.
    return {
      ok: true,
      tier: sub.tier,
      expires_at: expiresAt,
      message: 'Subscription activated! Any previously saved work is now unlocked, and you have received 1 IB Project Diary credit.',
    };
  });

  // GET /api/subscriptions/status
  app.get('/status', { onRequest: [app.authenticate] }, async (req) => {
    const res = await pool.query(
      `SELECT id, tier, status, is_promo, starts_at, expires_at
       FROM subscriptions
       WHERE user_id=$1 AND type='student_annual'
       ORDER BY expires_at DESC LIMIT 1`,
      [req.user.id]
    );
    const sub = res.rows[0];
    if (!sub) return { active: false, tier: null, expires_at: null };
    const active = sub.status === 'active' && new Date(sub.expires_at) > new Date();
    return {
      active,
      tier: sub.tier,
      is_promo: sub.is_promo || false,
      expires_at: sub.expires_at,
      status: sub.status,
    };
  });
};
