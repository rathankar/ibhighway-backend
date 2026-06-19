const pool = require('../db');

const MENTOR_COST  = 5;
const DIARY_COST   = 10;
const CLAIM_COINS  = 50;
const CLAIM_AMOUNT = 1000;

async function getCoinBalance(studentId) {
  const res = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM coin_ledger WHERE student_id=$1',
    [studentId]
  );
  return parseInt(res.rows[0].balance);
}

// ── Teacher coin helpers ──────────────────────────────────────────────────────
async function getTeacherCoinBalance(teacherId) {
  const res = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM coin_ledger WHERE teacher_id=$1',
    [teacherId]
  );
  return parseInt(res.rows[0].balance);
}

// Award +1 coin to teacher on session completion.
// Also check if they hit 10 sessions this month for a +2 bonus.
async function awardTeacherSessionCoin(teacherId, bookingId) {
  try {
    await pool.query(
      `INSERT INTO coin_ledger (teacher_id, amount, source, description, ref_id)
       VALUES ($1, 1, 'session_completed', '+1 coin for completed tutoring session', $2)`,
      [teacherId, bookingId]
    );
    console.log(`✅ +1 teacher coin for teacher ${teacherId} (booking ${bookingId})`);

    // Check monthly 10-session bonus (count completed sessions this calendar month)
    const monthRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM bookings
       WHERE teacher_id = $1
         AND status = 'completed'
         AND DATE_TRUNC('month', slot_start) = DATE_TRUNC('month', NOW())`,
      [teacherId]
    );
    const monthlyCount = monthRes.rows[0]?.cnt || 0;

    if (monthlyCount === 10) {
      // Award the bonus exactly when they hit the 10th session (not every session after)
      await pool.query(
        `INSERT INTO coin_ledger (teacher_id, amount, source, description, ref_id)
         VALUES ($1, 2, 'monthly_bonus', '+2 bonus coins for completing 10 sessions this month', $2)`,
        [teacherId, bookingId]
      );
      console.log(`✅ +2 monthly bonus coins for teacher ${teacherId} (10 sessions this month)`);
    }
  } catch (err) {
    console.error('awardTeacherSessionCoin error:', err.message);
  }
}

module.exports = async function coinRoutes(app) {

  // GET /api/coins/balance
  app.get('/balance', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    const balance = await getCoinBalance(req.user.id);

    const ledger = await pool.query(
      `SELECT id, amount, source, description, ref_id, created_at
       FROM coin_ledger
       WHERE student_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    const pendingClaim = await pool.query(
      "SELECT id, status, claimed_at FROM coin_claims WHERE student_id=$1 AND status='pending'",
      [req.user.id]
    );

    const totalEarned = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS total FROM coin_ledger WHERE student_id=$1 AND amount > 0',
      [req.user.id]
    );

    return {
      balance,
      total_earned:      parseInt(totalEarned.rows[0].total),
      can_claim:         balance >= CLAIM_COINS && pendingClaim.rows.length === 0,
      can_redeem_mentor: balance >= MENTOR_COST,
      can_redeem_diary:  balance >= DIARY_COST,
      mentor_cost:       MENTOR_COST,
      diary_cost:        DIARY_COST,
      claim_threshold:   CLAIM_COINS,
      pending_claim:     pendingClaim.rows[0] || null,
      ledger:            ledger.rows,
    };
  });

  // POST /api/coins/redeem
  app.post('/redeem', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    const { type } = req.body || {};
    if (!['mentor', 'ia_diary'].includes(type))
      return reply.code(400).send({ error: "type must be 'mentor' or 'ia_diary'" });

    const cost      = type === 'mentor' ? MENTOR_COST : DIARY_COST;
    const runs      = type === 'mentor' ? 5 : 1;
    const coinType  = type === 'mentor' ? 'silver' : 'gold';
    const source    = type === 'mentor' ? 'redeem_mentor' : 'redeem_ia_diary';
    const desc      = type === 'mentor'
      ? `Redeemed ${MENTOR_COST} coins → 5 Mentor app runs`
      : `Redeemed ${DIARY_COST} coins → 1 IA Project Diary credit`;

    const balance = await getCoinBalance(req.user.id);
    if (balance < cost)
      return reply.code(400).send({
        error: `Not enough coins. Need ${cost}, you have ${balance}.`
      });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO coin_ledger (student_id, amount, source, description)
         VALUES ($1, $2, $3, $4)`,
        [req.user.id, -cost, source, desc]
      );
      await client.query(
        `INSERT INTO student_credits (student_id, coin_type, source, runs_total)
         VALUES ($1, $2, 'coin_redemption', $3)`,
        [req.user.id, coinType, runs]
      );
      await client.query('COMMIT');
      return { ok: true, coins_spent: cost, runs_granted: runs, type, new_balance: balance - cost };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // POST /api/coins/claim
  app.post('/claim', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    const { bank_details } = req.body || {};
    if (!bank_details || bank_details.trim().length < 10)
      return reply.code(400).send({ error: 'bank_details is required (account number, IFSC, account holder name)' });

    const balance = await getCoinBalance(req.user.id);
    if (balance < CLAIM_COINS)
      return reply.code(400).send({
        error: `You need ${CLAIM_COINS} coins to claim. You have ${balance}.`
      });

    const existing = await pool.query(
      "SELECT id FROM coin_claims WHERE student_id=$1 AND status='pending'",
      [req.user.id]
    );
    if (existing.rows.length > 0)
      return reply.code(400).send({ error: 'You already have a pending claim being processed.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO coin_ledger (student_id, amount, source, description)
         VALUES ($1, -500, 'claim_reward', 'Claimed ₹10,000 reward — 500 coins redeemed')`,
        [req.user.id]
      );
      const claimRes = await client.query(
        `INSERT INTO coin_claims (student_id, coins_used, amount_rs, bank_details)
         VALUES ($1, 500, 10000, $2) RETURNING id`,
        [req.user.id, bank_details.trim()]
      );
      await client.query('COMMIT');

      try {
        const studentRes = await pool.query(
          'SELECT name, email, phone FROM users WHERE id=$1', [req.user.id]
        );
        const s = studentRes.rows[0];
        const { sendMail } = require('../email');
        await sendMail({
          to: process.env.ADMIN_EMAIL,
          subject: '🎉 IBHighway: New ₹10,000 Coin Reward Claim',
          html: `
            <h2>New Reward Claim</h2>
            <p><strong>Student:</strong> ${s.name} (${s.email})</p>
            <p><strong>Phone:</strong> ${s.phone || 'N/A'}</p>
            <p><strong>Bank details:</strong><br/>${bank_details.replace(/\n/g,'<br/>')}</p>
            <p><strong>Claim ID:</strong> #${claimRes.rows[0].id}</p>
            <p>Please review and pay in the <a href="${process.env.APP_BASE_URL}/admin">Admin Panel</a>.</p>
          `,
        });
      } catch (e) {
        console.error('Claim email failed:', e.message);
      }

      return {
        ok: true,
        claim_id: claimRes.rows[0].id,
        message: 'Claim submitted! You will receive ₹10,000 within 3–5 business days once verified.',
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ADMIN: GET /api/coins/admin/claims
  app.get('/admin/claims', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    const res = await pool.query(`
      SELECT cc.*, u.name AS student_name, u.email AS student_email, u.phone AS student_phone,
             COALESCE((SELECT SUM(cl.amount) FROM coin_ledger cl WHERE cl.student_id = cc.student_id), 0) AS current_balance
      FROM coin_claims cc
      JOIN users u ON cc.student_id = u.id
      ORDER BY cc.claimed_at DESC
    `);
    return res.rows;
  });

  // ADMIN: PATCH /api/coins/admin/claims/:id/pay
  app.patch('/admin/claims/:id/pay', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    const { payment_ref, admin_notes } = req.body || {};
    const res = await pool.query(
      `UPDATE coin_claims
       SET status='paid', paid_at=NOW(), payment_ref=$1, admin_notes=$2
       WHERE id=$3 AND status='pending' RETURNING *`,
      [payment_ref || null, admin_notes || null, req.params.id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Claim not found or already processed' });
    return { ok: true, claim: res.rows[0] };
  });

  // ADMIN: PATCH /api/coins/admin/claims/:id/reject
  app.patch('/admin/claims/:id/reject', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    const { admin_notes } = req.body || {};
    const claimRes = await pool.query(
      "SELECT * FROM coin_claims WHERE id=$1 AND status='pending'", [req.params.id]
    );
    if (!claimRes.rows[0]) return reply.code(404).send({ error: 'Claim not found or already processed' });

    const claim = claimRes.rows[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO coin_ledger (student_id, amount, source, description, ref_id)
         VALUES ($1, 500, 'claim_refund', 'Claim rejected — 500 coins refunded', $2)`,
        [claim.student_id, claim.id]
      );
      await client.query(
        `UPDATE coin_claims SET status='rejected', admin_notes=$1 WHERE id=$2`,
        [admin_notes || null, req.params.id]
      );
      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ── Teacher coin routes ────────────────────────────────────────────────────

  // GET /api/coins/teacher/balance — teacher sees their coin balance + ledger
  app.get('/teacher/balance', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'teacher')
      return reply.code(403).send({ error: 'Teachers only' });

    const balance = await getTeacherCoinBalance(req.user.id);

    const ledger = await pool.query(
      `SELECT id, amount, source, description, ref_id, created_at
       FROM coin_ledger
       WHERE teacher_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    const totalEarned = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS total FROM coin_ledger WHERE teacher_id=$1 AND amount > 0',
      [req.user.id]
    );

    return {
      balance,
      total_earned: parseInt(totalEarned.rows[0].total),
      ledger: ledger.rows,
    };
  });

  // ADMIN: GET /api/coins/admin/transactions
  app.get('/admin/transactions', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Admin only' });

    const { from, to } = req.query;
    const fromClause = from ? `AND p.created_at >= '${from}'` : '';
    const toClause   = to   ? `AND p.created_at <= '${to}'`   : '';
    const fromG = from ? `AND gb.created_at >= '${from}'` : '';
    const toG   = to   ? `AND gb.created_at <= '${to}'`   : '';

    const [tutoring, guidance, coinBalances, totalRevenue] = await Promise.all([
      pool.query(`
        SELECT
          p.id AS payment_id, b.id AS booking_id,
          TO_CHAR(b.slot_start AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH12:MI AM') AS session_date,
          s.id AS student_id, s.name AS student_name, s.email AS student_email,
          t.id AS teacher_id, t.name AS teacher_name, t.email AS teacher_email,
          p.amount AS total_amount,
          p.split_platform AS platform_fee,
          p.split_teacher  AS teacher_payout,
          p.status AS payment_status,
          TO_CHAR(p.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH12:MI AM') AS paid_at,
          'tutoring' AS booking_type
        FROM payments p
        JOIN bookings b ON p.booking_id = b.id
        JOIN users s ON b.student_id = s.id
        JOIN users t ON b.teacher_id = t.id
        WHERE p.status = 'paid' ${fromClause} ${toClause}
        ORDER BY p.created_at DESC
      `),
      pool.query(`
        SELECT
          gb.id AS booking_id,
          TO_CHAR(gb.slot_start AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH12:MI AM') AS session_date,
          s.id AS student_id, s.name AS student_name, s.email AS student_email,
          t.id AS teacher_id, t.name AS teacher_name, t.email AS teacher_email,
          gb.fee AS total_amount,
          gb.platform_fee,
          gb.teacher_payout,
          gb.payment_status,
          TO_CHAR(gb.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH12:MI AM') AS paid_at,
          gb.guidance_type AS booking_type
        FROM guidance_bookings gb
        JOIN users s ON gb.student_id = s.id
        JOIN users t ON gb.teacher_id = t.id
        WHERE gb.payment_status = 'paid' ${fromG} ${toG}
        ORDER BY gb.created_at DESC
      `),
      pool.query(`
        SELECT
          u.id, u.name, u.email,
          COALESCE(SUM(CASE WHEN cl.amount > 0 THEN cl.amount ELSE 0 END), 0) AS total_earned,
          COALESCE(SUM(CASE WHEN cl.amount < 0 THEN ABS(cl.amount) ELSE 0 END), 0) AS total_spent,
          COALESCE(SUM(cl.amount), 0) AS current_balance
        FROM users u
        LEFT JOIN coin_ledger cl ON cl.student_id = u.id
        WHERE u.role = 'student'
        GROUP BY u.id, u.name, u.email
        ORDER BY current_balance DESC
      `),
      pool.query(`
        SELECT
          COALESCE((SELECT SUM(split_platform) FROM payments WHERE status='paid'), 0) AS tutoring_revenue,
          COALESCE((SELECT SUM(platform_fee)   FROM guidance_bookings WHERE payment_status='paid'), 0) AS guidance_revenue
      `),
    ]);

    const rev = totalRevenue.rows[0];
    return {
      tutoring:      tutoring.rows,
      guidance:      guidance.rows,
      coin_balances: coinBalances.rows,
      summary: {
        tutoring_revenue: parseFloat(rev.tutoring_revenue),
        guidance_revenue: parseFloat(rev.guidance_revenue),
        total_revenue:    parseFloat(rev.tutoring_revenue) + parseFloat(rev.guidance_revenue),
      },
    };
  });
};

module.exports.awardTeacherSessionCoin = awardTeacherSessionCoin;
module.exports.getTeacherCoinBalance    = getTeacherCoinBalance;
