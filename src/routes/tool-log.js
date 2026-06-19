/**
 * Universal Tool Session Log
 * POST /api/tool-log  — receive session from any IBH tool (no auth, fire-and-forget)
 * GET  /api/tool-log  — admin list with filters (?tool=fbd&from=&to=&limit=&offset=)
 * GET  /api/tool-log/:id — full session detail
 * GET  /api/tool-log/summary — per-tool counts + event type breakdown (admin)
 */
const pool = require('../db');

module.exports = async function (app) {

  // ── POST — receive session log ────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    try {
      const {
        session_id, tool, access_code, gemini_model,
        started_at, ended_at, metadata, events, completed
      } = req.body || {};

      if (!session_id || !tool) {
        return reply.status(400).send({ error: 'Missing session_id or tool' });
      }

      // Truncate events array to 500 entries max (safety — no runaway logs)
      const safeEvents = Array.isArray(events) ? events.slice(0, 500) : [];

      await pool.query(`
        INSERT INTO tool_sessions
          (session_id, tool, access_code, gemini_model,
           started_at, ended_at, metadata, events,
           event_count, completed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (session_id) DO UPDATE SET
          ended_at    = EXCLUDED.ended_at,
          gemini_model= EXCLUDED.gemini_model,
          metadata    = EXCLUDED.metadata,
          events      = EXCLUDED.events,
          event_count = EXCLUDED.event_count,
          completed   = EXCLUDED.completed
      `, [
        session_id,
        tool,
        access_code || null,
        gemini_model || null,
        started_at  || new Date().toISOString(),
        ended_at    || new Date().toISOString(),
        JSON.stringify(metadata || {}),
        JSON.stringify(safeEvents),
        safeEvents.length,
        completed   || false
      ]);

      return reply.send({ ok: true });
    } catch (e) {
      console.error('[tool-log] POST error:', e.message);
      // Return 200 anyway — never make the tool fail because of logging
      return reply.send({ ok: false, error: e.message });
    }
  });

  // ── GET /summary — event-type breakdown per tool (admin) ─────────────────────
  app.get('/summary', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Admin only' });
    try {
      const { from, to } = req.query;
      const params = [];
      let where = 'WHERE 1=1';
      if (from) { params.push(from); where += ` AND started_at >= $${params.length}`; }
      if (to)   { params.push(to);   where += ` AND started_at <= $${params.length}`; }

      const totals = await pool.query(`
        SELECT tool,
               COUNT(*)                              AS sessions,
               COUNT(*) FILTER (WHERE completed)     AS completed,
               SUM(event_count)                      AS total_events,
               MIN(started_at)                       AS first_seen,
               MAX(started_at)                       AS last_seen
        FROM tool_sessions ${where}
        GROUP BY tool ORDER BY sessions DESC
      `, params);

      // Top 10 event types across all tools
      const topEvents = await pool.query(`
        SELECT e->>'type' AS event_type, COUNT(*) AS cnt
        FROM tool_sessions ${where},
             jsonb_array_elements(events) e
        GROUP BY event_type ORDER BY cnt DESC LIMIT 10
      `, params);

      return reply.send({ by_tool: totals.rows, top_events: topEvents.rows });
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── GET / — list sessions (admin) ────────────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Admin only' });
    try {
      const { tool, from, to, limit = 50, offset = 0 } = req.query;
      const params = [];
      let where = 'WHERE 1=1';
      if (tool) { params.push(tool); where += ` AND tool = $${params.length}`; }
      if (from) { params.push(from); where += ` AND started_at >= $${params.length}`; }
      if (to)   { params.push(to);   where += ` AND started_at <= $${params.length}`; }

      const countParams = [...params];
      params.push(Number(limit), Number(offset));

      const rows = await pool.query(`
        SELECT id, session_id, tool, access_code, gemini_model,
               started_at, ended_at, event_count, completed, metadata
        FROM tool_sessions ${where}
        ORDER BY started_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params);

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM tool_sessions ${where}`, countParams
      );

      return reply.send({ total: Number(countRes.rows[0].count), sessions: rows.rows });
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ── GET /:id — full session with all events (admin) ──────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.status(403).send({ error: 'Admin only' });
    try {
      const res = await pool.query(
        `SELECT * FROM tool_sessions WHERE session_id = $1 OR id = $1::integer LIMIT 1`,
        [req.params.id]
      );
      if (!res.rows.length) return reply.status(404).send({ error: 'Not found' });
      return reply.send(res.rows[0]);
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
};
