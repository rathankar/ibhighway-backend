const nodemailer = (() => {
  try { return require('nodemailer'); }
  catch { return null; }
})();

let transporter = null;
let transporterError = null;

function getTransporter() {
  if (transporter || transporterError) return transporter;
  if (!nodemailer) {
    transporterError = 'nodemailer not installed';
    return null;
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    transporterError = 'SMTP env vars not configured';
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    console.log('\n[Email - not sent, SMTP not configured]');
    console.log('    to:      ' + to);
    console.log('    subject: ' + subject);
    console.log('    reason:  ' + transporterError + '\n');
    return { ok: true, logged: true };
  }
  try {
    const from = process.env.SMTP_FROM || ('IBHighway <' + process.env.SMTP_USER + '>');
    const info = await t.sendMail({ from, to, subject, text, html });
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error('email send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function notifyAdminNewLead(lead) {
  const to = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  if (!to) return Promise.resolve({ ok: true, skipped: true });
  const subject = 'New IBHighway lead: ' + lead.parent_name + ' (' + lead.student_name + ')';
  const text = [
    'A parent has submitted a new registration interest.',
    '',
    'Parent name     : ' + lead.parent_name,
    'Student name    : ' + lead.student_name,
    'Email           : ' + lead.email,
    'Primary phone   : ' + lead.phone_primary,
    'Secondary phone : ' + (lead.phone_secondary || '-'),
    'Country         : ' + (lead.country || '-'),
    'Timezone        : ' + (lead.timezone || '-'),
    'IB class        : ' + (lead.ib_class || '-'),
    'Preferred times : ' + (lead.preferred_timings || '-'),
    'Message         : ' + (lead.message || '-'),
    '',
    'Review and approve this lead in the admin dashboard.',
  ].join('\n');
  return sendMail({ to, subject, text });
}

function sendRegistrationLinkToParent({ email, parent_name, student_name, link }) {
  const subject = 'Welcome to IBHighway - complete ' + student_name + "'s registration";
  const text = [
    'Hello ' + parent_name + ',',
    '',
    'Thank you for getting in touch. We\'re ready to welcome ' + student_name + ' to IBHighway.',
    '',
    'Please complete the registration by clicking the link below:',
    '',
    '    ' + link,
    '',
    'This link is single-use and expires in 7 days.',
    '',
    'After registering, you\'ll be able to pick a teacher, choose a time slot, and pay',
    'to confirm the first session.',
    '',
    'If you have any questions, just reply to this email.',
    '',
    'Warm regards,',
    'Dr. N. Rathankar',
    'IBHighway',
  ].join('\n');
  const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222;line-height:1.55">' +
    '<h2 style="color:#1a1a1a;margin:0 0 16px">Welcome to IBHighway</h2>' +
    '<p>Hello ' + escapeHtml(parent_name) + ',</p>' +
    '<p>Thank you for getting in touch. We\'re ready to welcome <strong>' + escapeHtml(student_name) + '</strong> to IBHighway.</p>' +
    '<p>Please complete the registration by clicking the button below:</p>' +
    '<p style="margin:24px 0"><a href="' + link + '" style="background:#c9a84c;color:#1a1a1a;padding:12px 22px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block">Complete registration</a></p>' +
    '<p style="font-size:13px;color:#555">Or paste this link into your browser:<br/><span style="word-break:break-all">' + link + '</span></p>' +
    '<p style="font-size:13px;color:#555">This link is single-use and expires in 7 days.</p>' +
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0"/>' +
    '<p style="font-size:13px;color:#555">Warm regards,<br/>Dr. N. Rathankar<br/>IBHighway</p>' +
    '</div>';
  return sendMail({ to: email, subject, text, html });
}

function sendBookingConfirmation({ to, studentName, teacherName, slotStart, meetLink }) {
  const when = new Date(slotStart).toLocaleString('en-IN', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
  const subject = 'IBHighway session confirmed - ' + when;
  const text = [
    'Hello ' + studentName + ',',
    '',
    'Your session with ' + teacherName + ' is confirmed.',
    '',
    'When: ' + when + ' (IST)',
    'Where: ' + (meetLink || '(Meet link will follow before the session)'),
    '',
    'See you in class!',
    'IBHighway',
  ].join('\n');
  return sendMail({ to, subject, text });
}

function notifyAdminNewTeacherApplication(app) {
  const to = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  if (!to) return Promise.resolve({ ok: true, skipped: true });
  const subject = 'New teacher application: ' + app.name + ' (' + (app.subjects || []).join(', ') + ')';
  const text = [
    'A teacher has submitted an application and paid the registration fee.',
    '',
    'Name              : ' + app.name,
    'Email             : ' + app.email,
    'Phone             : ' + app.phone,
    'Institution       : ' + (app.institution || '-'),
    'Subjects          : ' + (app.subjects || []).join(', '),
    'Levels            : ' + (app.levels || []).join(', '),
    'Years experience  : ' + app.years_experience,
    'Hourly rate       : Rs.' + app.hourly_rate,
    '',
    'Teaching statement:',
    app.teaching_statement,
    '',
    'ID card (Drive)   : ' + app.id_card_drive_link,
    'Teaching proof    : ' + app.proof_drive_link,
    'Sample video      : ' + app.gdrive_video_link,
    '',
    'Review and approve in the admin dashboard, Applications tab.',
  ].join('\n');
  return sendMail({ to, subject, text });
}

function sendTeacherApprovalEmail({ email: to, name, appBase, tempPassword }) {
  const loginLink = (appBase || 'https://ibhighway.com').replace(/\/$/, '') + '/login';
  const subject = 'Your IBHighway teacher profile is live!';
  const text = [
    'Hello ' + name + ',',
    '',
    'Great news - your IBHighway teacher application has been approved!',
    '',
    'Your profile is now publicly visible on the IBHighway teacher directory.',
    'Students can discover you, view your sample video, and send you messages.',
    '',
    'Sign in to your account here:',
    '    ' + loginLink,
    '',
    'Your login email is this address (' + to + ').',
    tempPassword ? ('Your temporary password is: ' + tempPassword) : '',
    '',
    'If you have any questions, just reply to this email.',
    '',
    'Warm regards,',
    'Dr. N. Rathankar',
    'IBHighway',
  ].filter(l => l !== undefined).join('\n');
  return sendMail({ to, subject, text });
}

function sendTeacherTermsLink({ to, name, termsUrl }) {
  const subject = 'Action required: Accept IBHighway Teacher Terms';
  const text = [
    'Hello ' + name + ',',
    '',
    'Your IBHighway teacher account has been approved!',
    '',
    'Before your profile goes live, please read and accept the IBHighway Teacher Terms.',
    'Click the link below — it is valid for 7 days:',
    '',
    '    ' + termsUrl,
    '',
    'Once you accept, you can log in to your Teacher Dashboard and start accepting students.',
    '',
    'If you did not apply to IBHighway, please ignore this email.',
    '',
    'Warm regards,',
    'Dr. N. Rathankar',
    'IBHighway',
  ].join('\n');
  return sendMail({ to, subject, text });
}

function sendTeacherRejectionEmail({ email: to, name, notes }) {
  const subject = 'IBHighway - Application update';
  const text = [
    'Hello ' + name + ',',
    '',
    'Thank you for applying to list on IBHighway.',
    '',
    'After reviewing your application, we are unable to approve it at this time.',
    notes ? ('Reason: ' + notes) : '',
    '',
    'If you believe this is an error or have additional credentials to share,',
    'please reply to this email and we will review again.',
    '',
    'Warm regards,',
    'Dr. N. Rathankar',
    'IBHighway',
  ].join('\n');
  return sendMail({ to, subject, text });
}

module.exports = {
  sendMail,
  notifyAdminNewLead,
  notifyAdminNewTeacherApplication,
  sendRegistrationLinkToParent,
  sendBookingConfirmation,
  sendTeacherApprovalEmail,
  sendTeacherRejectionEmail,
  sendTeacherTermsLink,
};
