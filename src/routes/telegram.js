const crypto   = require('crypto');
const pool     = require('../db');
const telegram = require('../telegram');

module.exports = async function telegramRoutes(app) {

  // ── POST /api/telegram/webhook ───────────────────────────────
  // Receives updates from Telegram when running in production webhook mode.
  app.post('/webhook', async (req, reply) => {
    const bot = telegram.getBot();
    if (bot) {
      bot.processUpdate(req.body);
    }
    return reply.code(200).send({ ok: true });
  });

  // ── POST /api/telegram/link ───────────────────────────────────
  // Authenticated user requests a one-time link token.
  // They then open the bot with /start <token> to complete linking.
  app.post('/link', { onRequest: [app.authenticate] }, async (req, reply) => {
    const token = crypto.randomBytes(16).toString('hex');

    // Check if telegram_link_token column exists; add if not (migration safety)
    await pool.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_token VARCHAR(64)`
    );

    await pool.query(
      `UPDATE users SET telegram_link_token=$1 WHERE id=$2`,
      [token, req.user.id]
    );

    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'ibhighway_bot';
    const deepLink    = `https://t.me/${botUsername}?start=${token}`;

    return { ok: true, link: deepLink, token };
  });

  // ── GET /api/telegram/status ──────────────────────────────────
  // Check if the current user has linked their Telegram.
  app.get('/status', { onRequest: [app.authenticate] }, async (req) => {
    const res = await pool.query(
      `SELECT telegram_chat_id, telegram_username, linked_at
       FROM telegram_links WHERE user_id=$1`,
      [req.user.id]
    );
    if (!res.rows[0]) return { linked: false };
    return {
      linked: true,
      telegram_username: res.rows[0].telegram_username,
      linked_at: res.rows[0].linked_at,
    };
  });

  // ── DELETE /api/telegram/unlink ───────────────────────────────
  app.delete('/unlink', { onRequest: [app.authenticate] }, async (req) => {
    await pool.query('DELETE FROM telegram_links WHERE user_id=$1', [req.user.id]);
    return { ok: true };
  });
};
