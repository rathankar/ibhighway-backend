const pool = require('../db');

module.exports = async function messageRoutes(app) {

  function containsContactInfo(text) {
    const t = text.toLowerCase();
    if (/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/.test(t)) return true;
    const digitsOnly = t.replace(/[^\d]/g, '');
    if (digitsOnly.length >= 7 && /(\d[\s\-\.\(\)]{0,2}){7,}/.test(t)) return true;
    if (/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b.*\b(zero|one|two|three|four|five|six|seven|eight|nine)\b.*\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/.test(t)) return true;
    return false;
  }

  // POST /api/messages  — send a message
  // Accepts both { receiver_id, content } and { recipient_id, body } for compatibility
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const body_obj = req.body || {};
    const receiver_id = body_obj.receiver_id || body_obj.recipient_id;
    const content = body_obj.content || body_obj.body;
    const booking_id = body_obj.booking_id;

    if (!receiver_id || !content || !String(content).trim()) {
      return reply.code(400).send({ error: 'receiver_id and content are required' });
    }

    if (containsContactInfo(String(content))) {
      return reply.code(400).send({
        error: 'Your message was not sent. Sharing phone numbers or email addresses is not permitted on IBHighway.',
      });
    }

    const recvRes = await pool.query('SELECT id, role FROM users WHERE id=$1', [receiver_id]);
    if (!recvRes.rows[0]) return reply.code(404).send({ error: 'Recipient not found' });

    const senderRole   = req.user.role;
    const receiverRole = recvRes.rows[0].role;
    if (senderRole === 'student' && receiverRole !== 'teacher') {
      return reply.code(403).send({ error: 'Students can only message teachers' });
    }
    if (senderRole === 'teacher' && receiverRole !== 'student') {
      return reply.code(403).send({ error: 'Teachers can only message students' });
    }

    const res = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, booking_id, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, receiver_id, booking_id || null, String(content).trim()]
    );
    return reply.code(201).send(res.rows[0]);
  });

  // GET /api/messages/conversations
  app.get('/conversations', { onRequest: [app.authenticate] }, async (req) => {
    const res = await pool.query(`
      SELECT DISTINCT ON (partner_id)
        partner_id,
        partner_name,
        partner_photo,
        last_message,
        last_message_at,
        unread_count
      FROM (
        SELECT
          CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END AS partner_id,
          CASE WHEN m.sender_id = $1 THEN ru.name       ELSE su.name       END AS partner_name,
          CASE WHEN m.sender_id = $1 THEN rtp.photo_url ELSE stp.photo_url END AS partner_photo,
          m.content       AS last_message,
          m.created_at    AS last_message_at,
          COUNT(*) FILTER (WHERE m.receiver_id=$1 AND m.read_at IS NULL)
            OVER (PARTITION BY
              CASE WHEN m.sender_id=$1 THEN m.receiver_id ELSE m.sender_id END
            ) AS unread_count
        FROM messages m
        JOIN users su ON m.sender_id   = su.id
        JOIN users ru ON m.receiver_id = ru.id
        LEFT JOIN teacher_profiles stp ON su.id = stp.user_id
        LEFT JOIN teacher_profiles rtp ON ru.id = rtp.user_id
        WHERE m.sender_id=$1 OR m.receiver_id=$1
        ORDER BY m.created_at DESC
      ) sub
      ORDER BY partner_id, last_message_at DESC
    `, [req.user.id]);
    return res.rows;
  });

  // GET /api/messages/conversation/:other_user_id
  app.get('/conversation/:other_user_id', { onRequest: [app.authenticate] }, async (req) => {
    const otherId = Number(req.params.other_user_id);
    await pool.query(
      `UPDATE messages SET read_at=NOW()
       WHERE sender_id=$1 AND receiver_id=$2 AND read_at IS NULL`,
      [otherId, req.user.id]
    );
    const res = await pool.query(
      `SELECT m.*, u.name AS sender_name
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE (m.sender_id=$1 AND m.receiver_id=$2)
          OR (m.sender_id=$2 AND m.receiver_id=$1)
       ORDER BY m.created_at ASC`,
      [req.user.id, otherId]
    );
    return res.rows;
  });

  // GET /api/messages/unread-count
  app.get('/unread-count', { onRequest: [app.authenticate] }, async (req) => {
    const res = await pool.query(
      `SELECT COUNT(*) AS count FROM messages WHERE receiver_id=$1 AND read_at IS NULL`,
      [req.user.id]
    );
    return { count: parseInt(res.rows[0].count) };
  });
};
