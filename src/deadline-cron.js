// ── Twilio Deadline Reminder Cron ─────────────────────────────────────────────
// Runs daily at 09:00 AM IST (03:30 UTC).
// Finds milestones due in exactly 3 days that are not completed and have not
// already been called. Makes a Twilio TTS voice call to the student's registered
// mobile number, then sends a WhatsApp follow-up message.
//
// Env vars required:
//   TWILIO_ACCOUNT_SID   — from your Twilio console dashboard
//   TWILIO_AUTH_TOKEN    — from your Twilio console dashboard
//   TWILIO_FROM_NUMBER   — your purchased US number, e.g. +19786482829
// ─────────────────────────────────────────────────────────────────────────────
const cron = require('node-cron');
const twilio = require('twilio');
const pool  = require('./db');

// ── TWILIO DISABLED FOR TESTING — re-enable by removing the next line ──
const CALL_ENABLED = false;
// const CALL_ENABLED =
//   process.env.TWILIO_ACCOUNT_SID &&
//   process.env.TWILIO_AUTH_TOKEN  &&
//   process.env.TWILIO_FROM_NUMBER;

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ── Format a date as "15th March 2025" for the TTS message ──────────────────
function friendlyDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Normalise phone to E.164 (+91XXXXXXXXXX) ─────────────────────────────────
function toE164India(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) return '+' + digits;
  if (digits.length === 10) return '+91' + digits;
  if (raw.startsWith('+'))  return raw; // already E.164
  return null;
}

// ── Build the TwiML voice script ─────────────────────────────────────────────
function buildTwiml(studentName, milestoneTitle, subjectLabel, dueDateStr, assessType) {
  const due  = friendlyDate(dueDateStr);
  const type = assessType === 'ia' ? 'I A' : assessType === 'ee' ? 'Extended Essay' : 'T O K Essay';
  // Pause after greeting for natural feel. Alice en-IN gives Indian English accent.
  return `<Response>
  <Say voice="alice" language="en-IN">
    Hello, ${studentName}.
    <break time="0.4s"/>
    This is a reminder from I B Highway.
    <break time="0.3s"/>
    Your milestone, ${milestoneTitle}, for your ${subjectLabel} ${type}
    is due in 3 days, on ${due}.
    <break time="0.5s"/>
    Please log in to I B Highway to check your progress and mark it complete once done.
    <break time="0.4s"/>
    Good luck with your studies. Goodbye!
  </Say>
</Response>`;
}

// ── Build the WhatsApp pre-warning message (sent before the call) ────────────
function buildWhatsAppMessage(studentName, milestoneTitle, subjectLabel, dueDateStr, assessType) {
  const due  = friendlyDate(dueDateStr);
  const type = assessType === 'ia' ? 'IA' : assessType === 'ee' ? 'Extended Essay' : 'TOK Essay';
  return (
    `📅 *IBHighway Deadline Reminder*\n\n` +
    `Hi ${studentName}! Your milestone *"${milestoneTitle}"* for your ` +
    `*${subjectLabel} ${type}* is due in *3 days* (${due}).\n\n` +
    `Log in to check your progress: https://ibhighway.com/deadlines\n\n` +
    `_You will receive a brief reminder call in the next few minutes from our US number. Please pick up!_`
  );
}

// ── Core reminder function ────────────────────────────────────────────────────
async function sendDeadlineReminders() {
  if (!CALL_ENABLED) {
    console.log('[DeadlineCron] Twilio not configured — skipping reminder calls.');
    return;
  }

  const client = getTwilioClient();
  const from   = process.env.TWILIO_FROM_NUMBER;

  // Find milestones due in 3 days, not completed, consent given, not already called
  const { rows } = await pool.query(`
    SELECT
      m.id            AS milestone_id,
      m.title         AS milestone_title,
      m.due_date,
      d.assessment_type,
      d.subject,
      u.name          AS student_name,
      u.phone         AS student_phone
    FROM deadline_milestones m
    JOIN student_deadlines d ON m.deadline_id = d.id
    JOIN users u             ON d.student_id  = u.id
    WHERE
      m.due_date      = (CURRENT_DATE + INTERVAL '3 days')::date
      AND m.is_completed     = FALSE
      AND m.reminder_called  = FALSE
      AND d.is_active        = TRUE
      AND u.call_consent     = TRUE
      AND u.phone IS NOT NULL
  `);

  console.log(`[DeadlineCron] Found ${rows.length} milestone(s) to remind.`);

  for (const row of rows) {
    const phone = toE164India(row.student_phone);
    if (!phone) {
      console.warn(`[DeadlineCron] Invalid phone for student "${row.student_name}" — skipping.`);
      continue;
    }

    try {
      // Step 1 — Send WhatsApp pre-warning (so they know to expect the call)
      const waMessage = buildWhatsAppMessage(
        row.student_name, row.milestone_title,
        row.subject, row.due_date, row.assessment_type
      );
      await client.messages.create({
        from: `whatsapp:${from}`,
        to:   `whatsapp:${phone}`,
        body: waMessage,
      });
      console.log(`[DeadlineCron] WhatsApp sent to ${row.student_name} (${phone})`);

      // Step 2 — Wait 5 minutes, then make the voice call
      // (setTimeout is fire-and-forget inside the loop — intentional)
      setTimeout(async () => {
        try {
          const twiml = buildTwiml(
            row.student_name, row.milestone_title,
            row.subject, row.due_date, row.assessment_type
          );
          const call = await client.calls.create({
            twiml,
            to:   phone,
            from,
          });
          console.log(`[DeadlineCron] Call initiated — SID: ${call.sid} — ${row.student_name} (${phone})`);
        } catch (callErr) {
          console.error(`[DeadlineCron] Voice call failed for ${row.student_name}:`, callErr.message);
        }
      }, 5 * 60 * 1000); // 5 minutes after WhatsApp message

      // Step 3 — Mark milestone as reminded (prevents double-call if cron re-runs)
      await pool.query(
        `UPDATE deadline_milestones
         SET reminder_called=TRUE, reminder_called_at=NOW()
         WHERE id=$1`,
        [row.milestone_id]
      );

    } catch (err) {
      console.error(`[DeadlineCron] Error processing ${row.student_name}:`, err.message);
      // Don't throw — continue with next student
    }
  }
}

// ── Week 3 Re-engagement: WhatsApp nudge to students ─────────────────────────
// Finds students whose ONLY booking was exactly 21 days ago with no follow-up.
// Sends a friendly WhatsApp nudge encouraging them to rebook.
async function sendReEngagementNudges() {
  if (!CALL_ENABLED) {
    console.log('[ReEngageCron] Twilio not configured — skipping re-engagement nudges.');
    return;
  }

  const { rows } = await pool.query(`
    SELECT
      u.id AS student_id,
      u.name,
      u.phone,
      COUNT(b.id)::int AS booking_count,
      MAX(b.created_at) AS last_booking_at
    FROM users u
    JOIN bookings b ON b.student_id = u.id
    WHERE u.role = 'student'
      AND u.phone IS NOT NULL
    GROUP BY u.id, u.name, u.phone
    HAVING
      COUNT(b.id) = 1
      AND DATE_TRUNC('day', MAX(b.created_at)) = (CURRENT_DATE - INTERVAL '21 days')::date
  `);

  console.log(`[ReEngageCron] Found ${rows.length} student(s) to nudge.`);

  const client = getTwilioClient();
  const from   = process.env.TWILIO_FROM_NUMBER;

  for (const row of rows) {
    const phone = toE164India(row.phone);
    if (!phone) continue;

    const message =
      `👋 Hi ${row.name}!\n\n` +
      `It's been 3 weeks since your first IBHighway session — how did it go? 🎓\n\n` +
      `Your next session is just a click away. Book with your teacher again and keep the momentum going!\n\n` +
      `📚 Every booking earns you a coin — 500 coins = ₹10,000 reward.\n\n` +
      `👉 Book now: https://ibhighway.com/student/book`;

    try {
      await client.messages.create({
        from: `whatsapp:${from}`,
        to:   `whatsapp:${phone}`,
        body: message,
      });
      console.log(`[ReEngageCron] Nudge sent to ${row.name} (${phone})`);
    } catch (err) {
      console.error(`[ReEngageCron] Failed for ${row.name}:`, err.message);
    }
  }
}

// ── Schedule: 09:00 AM IST daily = 03:30 UTC ─────────────────────────────────
// Cron format: second(optional) minute hour day month weekday
function startDeadlineCron() {
  cron.schedule('30 3 * * *', async () => {
    console.log('[DeadlineCron] Running daily reminder job...');
    try {
      await sendDeadlineReminders();
    } catch (err) {
      console.error('[DeadlineCron] Job failed:', err.message);
    }
  }, {
    timezone: 'UTC',
  });

  // Re-engagement nudge runs daily at 10:00 AM IST (04:30 UTC) — slightly after deadline cron
  cron.schedule('30 4 * * *', async () => {
    console.log('[ReEngageCron] Running Week 3 re-engagement job...');
    try {
      await sendReEngagementNudges();
    } catch (err) {
      console.error('[ReEngageCron] Job failed:', err.message);
    }
  }, {
    timezone: 'UTC',
  });

  console.log('[DeadlineCron] Scheduled — daily at 09:00 AM IST (03:30 UTC)');
  console.log('[ReEngageCron] Scheduled — daily at 10:00 AM IST (04:30 UTC)');
}

module.exports = { startDeadlineCron, sendDeadlineReminders, sendReEngagementNudges };
