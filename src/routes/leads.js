const crypto = require('crypto');
const pool   = require('../db');
const email  = require('../email');

// How long a registration link stays valid after admin approval.
const TOKEN_TTL_DAYS = 7;

module.exports = async function leadsRoutes(app) {

  // Guard: admin only (mirror of admin.js)
  async function adminOnly(req, reply) {
    await app.authenticate(req, reply);
    if (reply.sent) return;
    if (!req.user || req.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin access only' });
    }
  }

  // Public rate limit so a bot can't spam leads.
  const publicLimit = {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  };

  // ── POST /api/leads  (public) ─────────────────────────────────
  // Parent submits the intake form.
  app.post('/', publicLimit, async (req, reply) => {
    const b = req.body || {};
    const required = ['parent_name', 'student_name', 'email', 'phone_primary'];
    for (const k of required) {
      if (!b[k] || String(b[k]).trim() === '') {
        return reply.code(400).send({ error: `${k} is required` });
      }
    }

    // Very light email sanity check.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) {
      return reply.code(400).send({ error: 'Please provide a valid email address' });
    }

    try {
      const res = await pool.query(
        `INSERT INTO leads (
           parent_name, student_name, email,
           phone_primary, phone_secondary,
           country, timezone, ib_class,
           preferred_timings, message
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          b.parent_name.trim(),
          b.student_name.trim(),
          b.email.trim().toLowerCase(),
          b.phone_primary.trim(),
          b.phone_secondary ? b.phone_secondary.trim() : null,
          b.country || null,
          b.timezone || null,
          b.ib_class || null,
          b.preferred_timings || null,
          b.message || null,
        ]
      );
      const lead = res.rows[0];

      // Fire-and-forget admin notification — don't block the parent's response
      // on an email hiccup.
      email.notifyAdminNewLead(lead).catch(err => {
        req.log.warn({ err }, 'admin notification email failed');
      });

      return reply.code(201).send({
        ok: true,
        message: 'Thank you — we have received your details and will be in touch shortly.',
      });
    } catch (err) {
      req.log.error({ err }, 'lead create failed');
      return reply.code(500).send({ error: 'Could not save your details. Please try again in a moment.' });
    }
  });

  // ── GET /api/admin/leads ──────────────────────────────────────
  // Admin lists leads. Optional ?status=new to filter.
  app.get('/admin', { onRequest: [adminOnly] }, async (req) => {
    const status = req.query && req.query.status;
    const res = status
      ? await pool.query(`SELECT * FROM leads WHERE status=$1 ORDER BY created_at DESC`, [status])
      : await pool.query(`SELECT * FROM leads ORDER BY created_at DESC`);
    return res.rows;
  });

  // ── POST /api/admin/leads/:id/approve ─────────────────────────
  // Admin approves a lead → issue one-time registration token, email parent.
  app.post('/admin/:id/approve', { onRequest: [adminOnly] }, async (req, reply) => {
    const id = Number(req.params.id);
    const lRes = await pool.query(`SELECT * FROM leads WHERE id=$1`, [id]);
    const lead = lRes.rows[0];
    if (!lead) return reply.code(404).send({ error: 'Lead not found' });

    if (lead.status === 'registered') {
      return reply.code(409).send({ error: 'This lead has already registered.' });
    }

    // Generate a fresh token. (Each approval issues a new link — the old one,
    // if any, is left in the table and will expire naturally.)
    const token   = crypto.randomBytes(24).toString('hex'); // 48-char hex
    const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO registration_tokens (token, lead_id, email, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [token, lead.id, lead.email, expires]
    );

    await pool.query(
      `UPDATE leads SET status='approved', updated_at=NOW() WHERE id=$1`,
      [lead.id]
    );

    // Build the parent-facing registration URL.
    const appBase = (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
    const link    = `${appBase}/register?token=${token}`;

    // Fire-and-forget the email; surface errors in logs only.
    const mailResult = await email.sendRegistrationLinkToParent({
      email: lead.email,
      parent_name: lead.parent_name,
      student_name: lead.student_name,
      link,
    });

    return {
      ok: true,
      token,
      link,
      expires_at: expires,
      email_sent: !!mailResult.ok,
      email_logged_only: !!mailResult.logged,
    };
  });

  // ── POST /api/admin/leads/:id/reject ──────────────────────────
  app.post('/admin/:id/reject', { onRequest: [adminOnly] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { notes } = req.body || {};
    const res = await pool.query(
      `UPDATE leads SET status='rejected', admin_notes=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [notes || null, id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Lead not found' });
    return { ok: true, lead: res.rows[0] };
  });

  // ── POST /api/admin/leads/:id/contacted ───────────────────────
  // Optional middle state: admin has called/emailed the parent but not yet
  // approved. Lets you track "in progress" leads.
  app.post('/admin/:id/contacted', { onRequest: [adminOnly] }, async (req, reply) => {
    const id = Number(req.params.id);
    const { notes } = req.body || {};
    const res = await pool.query(
      `UPDATE leads SET status='contacted', admin_notes=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [notes || null, id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Lead not found' });
    return { ok: true, lead: res.rows[0] };
  });

  // ── GET /api/leads/token/:token  (public, used by Register page) ──
  // Returns non-sensitive info so the Register page can pre-fill email +
  // greet by name. Does NOT consume the token — that happens at register.
  app.get('/token/:token', publicLimit, async (req, reply) => {
    const res = await pool.query(
      `SELECT rt.token, rt.email, rt.expires_at, rt.used_at,
              l.parent_name, l.student_name
       FROM registration_tokens rt
       JOIN leads l ON rt.lead_id = l.id
       WHERE rt.token = $1`,
      [req.params.token]
    );
    const row = res.rows[0];
    if (!row)            return reply.code(404).send({ error: 'Unknown registration link.' });
    if (row.used_at)     return reply.code(410).send({ error: 'This registration link has already been used.' });
    if (new Date(row.expires_at) < new Date())
                         return reply.code(410).send({ error: 'This registration link has expired. Please ask the admin to issue a new one.' });
    return {
      email: row.email,
      parent_name:  row.parent_name,
      student_name: row.student_name,
      expires_at:   row.expires_at,
    };
  });
};
