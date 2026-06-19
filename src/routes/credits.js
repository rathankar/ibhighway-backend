const pool = require('../db');

module.exports = async function creditsRoutes(app) {

  // GET /api/credits  - get student's credits
  app.get('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    const res = await pool.query(
      `SELECT id, coin_type, source, runs_total, runs_used, created_at, expires_at
       FROM student_credits
       WHERE student_id=$1
       ORDER BY created_at ASC`,
      [req.user.id]
    );

    // Count completed tutoring bookings for progress display
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM bookings
       WHERE student_id=$1 AND status='completed' AND booking_type='tutoring'`,
      [req.user.id]
    );
    const completedBookings = parseInt(countRes.rows[0].count);

    return {
      credits: res.rows,
      completed_bookings: completedBookings,
      silver_progress: Math.min(completedBookings, 5),
      gold_progress:   Math.min(completedBookings, 10),
    };
  });

  // POST /api/credits/:id/use  - use a credit run (app = 'ia_diary' | 'ia_mentor' | 'ee_mentor' | 'tok_mentor')
  app.post('/:id/use', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    const { app: appName } = req.body || {};
    const creditId = parseInt(req.params.id);

    const res = await pool.query(
      'SELECT * FROM student_credits WHERE id=$1 AND student_id=$2',
      [creditId, req.user.id]
    );
    const credit = res.rows[0];
    if (!credit) return reply.code(404).send({ error: 'Credit not found' });
    if (credit.runs_used >= credit.runs_total)
      return reply.code(400).send({ error: 'No runs remaining on this credit' });
    if (credit.expires_at && new Date(credit.expires_at) < new Date())
      return reply.code(400).send({ error: 'This credit has expired' });

    // Validate app access against coin type
    const ALLOWED = {
      registration: ['ia_diary_basic'],
      silver: [
        // Physics
        'ia_mentor', 'ee_mentor', 'tok_mentor',
        // Chemistry
        'chem_ia', 'chem_ee', 'chem_tok',
        // Biology
        'bio_ia', 'bio_ee', 'bio_tok',
        // Environmental Systems & Societies
        'ess_ia', 'ess_ee', 'ess_tok',
      ],
      gold: ['ia_diary'],
    };
    if (!ALLOWED[credit.coin_type]?.includes(appName)) {
      return reply.code(400).send({
        error: 'This credit cannot be used for ' + appName,
        allowed: ALLOWED[credit.coin_type],
      });
    }

    await pool.query(
      `UPDATE student_credits
       SET runs_used = runs_used + 1,
           app_used  = COALESCE(app_used || ', ' || $1, $1),
           used_at   = CASE WHEN runs_used + 1 >= runs_total THEN NOW() ELSE used_at END
       WHERE id=$2`,
      [appName, creditId]
    );

    return { ok: true, runs_remaining: credit.runs_total - credit.runs_used - 1 };
  });

  // POST /api/credits/:id/convert  - convert a gold coin → 10 silver runs
  // One-time action: gold coin is consumed and 10 silver runs are created.
  app.post('/:id/convert', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'student')
      return reply.code(403).send({ error: 'Students only' });

    const creditId = parseInt(req.params.id);

    const res = await pool.query(
      'SELECT * FROM student_credits WHERE id=$1 AND student_id=$2',
      [creditId, req.user.id]
    );
    const credit = res.rows[0];
    if (!credit)
      return reply.code(404).send({ error: 'Credit not found' });
    if (credit.coin_type !== 'gold')
      return reply.code(400).send({ error: 'Only gold coins can be converted' });
    if (credit.runs_used >= credit.runs_total)
      return reply.code(400).send({ error: 'This gold coin has already been used' });

    // Atomic: mark gold as used + insert 10 silver runs
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Mark the gold coin as fully used (converted)
      await client.query(
        `UPDATE student_credits
         SET runs_used = runs_total,
             app_used  = 'converted_to_silver',
             used_at   = NOW()
         WHERE id=$1`,
        [creditId]
      );

      // Award 10 silver coin runs
      await client.query(
        `INSERT INTO student_credits (student_id, coin_type, source, runs_total)
         VALUES ($1, 'silver', 'gold_conversion', 10)`,
        [req.user.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { ok: true, message: 'Gold coin converted to 10 silver mentor runs!' };
  });
};
