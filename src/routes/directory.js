const pool = require('../db');

// Public teacher directory -- no authentication required.
// Never returns teacher contact details (phone, email).

module.exports = async function directoryRoutes(app) {

  // GET /api/directory/teachers
  // Optional query params: ?subject=IB+Physics+HL&keyword=mechanics&level=HL
  app.get('/teachers', async (req) => {
    const { subject, keyword, level } = req.query || {};

    let where = [`tp.is_public = TRUE`, `u.role = 'teacher'`];
    const params = [];

    if (subject) {
      params.push(`%${subject}%`);
      where.push(`EXISTS (
        SELECT 1 FROM unnest(tp.subjects) s WHERE s ILIKE $${params.length}
      )`);
    }
    if (level) {
      params.push(`%${level}%`);
      where.push(`EXISTS (
        SELECT 1 FROM unnest(tp.subjects) s WHERE s ILIKE $${params.length}
      )`);
    }
    if (keyword) {
      params.push(`%${keyword}%`);
      where.push(`(
        u.name ILIKE $${params.length} OR
        tp.bio ILIKE $${params.length} OR
        tp.teaching_statement ILIKE $${params.length} OR
        EXISTS (SELECT 1 FROM unnest(tp.subjects) s WHERE s ILIKE $${params.length})
      )`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const res = await pool.query(`
      SELECT
        u.id,
        u.name,
        tp.photo_url,
        tp.subjects,
        tp.years_experience,
        tp.hourly_rate,
        tp.bio,
        tp.teaching_statement,
        tp.institution,
        tp.youtube_video_url,
        tp.ia_guidance,
        tp.ia_fee,
        tp.ee_guidance,
        tp.ee_fee,
        tp.tok_guidance,
        tp.tok_fee
      FROM users u
      JOIN teacher_profiles tp ON u.id = tp.user_id
      ${whereClause}
      ORDER BY tp.years_experience DESC, u.name
    `, params);

    return res.rows;
  });

  // GET /api/directory/teachers/:id
  // Single teacher public profile. Never reveals phone or email.
  app.get('/teachers/:id', async (req, reply) => {
    const res = await pool.query(`
      SELECT
        u.id,
        u.id AS user_id,
        u.name,
        tp.photo_url,
        tp.subjects,
        tp.years_experience,
        tp.hourly_rate,
        tp.bio,
        tp.teaching_statement,
        tp.institution,
        tp.youtube_video_url,
        tp.ia_guidance,
        tp.ia_fee,
        tp.ee_guidance,
        tp.ee_fee,
        tp.tok_guidance,
        tp.tok_fee
      FROM users u
      JOIN teacher_profiles tp ON u.id = tp.user_id
      WHERE u.id = $1
        AND u.role = 'teacher'
        AND tp.is_public = TRUE
    `, [req.params.id]);

    if (!res.rows[0]) return reply.code(404).send({ error: 'Teacher not found' });
    return res.rows[0];
  });

  // GET /api/directory/subjects
  // Returns grouped IB subject catalogue for search/filter UI.
  app.get('/subjects', async () => {
    const res = await pool.query(
      'SELECT id, group_name, subject, level, display_label FROM ib_subjects ORDER BY group_name, subject, level'
    );
    const grouped = {};
    for (const row of res.rows) {
      if (!grouped[row.group_name]) grouped[row.group_name] = [];
      grouped[row.group_name].push(row.display_label);
    }
    return grouped;
  });
};
