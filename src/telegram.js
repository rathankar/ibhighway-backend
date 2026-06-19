// ── Telegram Bot Integration ──────────────────────────────────
// Two-way notifications between IBHighway and users via Telegram.
// Uses node-telegram-bot-api (polling or webhook mode).
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN — from BotFather
//
// What this bot does:
//   • Sends session reminders (1 hour before)
//   • Sends booking confirmations
//   • Sends no-show alerts
//   • Receives user replies (rescheduling requests etc.)
//     and forwards them as messages in the platform

const pool = require('./db');

let bot = null;

function getBot() {
  if (bot) return bot;
  if (!process.env.TELEGRAM_BOT_TOKEN ||
      process.env.TELEGRAM_BOT_TOKEN === 'sandbox_mode') {
    return null;
  }
  try {
    const TelegramBot = require('node-telegram-bot-api');
    // Use polling in development, webhook in production
    const useWebhook = process.env.NODE_ENV === 'production' &&
                       process.env.APP_BASE_URL;
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
      polling: !useWebhook,
    });

    // Handle incoming messages from users
    bot.on('message', handleIncomingMessage);
    bot.on('polling_error', err => console.error('Telegram polling error:', err.message));

    console.log('✅ Telegram bot started');
  } catch (err) {
    console.warn('Telegram bot not available:', err.message);
    return null;
  }
  return bot;
}

// Set webhook URL (called on server start in production)
async function setWebhook(baseUrl) {
  const b = getBot();
  if (!b || process.env.NODE_ENV !== 'production') return;
  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
  try {
    await b.setWebHook(webhookUrl);
    console.log('✅ Telegram webhook set:', webhookUrl);
  } catch (err) {
    console.warn('Could not set Telegram webhook:', err.message);
  }
}

// ── Incoming message handler ──────────────────────────────────
async function handleIncomingMessage(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();

  // Find linked user
  const linkRes = await pool.query(
    'SELECT user_id FROM telegram_links WHERE telegram_chat_id=$1',
    [chatId]
  );

  // /start command — initiate linking
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    const linkToken = parts[1]; // /start <token>

    if (linkToken) {
      await linkAccount(chatId, linkToken, msg.from?.username);
    } else {
      await sendMessage(chatId,
        `👋 Welcome to IBHighway!\n\n` +
        `To link your account, go to your IBHighway dashboard → ` +
        `Settings → Link Telegram, and follow the instructions there.`
      );
    }
    return;
  }

  if (!linkRes.rows[0]) {
    await sendMessage(chatId,
      `Your Telegram is not linked to an IBHighway account yet.\n` +
      `Go to your IBHighway dashboard → Settings → Link Telegram.`
    );
    return;
  }

  const userId = linkRes.rows[0].user_id;

  // Forward the text as an in-platform message to admin
  // (For now, user messages go to admin; in future can route to specific teacher/student)
  try {
    const adminRes = await pool.query(
      `SELECT id FROM users WHERE role='admin' LIMIT 1`
    );
    if (adminRes.rows[0]) {
      await pool.query(
        `INSERT INTO messages (sender_id, receiver_id, content)
         VALUES ($1,$2,$3)`,
        [userId, adminRes.rows[0].id, `[Via Telegram] ${text}`]
      );
    }
    await sendMessage(chatId, `✅ Your message has been received. We'll get back to you shortly.`);
  } catch (err) {
    console.error('Error forwarding Telegram message:', err.message);
  }
}

// ── Account linking ───────────────────────────────────────────
async function linkAccount(chatId, token, telegramUsername) {
  try {
    // Token is stored temporarily in a simple cache or DB
    // We look it up against users who initiated linking
    const res = await pool.query(
      `SELECT id, name FROM users WHERE telegram_link_token=$1`,
      [token]
    );
    const user = res.rows[0];
    if (!user) {
      await sendMessage(chatId, `❌ Invalid or expired link token. Please generate a new one from your dashboard.`);
      return;
    }

    // Create the link
    await pool.query(
      `INSERT INTO telegram_links (user_id, telegram_chat_id, telegram_username)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE
         SET telegram_chat_id=$2, telegram_username=$3, linked_at=NOW()`,
      [user.id, chatId, telegramUsername || null]
    );

    // Clear the token
    await pool.query(
      `UPDATE users SET telegram_link_token=NULL WHERE id=$1`,
      [user.id]
    );

    await sendMessage(chatId,
      `✅ Successfully linked!\n\n` +
      `Hello ${user.name}! You'll now receive session reminders and notifications here.\n\n` +
      `You can also message us here if you have any questions.`
    );
  } catch (err) {
    console.error('Telegram link error:', err.message);
    await sendMessage(chatId, `Something went wrong. Please try again.`);
  }
}

// ── Outbound notification helpers ─────────────────────────────

async function sendMessage(chatId, text) {
  const b = getBot();
  if (!b) {
    console.log(`📱 [TELEGRAM SANDBOX] → ${chatId}: ${text}`);
    return;
  }
  try {
    await b.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.warn('Telegram sendMessage failed:', err.message);
  }
}

async function notifyUser(userId, text) {
  const res = await pool.query(
    'SELECT telegram_chat_id FROM telegram_links WHERE user_id=$1',
    [userId]
  );
  if (!res.rows[0]) return; // User hasn't linked Telegram
  await sendMessage(res.rows[0].telegram_chat_id, text);
}

// Booking confirmation notification
async function notifyBookingConfirmed(bookingId) {
  const res = await pool.query(`
    SELECT b.slot_start, b.meet_link,
           s.id AS student_id, s.name AS student_name,
           t.id AS teacher_id, t.name AS teacher_name
    FROM bookings b
    JOIN users s ON b.student_id = s.id
    JOIN users t ON b.teacher_id = t.id
    WHERE b.id = $1
  `, [bookingId]);
  const b = res.rows[0];
  if (!b) return;

  const when = new Date(b.slot_start).toLocaleString('en-IN', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });

  await Promise.allSettled([
    notifyUser(b.student_id,
      `✅ <b>Session Confirmed!</b>\n\n` +
      `📅 ${when} IST\n` +
      `👨‍🏫 Teacher: ${b.teacher_name}\n` +
      `🔗 Meet: ${b.meet_link || 'Link will be sent before session'}`
    ),
    notifyUser(b.teacher_id,
      `✅ <b>New Session Booked!</b>\n\n` +
      `📅 ${when} IST\n` +
      `🧑‍🎓 Student: ${b.student_name}\n` +
      `🔗 Meet: ${b.meet_link || 'Link will be sent before session'}`
    ),
  ]);
}

// Session reminder (call this 1 hour before session start)
async function sendSessionReminder(bookingId) {
  const res = await pool.query(`
    SELECT b.slot_start, b.meet_link,
           s.id AS student_id, s.name AS student_name,
           t.id AS teacher_id, t.name AS teacher_name
    FROM bookings b
    JOIN users s ON b.student_id = s.id
    JOIN users t ON b.teacher_id = t.id
    WHERE b.id = $1 AND b.status='confirmed'
  `, [bookingId]);
  const b = res.rows[0];
  if (!b) return;

  const when = new Date(b.slot_start).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });

  await Promise.allSettled([
    notifyUser(b.student_id,
      `⏰ <b>Session in 1 hour!</b>\n\n` +
      `🕐 Starts at ${when} IST\n` +
      `👨‍🏫 Teacher: ${b.teacher_name}\n` +
      `🔗 ${b.meet_link || 'Check your dashboard for the Meet link'}\n\n` +
      `Open IBHighway and press <b>Join Session</b> when it's time.`
    ),
    notifyUser(b.teacher_id,
      `⏰ <b>Session in 1 hour!</b>\n\n` +
      `🕐 Starts at ${when} IST\n` +
      `🧑‍🎓 Student: ${b.student_name}\n` +
      `🔗 ${b.meet_link || 'Check your dashboard for the Meet link'}`
    ),
  ]);
}

// No-show alert
async function notifyNoShow(bookingId, absentUserId) {
  const res = await pool.query(
    'SELECT name FROM users WHERE id=$1', [absentUserId]
  );
  const name = res.rows[0]?.name || 'A participant';
  await notifyUser(absentUserId,
    `📞 <b>Your session has started!</b>\n\n` +
    `${name}, your IBHighway session began 10 minutes ago.\n` +
    `Please join now via the IBHighway app.\n\n` +
    `We are also trying to reach you by phone.`
  );
}

module.exports = {
  getBot,
  setWebhook,
  sendMessage,
  notifyUser,
  notifyBookingConfirmed,
  sendSessionReminder,
  notifyNoShow,
};
