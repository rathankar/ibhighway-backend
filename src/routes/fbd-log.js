/**
 * FBD Session Log — captures every FBD tool interaction for prompt improvement
 * POST /api/fbd-log  — called silently from fbd/app.js when student finishes
 * GET  /api/fbd-log  — admin view: list sessions with filters
 * GET  /api/fbd-log/:id — full session detail
 */
const pool = require('../db');

module.exports = async function (app) {

  // ── POST /api/fbd-log — receive a completed session ─────────────────────────
  app.post('/', async (req, reply) => {
    try {
      const {
        session_id, tool, access_code, gemini_model,
        started_at, ended_at,
        scene_analysis, objects_worked,
        total_ai_calls, completed
      } = req.body;

      if (!session_id) return reply.status(400).send({ error: 'Missing session_id' });

      await pool.query(`
        INSERT INTO fbd_sessions
          (session_id, tool, access_code, gemini_model,
           started_at, ended_at, scene_analysis, objects_worked,
           total_ai_calls, completed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (session_id) DO UPDATE SET
          ended_at        = EXCLUDED.ended_at,
          objects_worked  = EXCLUDED.objects_worked,
          total_ai_calls  = EXCLUDED.total_ai_calls,
          completed       = EXCLUDED.completed
      `, [
        session_id,
        tool || 'fbd',
        access_code || null,
        gemini_model || null,
        started_at || new Date().toISOString(),
        ended_at || new Date().toISOString(),
        JSON.stringify(scene_analysis || {}),
        JSON.stringify(objects_worked || []),
        total_ai_calls || 0,
        completed || false
      ]);

      return reply.send({ ok: true });
    } catch (e) {
      console.error('[fbd-log] POST error:', e.message);
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── GET /api/fbd-log — admin list ────────────────────────────────────────────
  // Query params: ?from=2026-01-01&to=2026-12-31&limit=50&offset=0
  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    try {
      if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Admin only' });

      const { from, to, limit = 50, offset = 0 } = req.query;
      const params = [];
      let where = '';

      if (from) { params.push(from); where += ` AND started_at >= $${params.length}`; }
      if (to)   { params.push(to);   where += ` AND started_at <= $${params.length}`; }

      params.push(Number(limit));
      params.push(Number(offset));

      const rows = await pool.query(`
        SELECT
          id, session_id, tool, access_code, gemini_model,
          started_at, ended_at, total_ai_calls, completed,
          jsonb_array_length(objects_worked::jsonb) AS objects_count
        FROM fbd_sessions
        WHERE 1=1 ${where}
        ORDER BY started_at DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `, params);

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM fbd_sessions WHERE 1=1 ${where}`,
        params.slice(0, params.length - 2)
      );

      return reply.send({
        total: Number(countRes.rows[0].count),
        sessions: rows.rows
      });
    } catch (e) {
      console.error('[fbd-log] GET list error:', e.message);
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── GET /api/fbd-log/:id — full session detail ───────────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    try {
      if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Admin only' });

      const res = await pool.query(
        `SELECT * FROM fbd_sessions WHERE session_id = $1 OR id = $1::integer LIMIT 1`,
        [req.params.id]
      );
      if (!res.rows.length) return reply.status(404).send({ error: 'Not found' });
      return reply.send(res.rows[0]);
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
};
