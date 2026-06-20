'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  IBHIGHWAY TOOLS — Auth + Analytics Routes                       ║
 * ║  Handles standalone HTML tools at ibhighway.com/tools/           ║
 * ║                                                                  ║
 * ║  Routes:                                                         ║
 * ║    POST /auth/verify          — validate IBH-XXXX-XXXX code      ║
 * ║    POST /analytics/access     — log tool open                    ║
 * ║    POST /analytics/model      — log which Gemini model was used  ║
 * ║    GET  /admin/usage          — usage dashboard (admin only)     ║
 * ║    POST /admin/generate-code  — create new access code (admin)   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * DB MIGRATION — run once in Supabase SQL editor:
 *
 *   CREATE TABLE IF NOT EXISTS access_codes (
 *     id          SERIAL PRIMARY KEY,
 *     code        VARCHAR(20) UNIQUE NOT NULL,
 *     tier        INTEGER NOT NULL,
 *     email       VARCHAR(255),
 *     name        VARCHAR(255),
 *     created_at  TIMESTAMPTZ DEFAULT NOW(),
 *     expires_at  TIMESTAMPTZ,
 *     is_active   BOOLEAN DEFAULT TRUE
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS tool_access_log (
 *     id          SERIAL PRIMARY KEY,
 *     code        VARCHAR(20) NOT NULL,
 *     tool        VARCHAR(50) NOT NULL,
 *     model_used  VARCHAR(50),
 *     ts          TIMESTAMPTZ DEFAULT NOW()
 *   );
 *
 *   CREATE INDEX IF NOT EXISTS idx_log_code ON tool_access_log(code);
 *   CREATE INDEX IF NOT EXISTS idx_log_tool ON tool_access_log(tool);
 *   CREATE INDEX IF NOT EXISTS idx_log_ts   ON tool_access_log(ts);
 */

const pool = require('../db');
const { MILESTONE_TEMPLATES } = require('./deadlines');

module.exports = async function toolsAuthRoutes(fastify) {

  // ─── AUTH: VERIFY ACCESS CODE ─────────────────────────────────────
  fastify.post('/auth/verify', async (req, reply) => {
    const { code } = req.body || {};
    if (!code) return reply.code(400).send({ valid: false, error: 'No code provided' });

    const clean = code.trim().toUpperCase();

    // Dev bypass — test codes work without DB entries
    const DEV_CODES = { 'IBH-TEST-0001': 1, 'IBH-TEST-0002': 2, 'IBH-TEST-0003': 3 };
    if (DEV_CODES[clean] !== undefined) {
      return reply.send({ valid: true, tier: DEV_CODES[clean], name: 'Test User', email: '' });
    }

    const result = await pool.query(
      `SELECT tier, expires_at, is_active, name, email
       FROM access_codes WHERE code = $1`,
      [clean]
    );

    if (result.rows.length === 0) return reply.send({ valid: false, error: 'Code not found' });

    const row = result.rows[0];
    if (!row.is_active)  return reply.send({ valid: false, error: 'Code is deactivated' });
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return reply.send({ valid: false, error: 'Code has expired' });
    }

    return reply.send({ valid: true, tier: row.tier, name: row.name, email: row.email });
  });

  // ─── ANALYTICS: LOG TOOL OPEN ─────────────────────────────────────
  fastify.post('/analytics/access', async (req, reply) => {
    const { code, tool, ts } = req.body || {};
    if (!code || !tool) return reply.code(400).send({ ok: false });

    await pool.query(
      `INSERT INTO tool_access_log (code, tool, ts) VALUES ($1, $2, $3)`,
      [code.toUpperCase(), tool, ts || new Date().toISOString()]
    );

    return reply.send({ ok: true });
  });

  // ─── ANALYTICS: LOG MODEL USED ────────────────────────────────────
  fastify.post('/analytics/model', async (req, reply) => {
    const { code, tool, model } = req.body || {};
    if (!code || !tool) return reply.code(400).send({ ok: false });

    await pool.query(
      `UPDATE tool_access_log SET model_used = $1
       WHERE id = (
         SELECT id FROM tool_access_log
         WHERE code = $2 AND tool = $3
         ORDER BY ts DESC LIMIT 1
       )`,
      [model, code.toUpperCase(), tool]
    );

    return reply.send({ ok: true });
  });

  // ─── ADMIN: USAGE DASHBOARD ───────────────────────────────────────
  // Header: x-admin-token: <ADMIN_SECRET env var>
  fastify.get('/admin/usage', { preHandler: adminAuth }, async (req, reply) => {

    const byTool = await pool.query(`
      SELECT
        tool,
        COUNT(*)                                                      AS total,
        COUNT(DISTINCT code)                                          AS unique_users,
        COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '7 days')       AS last_7d,
        COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '30 days')      AS last_30d
      FROM tool_access_log
      GROUP BY tool
      ORDER BY total DESC
    `);

    const byUser = await pool.query(`
      SELECT
        l.code,
        a.name,
        a.email,
        a.tier,
        COUNT(*)       AS total_accesses,
        MAX(l.ts)      AS last_seen,
        COUNT(DISTINCT l.tool) AS tools_used
      FROM tool_access_log l
      JOIN access_codes a ON a.code = l.code
      GROUP BY l.code, a.name, a.email, a.tier
      ORDER BY total_accesses DESC
      LIMIT 100
    `);

    const byModel = await pool.query(`
      SELECT model_used, COUNT(*) AS uses
      FROM tool_access_log
      WHERE model_used IS NOT NULL
      GROUP BY model_used
      ORDER BY uses DESC
    `);

    const summary = await pool.query(`
      SELECT
        COUNT(DISTINCT code)                                          AS total_codes,
        COUNT(DISTINCT code) FILTER (WHERE ts > NOW() - INTERVAL '7 days')  AS active_7d,
        COUNT(DISTINCT code) FILTER (WHERE ts > NOW() - INTERVAL '30 days') AS active_30d,
        COUNT(*)                                                      AS total_opens
      FROM tool_access_log
    `);

    return reply.send({
      summary:  summary.rows[0],
      byTool:   byTool.rows,
      byUser:   byUser.rows,
      byModel:  byModel.rows,
    });
  });

  // ─── ADMIN: GENERATE ACCESS CODE ─────────────────────────────────
  fastify.post('/admin/generate-code', { preHandler: adminAuth }, async (req, reply) => {
    const { tier, email = '', name = '', months = 12 } = req.body || {};
    if (!tier || ![1, 2, 3].includes(Number(tier))) {
      return reply.code(400).send({ error: 'tier must be 1, 2, or 3' });
    }

    // IBH-XXXX-XXXX  (no ambiguous chars: 0/O/I/1)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = (n) => Array.from({ length: n },
      () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const code = `IBH-${seg(4)}-${seg(4)}`;

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + Number(months));

    await pool.query(
      `INSERT INTO access_codes (code, tier, email, name, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [code, Number(tier), email, name, expiresAt.toISOString()]
    );

    return reply.send({ code, tier: Number(tier), expires_at: expiresAt, email, name });
  });

  // ─── ADMIN: LIST ALL ACCESS CODES ────────────────────────────────
  fastify.get('/admin/codes', { preHandler: adminAuth }, async (req, reply) => {
    const result = await pool.query(`
      SELECT
        a.code, a.name, a.email, a.tier, a.is_active,
        a.created_at, a.expires_at,
        COUNT(l.id)  AS total_uses,
        MAX(l.ts)    AS last_seen
      FROM access_codes a
      LEFT JOIN tool_access_log l ON l.code = a.code
      GROUP BY a.code, a.name, a.email, a.tier, a.is_active, a.created_at, a.expires_at
      ORDER BY a.created_at DESC
    `);
    return reply.send(result.rows);
  });

  // ─── ADMIN: DEACTIVATE CODE ───────────────────────────────────────
  fastify.patch('/admin/codes/:code/deactivate', { preHandler: adminAuth }, async (req, reply) => {
    const { code } = req.params;
    await pool.query(
      `UPDATE access_codes SET is_active = FALSE WHERE code = $1`,
      [code.toUpperCase()]
    );
    return reply.send({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DEADLINE PROXY — code-based auth (no JWT needed for standalone tools)
  // Uses access_codes table to identify the student, then proxies to
  // student_deadlines + deadline_milestones tables directly.
  // ═══════════════════════════════════════════════════════════════════

  // Shared: resolve access code → student id
  async function resolveStudent(code) {
    const clean = (code || '').trim().toUpperCase();
    const DEV = { 'IBH-TEST-0001': 1, 'IBH-TEST-0002': 2, 'IBH-TEST-0003': 3 };
    if (DEV[clean] !== undefined) return { id: DEV[clean] };
    const r = await pool.query(
      `SELECT id FROM access_codes WHERE code=$1 AND is_active=TRUE`, [clean]
    );
    return r.rows[0] || null;
  }

  // POST /deadlines/tool — create deadline + milestones
  fastify.post('/deadlines/tool', async (req, reply) => {
    const { code, assessment_type, subject, title, school_deadline } = req.body || {};
    if (!code) return reply.code(400).send({ error: 'code required' });
    const student = await resolveStudent(code);
    if (!student) return reply.code(403).send({ error: 'Invalid or inactive code' });
    if (!school_deadline) return reply.code(400).send({ error: 'school_deadline required' });

    const type = (assessment_type || 'custom').toLowerCase().trim();
    const templates = (MILESTONE_TEMPLATES || {})[type] || [];
    const deadline = new Date(school_deadline + 'T00:00:00');
    const milestones = templates.map(t => {
      const due = new Date(deadline);
      due.setDate(due.getDate() + t.weeksOffset * 7);
      return { ...t, due_date: due.toISOString().split('T')[0] };
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const dRes = await client.query(
        `INSERT INTO student_deadlines (student_id, assessment_type, subject, title, school_deadline)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [student.id, type, subject || title || 'General', title || null, school_deadline]
      );
      const deadlineId = dRes.rows[0].id;
      for (const m of milestones) {
        await client.query(
          `INSERT INTO deadline_milestones (deadline_id, milestone_key, title, description, due_date, order_index)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [deadlineId, m.key, m.title, m.description, m.due_date, m.order]
        );
      }
      await client.query('COMMIT');
      const full = await pool.query(
        `SELECT d.*, json_agg(m ORDER BY m.order_index) AS milestones
         FROM student_deadlines d
         LEFT JOIN deadline_milestones m ON m.deadline_id=d.id
         WHERE d.id=$1 GROUP BY d.id`, [deadlineId]
      );
      return reply.code(201).send(full.rows[0]);
    } catch(err) {
      await client.query('ROLLBACK');
      return reply.code(500).send({ error: err.message });
    } finally { client.release(); }
  });

  // GET /deadlines/tool?code=IBH-XXXX-XXXX
  fastify.get('/deadlines/tool', async (req, reply) => {
    const { code } = req.query || {};
    if (!code) return reply.code(400).send({ error: 'code required' });
    const student = await resolveStudent(code);
    if (!student) return reply.code(403).send({ error: 'Invalid code' });
    const res = await pool.query(
      `SELECT d.*, json_agg(m ORDER BY m.order_index) AS milestones
       FROM student_deadlines d
       LEFT JOIN deadline_milestones m ON m.deadline_id=d.id
       WHERE d.student_id=$1 AND d.is_active=TRUE
       GROUP BY d.id ORDER BY d.school_deadline ASC`,
      [student.id]
    );
    return reply.send({ deadlines: res.rows });
  });

  // PATCH /deadlines/tool/milestones/:id
  fastify.patch('/deadlines/tool/milestones/:id', async (req, reply) => {
    const { code, is_completed } = req.body || {};
    if (!code) return reply.code(400).send({ error: 'code required' });
    const student = await resolveStudent(code);
    if (!student) return reply.code(403).send({ error: 'Invalid code' });
    const chk = await pool.query(
      `SELECT m.id FROM deadline_milestones m
       JOIN student_deadlines d ON m.deadline_id=d.id
       WHERE m.id=$1 AND d.student_id=$2`,
      [req.params.id, student.id]
    );
    if (!chk.rows[0]) return reply.code(404).send({ error: 'Not found' });
    await pool.query(
      `UPDATE deadline_milestones SET is_completed=$1, completed_at=$2 WHERE id=$3`,
      [!!is_completed, is_completed ? new Date() : null, req.params.id]
    );
    return reply.send({ ok: true });
  });

  // DELETE /deadlines/tool/:id
  fastify.delete('/deadlines/tool/:id', async (req, reply) => {
    const { code } = req.body || {};
    if (!code) return reply.code(400).send({ error: 'code required' });
    const student = await resolveStudent(code);
    if (!student) return reply.code(403).send({ error: 'Invalid code' });
    const res = await pool.query(
      `UPDATE student_deadlines SET is_active=FALSE, updated_at=NOW()
       WHERE id=$1 AND student_id=$2 RETURNING id`,
      [req.params.id, student.id]
    );
    if (!res.rows[0]) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ ok: true });
  });

};

// ─── ADMIN AUTH MIDDLEWARE ────────────────────────────────────────
async function adminAuth(req, reply) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_SECRET) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}
