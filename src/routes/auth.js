const bcrypt = require("bcryptjs");
const pool   = require("../db");

module.exports = async function authRoutes(app) {

  const authLimit = {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute",
      },
    },
  };

  // POST /api/auth/register  (token-gated, for parent/student invites)
  app.post("/register", authLimit, async (req, reply) => {
    const { name, password, phone, registration_token } = req.body || {};

    if (!name || !password || !registration_token)
      return reply.code(400).send({ error: "name, password, and registration_token are required" });
    if (password.length < 6)
      return reply.code(400).send({ error: "Password must be at least 6 characters" });

    const tRes = await pool.query(
      `SELECT rt.id, rt.email, rt.used_at, rt.expires_at, rt.lead_id
       FROM registration_tokens rt
       WHERE rt.token = $1`,
      [registration_token]
    );
    const tok = tRes.rows[0];
    if (!tok) return reply.code(400).send({ error: "Invalid registration link." });
    if (tok.used_at) return reply.code(410).send({ error: "This registration link has already been used." });
    if (new Date(tok.expires_at) < new Date()) return reply.code(410).send({ error: "This registration link has expired." });

    const email = tok.email;
    const hash  = await bcrypt.hash(password, 10);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const uRes = await client.query(
        `INSERT INTO users (name, email, password_hash, role, phone)
         VALUES ($1,$2,$3,'student',$4)
         RETURNING id, name, email, role`,
        [name, email, hash, phone || null]
      );
      const user = uRes.rows[0];

      await client.query("UPDATE registration_tokens SET used_at=NOW() WHERE id=$1", [tok.id]);
      await client.query("UPDATE leads SET status='registered', updated_at=NOW() WHERE id=$1", [tok.lead_id]);

      await client.query("COMMIT");

      const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
      return reply.code(201).send({ token, user });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err.code === "23505")
        return reply.code(409).send({ error: "An account with this email already exists." });
      req.log.error({ err }, "registration failed");
      return reply.code(500).send({ error: "Could not create your account. Please try again." });
    } finally {
      client.release();
    }
  });

  // POST /api/auth/student-register  (open self-registration)
  app.post("/student-register", authLimit, async (req, reply) => {
    const { name, email, password, phone, how_to_call, preferred_call_time, subjects_interested } = req.body || {};

    if (!name || !email || !password)
      return reply.code(400).send({ error: "name, email, and password are required" });
    if (password.length < 6)
      return reply.code(400).send({ error: "Password must be at least 6 characters" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return reply.code(400).send({ error: "Please provide a valid email address" });

    const hash = await bcrypt.hash(password, 10);
    try {
      const subjectsArr = (subjects_interested && subjects_interested.length)
        ? subjects_interested
        : null;

      const uRes = await pool.query(
        `INSERT INTO users
           (name, email, password_hash, role, phone, how_to_call, preferred_call_time, subjects_interested)
         VALUES ($1,$2,$3,'student',$4,$5,$6,$7::text[])
         RETURNING id, name, email, role`,
        [
          name.trim(),
          email.trim().toLowerCase(),
          hash,
          phone ? phone.trim() : null,
          how_to_call ? how_to_call.trim() : null,
          preferred_call_time || null,
          subjectsArr,
        ]
      );
      const user = uRes.rows[0];
      const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
      return reply.code(201).send({ token, user });
    } catch (err) {
      if (err.code === "23505")
        return reply.code(409).send({ error: "An account with this email already exists." });
      req.log.error({ err, pg_message: err.message, pg_detail: err.detail, pg_code: err.code }, "student registration failed");
      return reply.code(500).send({ error: err.message || "Could not create your account. Please try again." });
    }
  });

  // POST /api/auth/login
  app.post("/login", authLimit, async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password)
      return reply.code(400).send({ error: "email and password are required" });

    const res = await pool.query("SELECT * FROM users WHERE email=$1", [email.trim().toLowerCase()]);
    const user = res.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return reply.code(401).send({ error: "Invalid email or password" });

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone } };
  });

  // GET /api/auth/me
  app.get("/me", { onRequest: [app.authenticate] }, async (req) => {
    const res = await pool.query(
      "SELECT id, name, email, role, phone, photo_url FROM users WHERE id=$1",
      [req.user.id]
    );
    return res.rows[0] || null;
  });
};
