// ── ElevenLabs + Twilio outbound calling ─────────────────────
// Called when one side of a session hasn't joined after 10 minutes.
// Uses ElevenLabs Conversational AI agent to make a phone call via Twilio.

const pool = require('./db');

function isConfigured() {
  // ── DISABLED FOR TESTING — re-enable by removing the next line ──
  return false;
  // return (
  //   process.env.ELEVENLABS_API_KEY &&
  //   process.env.ELEVENLABS_AGENT_ID &&
  //   process.env.TWILIO_ACCOUNT_SID &&
  //   process.env.TWILIO_AUTH_TOKEN &&
  //   process.env.TWILIO_PHONE_NUMBER &&
  //   process.env.ELEVENLABS_API_KEY !== 'sandbox_mode' &&
  //   process.env.ELEVENLABS_AGENT_ID !== 'sandbox_mode'
  // );
}

// Initiate an outbound call via ElevenLabs Conversational AI + Twilio.
async function callUser({ phoneNumber, userName, role, sessionTime }) {
  if (!isConfigured()) {
    console.log(`📞 [SANDBOX] Would call ${role} ${userName} at ${phoneNumber} — ElevenLabs/Twilio not configured`);
    return { ok: true, mock: true };
  }

  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;

  try {
    // ElevenLabs Conversational AI outbound call via Twilio SIP
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/agents/${agentId}/outbound-call`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID || undefined,
          to_number: phoneNumber,
          // Dynamic variables the agent can reference in its script
          dynamic_variables: {
            user_name:    userName,
            user_role:    role,
            session_time: sessionTime,
          },
        }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      console.error('ElevenLabs call failed:', data);
      return { ok: false, error: data };
    }
    return { ok: true, call_id: data.call_id };
  } catch (err) {
    console.error('ElevenLabs call error:', err.message);
    return { ok: false, error: err.message };
  }
}

// Called by the session route 10 minutes after session start.
// Checks who hasn't joined and calls them once.
async function handleSessionNoShow(bookingId) {
  try {
    // Get booking details
    const bRes = await pool.query(`
      SELECT b.id, b.slot_start, b.student_id, b.teacher_id,
             s.name AS student_name, s.phone AS student_phone,
             t.name AS teacher_name, t.phone AS teacher_phone
      FROM bookings b
      JOIN users s ON b.student_id = s.id
      JOIN users t ON b.teacher_id = t.id
      WHERE b.id = $1 AND b.status = 'confirmed'
    `, [bookingId]);

    const booking = bRes.rows[0];
    if (!booking) return; // Booking cancelled or not confirmed — skip

    // Check who has joined
    const presenceRes = await pool.query(
      'SELECT user_id FROM session_presence WHERE booking_id=$1',
      [bookingId]
    );
    const joinedIds = new Set(presenceRes.rows.map(r => r.user_id));

    const sessionTime = new Date(booking.slot_start).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
    });

    const callPromises = [];

    if (!joinedIds.has(booking.student_id) && booking.student_phone) {
      console.log(`📞 Calling absent student: ${booking.student_name}`);
      callPromises.push(
        callUser({
          phoneNumber: booking.student_phone,
          userName:    booking.student_name,
          role:        'student',
          sessionTime,
        }).then(result => {
          if (result.ok) {
            // Mark AI call triggered so we don't call again
            pool.query(
              `UPDATE session_presence SET ai_call_triggered=TRUE
               WHERE booking_id=$1 AND user_id=$2`,
              [bookingId, booking.student_id]
            ).catch(() => {});
          }
        })
      );
    }

    if (!joinedIds.has(booking.teacher_id) && booking.teacher_phone) {
      console.log(`📞 Calling absent teacher: ${booking.teacher_name}`);
      callPromises.push(
        callUser({
          phoneNumber: booking.teacher_phone,
          userName:    booking.teacher_name,
          role:        'teacher',
          sessionTime,
        })
      );
    }

    if (callPromises.length === 0) {
      console.log(`✅ Booking #${bookingId}: both sides joined — no calls needed`);
    }

    await Promise.allSettled(callPromises);
  } catch (err) {
    console.error(`handleSessionNoShow error for booking ${bookingId}:`, err.message);
  }
}

module.exports = { callUser, handleSessionNoShow, isConfigured };
