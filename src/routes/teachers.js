const pool = require('../db');

// Compute badge level from completed session count
function computeBadge(completedSessions) {
  if (completedSessions >= 150) return 'legend';
  if (completedSessions >= 75)  return 'elite';
  if (completedSessions >= 30)  return 'pro';
  if (completedSessions >= 10)  return 'rising_star';
  return 'verified';
}

// Recompute and persist badge for a teacher (call after every booking completion)
async function refreshTeacherBadge(teacherId) {
  try {
    const res = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM bookings WHERE teacher_id=$1 AND status='completed'",
      [teacherId]
    );
    const badge = computeBadge(res.rows[0]?.cnt || 0);
    await pool.query('UPDATE teacher_profiles SET badge=$1 WHERE user_id=$2', [badge, teacherId]);
    return badge;
  } catch (err) {
    console.error('refreshTeacherBadge error:', err.message);
  }
}

module.exports = async function teacherRoutes(app) {

  // GET /api/teachers  — list all teachers with profiles
  app.get('/', async () => {
    const res = await pool.query(`
      SELECT u.id, u.name, u.email, u.phone,
             tp.bio, tp.subjects, tp.hourly_rate, tp.meet_link,
             tp.badge
      FROM users u
      JOIN teacher_profiles tp ON u.id = tp.user_id
      WHERE u.role = 'teacher'
      ORDER BY u.name
    `);
    return res.rows;
  });

  // GET /api/teachers/:id/availability
  app.get('/:id/availability', async (req) => {
    const res = await pool.query(
      'SELECT * FROM availability WHERE teacher_id=$1 ORDER BY day_of_week, start_time',
      [req.params.id]
    );
    return res.rows;
  });

  // GET /api/teachers/profile — teacher gets their own profile (including meet_link)
  app.get('/profile', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'teacher')
      return reply.code(403).send({ error: 'Teachers only' });
    const res = await pool.query(
      'SELECT * FROM teacher_profiles WHERE user_id=$1',
      [req.user.id]
    );
    return res.rows[0] || {};
  });

  // PUT /api/teachers/profile  — teacher updates their own profile
  app.put('/profile', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'teacher')
      return reply.code(403).send({ error: 'Teachers only' });

    const { bio, subjects, hourly_rate, meet_link } = req.body;
    await pool.query(
      'UPDATE teacher_profiles SET bio=$1, subjects=$2, hourly_rate=$3, meet_link=$4 WHERE user_id=$5',
      [bio, subjects, hourly_rate, meet_link || null, req.user.id]
    );
    return { success: true };
  });

  // POST /api/teachers/availability  — teacher sets weekly availability
  app.post('/availability', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.user.role !== 'teacher')
      return reply.code(403).send({ error: 'Teachers only' });

    const { slots } = req.body;
    await pool.query('DELETE FROM availability WHERE teacher_id=$1', [req.user.id]);

    for (const s of slots) {
      await pool.query(
        'INSERT INTO availability (teacher_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)',
        [req.user.id, s.day_of_week, s.start_time, s.end_time]
      );
    }
    return { success: true, count: slots.length };
  });
};

module.exports.refreshTeacherBadge = refreshTeacherBadge;
