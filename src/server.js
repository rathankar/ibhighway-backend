require('dotenv').config();
const Fastify = require('fastify');
const pool = require('./db');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD  = NODE_ENV === 'production';

const PLACEHOLDER_SECRETS = new Set([
  'change_this_to_a_long_random_string_before_production',
  'ibhighway_dev_secret_change_in_prod',
  '',
  undefined,
]);

if (IS_PROD && PLACEHOLDER_SECRETS.has(process.env.JWT_SECRET)) {
  console.error(
    '\n[X]  JWT_SECRET is missing or set to the default placeholder.\n' +
    '    Generate a real one with:\n' +
    "        node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n" +
    '    and set it as the JWT_SECRET environment variable before starting in production.\n'
  );
  process.exit(1);
}

if (IS_PROD && !process.env.DATABASE_URL) {
  console.error('\n[X]  DATABASE_URL is not set. Aborting.\n');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'ibhighway_dev_secret_change_in_prod';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
  trustProxy: IS_PROD,
});

app.register(require('@fastify/helmet'), {
  contentSecurityPolicy: false,
});

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.register(require('@fastify/cors'), {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (corsOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed by CORS`), false);
  },
  credentials: true,
});

app.register(require('@fastify/rate-limit'), {
  global: false,
});

app.register(require('@fastify/jwt'), {
  secret: JWT_SECRET,
  sign: { expiresIn: '7d' },
});

app.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized - please log in' });
  }
});

// Routes
app.register(require('./routes/auth'),             { prefix: '/api/auth' });
app.register(require('./routes/teachers'),         { prefix: '/api/teachers' });
app.register(require('./routes/bookings'),         { prefix: '/api/bookings' });
app.register(require('./routes/payments'),         { prefix: '/api/payments' });
app.register(require('./routes/leads'),            { prefix: '/api/leads' });
app.register(require('./routes/admin'),            { prefix: '/api/admin' });
app.register(require('./routes/teacher-apply'),    { prefix: '/api/teacher-apply' });
app.register(require('./routes/directory'),        { prefix: '/api/directory' });
app.register(require('./routes/subscriptions'),    { prefix: '/api/subscriptions' });
app.register(require('./routes/messages'),         { prefix: '/api/messages' });
app.register(require('./routes/sessions'),         { prefix: '/api/sessions' });
app.register(require('./routes/telegram'),         { prefix: '/api/telegram' });
app.register(require('./routes/credits'),          { prefix: '/api/credits' });
app.register(require('./routes/coins'),            { prefix: '/api/coins' });
app.register(require('./routes/guidance-bookings'),{ prefix: '/api/guidance-bookings' });
app.register(require('./routes/deadlines'),        { prefix: '/api/deadlines' });
app.register(require('./routes/ia-autopsy'),       { prefix: '/api/ia-autopsy' });
app.register(require('./routes/ia-diary'),         { prefix: '/api' });
app.register(require('./routes/ee-diary'),         { prefix: '/api' });
app.register(require('./routes/tok-diary'),        { prefix: '/api' });
app.register(require('./routes/research-to-lab'),  { prefix: '/api' });
app.register(require('./routes/mentor'),           { prefix: '/api' });
app.register(require('./routes/ee-compass'),       { prefix: '/api/ee-compass' });
app.register(require('./routes/fbd-log'),          { prefix: '/api/fbd-log' });
app.register(require('./routes/tool-log'),         { prefix: '/api/tool-log' });
app.register(require('./routes/teacher-terms'),    { prefix: '/api/teacher-terms' });
app.register(require('./routes/tools-auth'),       { prefix: '/api' });

app.get('/api/health', async () => ({
  status: 'ok',
  mode: IS_PROD ? 'production' : 'sandbox',
  time: new Date(),
}));

app.get('/api/test-deadline-cron', async (req, reply) => {
  const { sendDeadlineReminders } = require('./deadline-cron');
  await sendDeadlineReminders();
  return { ok: true, message: 'Cron ran - check Railway logs and your inbox' };
});

app.get('/api/routes', async () => {
  return { routes: app.printRoutes() };
});

app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, 'request failed');
  if (reply.sent) return;
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  const msg = status < 500 ? (err.message || 'Request failed') : 'Internal Server Error';
  reply.code(status).send({ error: msg });
});

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  console.log('\nIBHighway backend started on ' + HOST + ':' + PORT + '  (' + NODE_ENV + ')');
  console.log('Health check -> http://' + HOST + ':' + PORT + '/api/health');
  console.log('CORS origins -> ' + corsOrigins.join(', ') + '\n');

  const telegram = require('./telegram');
  telegram.getBot();
  if (IS_PROD && process.env.APP_BASE_URL) {
    telegram.setWebhook(process.env.APP_BASE_URL);
  }

  const { startDeadlineCron } = require('./deadline-cron');
  startDeadlineCron();
});

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
