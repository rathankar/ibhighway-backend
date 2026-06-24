// ── Deadline Reminder Cron — Email via Resend ─────────────────────────────────
// Runs daily at 09:00 AM IST (03:30 UTC).
// Finds milestones due in 7 days or 1 day, not completed, sends email reminder.
//
// Env vars required:
//   RESEND_API_KEY  — from resend.com dashboard
// ─────────────────────────────────────────────────────────────────────────────
const cron   = require('node-cron');
const pool   = require('./db');
const { Resend } = (() => { try { return require('resend'); } catch { return {}; } })();

const EMAIL_ENABLED = !!(process.env.RESEND_API_KEY && Resend);

// ── Helpers ───────────────────────────────────────────────────────────────────
function friendlyDate(dateStr) {
  return new Date(dateStr + 'T00:00:00')
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildEmailHtml(studentName, milestoneTitle, subject, dueDateStr, assessType, daysLeft) {
  const due      = friendlyDate(dueDateStr);
  const urgency  = daysLeft === 1 ? '🚨 Due Tomorrow' : '⏰ Due in 7 Days';
  const typeLabel = assessType === 'ia' ? 'IA' : assessType === 'ee' ? 'Extended Essay' : 'TOK';
  return `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">
      <div style="background:#0f172a;border-radius:12px;padding:20px 24px;margin-bottom:16px">
        <div style="font-size:1.1rem;font-weight:800;color:#fff">IB<span style="color:#60a5fa">Highway</span></div>
        <div style="color:#94a3b8;font-size:.8rem;margin-top:2px">Deadline Reminder</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
        <div style="font-size:.95rem;font-weight:700;color:#0f172a;margin-bottom:6px">${urgency}</div>
        <div style="font-size:1.3rem;font-weight:800;color:#2563eb;margin-bottom:4px">${milestoneTitle}</div>
        <div style="color:#64748b;font-size:.88rem;margin-bottom:16px">
          ${subject} ${typeLabel} &nbsp;·&nbsp; Due <strong>${due}</strong>
        </div>
        <a href="https://ibhighway.com/tools/deadline/index.html"
           style="display:inline-block;padding:10px 22px;background:linear-gradient(135deg,#0d9488,#ea580c);
                  color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:.88rem">
          Open Deadline Calendar →
        </a>
      </div>
      <div style="color:#94a3b8;font-size:.72rem;margin-top:16px;text-align:center">
        IBHighway · <a href="https://ibhighway.com" style="color:#94a3b8">ibhighway.com</a>
        · To stop reminders, remove this assessment from your Deadline Calendar.
      </div>
    </div>`;
}

// ── Core reminder function ────────────────────────────────────────────────────
async function sendDeadlineReminders() {
  if (!EMAIL_ENABLED) {
    console.log('[DeadlineCron] RESEND_API_KEY not set — skipping email reminders.');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  // Find milestones due in exactly 7 or 1 day, not completed, not already reminded
  const { rows } = await pool.query(`
    SELECT
      m.id              AS milestone_id,
      m.title           AS milestone_title,
      m.due_date,
      (m.due_date - CURRENT_DATE)::int AS days_left,
      d.assessment_type,
      d.subject,
      u.name            AS student_name,
      u.email           AS student_email
    FROM deadline_milestones m
    JOIN student_deadlines d ON m.deadline_id = d.id
    JOIN users u             ON d.student_id  = u.id
    WHERE
      (m.due_date - CURRENT_DATE) IN (7, 1)
      AND m.is_completed    = FALSE
      AND m.reminder_called = FALSE
      AND d.is_active       = TRUE
      AND u.email IS NOT NULL
      AND u.email != ''
  `);

  console.log(`[DeadlineCron] Found ${rows.length} milestone(s) to remind.`);

  for (const row of rows) {
    try {
      const daysLeft  = row.days_left;
      const urgency   = daysLeft === 1 ? '🚨 Due Tomorrow' : '⏰ Due in 7 Days';
      const emailSubj = `${urgency}: ${row.milestone_title} — ${row.subject}`;

      await resend.emails.send({
        from:    'IBHighway <reminders@ibhighway.com>',
        to:      row.student_email,
        subject: emailSubj,
        html:    buildEmailHtml(
          row.student_name, row.milestone_title,
          row.subject, row.due_date, row.assessment_type, daysLeft
        ),
      });

      // Mark as reminded so we don't double-send
      await pool.query(
        `UPDATE deadline_milestones SET reminder_called=TRUE, reminder_called_at=NOW() WHERE id=$1`,
        [row.milestone_id]
      );

      console.log(`[DeadlineCron] Email sent → ${row.student_email} (${row.milestone_title}, ${daysLeft}d)`);
    } catch (err) {
      console.error(`[DeadlineCron] Failed for ${row.student_email}:`, err.message);
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
