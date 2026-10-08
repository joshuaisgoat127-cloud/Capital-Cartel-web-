const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const { Server } = require('socket.io');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadOrCreateConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  const vapid = webpush.generateVAPIDKeys();
  const config = {
    jwtSecret: crypto.randomBytes(48).toString('hex'),
    vapidPublicKey: vapid.publicKey,
    vapidPrivateKey: vapid.privateKey,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

function loadOrCreateStore() {
  if (fs.existsSync(STORE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []
    };
  }
  const store = { users: [], trades: [], subscriptions: [] };
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  return store;
}

const config = loadOrCreateConfig();
const store = loadOrCreateStore();
let writeQueue = Promise.resolve();

function persistStore() {
  writeQueue = writeQueue.then(() => fs.promises.writeFile(STORE_FILE, JSON.stringify(store, null, 2)));
  return writeQueue;
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt || null
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"]
    }
  }
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/auth', authLimiter);

const COOKIE_NAME = 'cc_token';
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '7d' });
}
function setAuthCookie(res, user) {
  res.cookie(COOKIE_NAME, signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}
function authFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return store.users.find((u) => u.id === payload.sub) || null;
  } catch {
    return null;
  }
}
function requireAuth(req, res, next) {
  const user = authFromToken(req.cookies[COOKIE_NAME]);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (user.status !== 'approved') return res.status(403).json({ error: 'Account is not approved', status: user.status });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@capitalcartel.local',
  config.vapidPublicKey,
  config.vapidPrivateKey
);

async function sendTradePush(trade) {
  const approvedIds = new Set(store.users.filter((u) => u.status === 'approved').map((u) => u.id));
  const payload = JSON.stringify({
    title: `Capital Cartel • ${trade.direction} ${trade.symbol}`,
    body: `Entry ${trade.entry}${trade.takeProfit ? ` • TP ${trade.takeProfit}` : ''}${trade.stopLoss ? ` • SL ${trade.stopLoss}` : ''}`,
    url: '/dashboard.html'
  });

  const stale = [];
  await Promise.all(store.subscriptions.map(async (row) => {
    if (!approvedIds.has(row.userId)) return;
    try {
      await webpush.sendNotification(row.subscription, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) stale.push(row.id);
    }
  }));
  if (stale.length) {
    store.subscriptions = store.subscriptions.filter((s) => !stale.includes(s.id));
    await persistStore();
  }
}

app.get('/api/setup/status', (req, res) => {
  res.json({ needsAdmin: !store.users.some((u) => u.role === 'admin') });
});

app.post('/api/setup/admin', async (req, res) => {
  if (store.users.some((u) => u.role === 'admin')) return res.status(409).json({ error: 'Admin already exists' });
  const name = String(req.body.name || '').trim();
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = {
    id: uid('usr'), name, email,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'admin', status: 'approved',
    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString()
  };
  store.users.push(user);
  await persistStore();
  setAuthCookie(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/signup', async (req, res) => {
  if (!store.users.some((u) => u.role === 'admin')) return res.status(503).json({ error: 'App owner must complete setup first' });
  const name = String(req.body.name || '').trim();
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (store.users.some((u) => u.email === email)) return res.status(409).json({ error: 'An account with that email already exists' });

  const user = {
    id: uid('usr'), name, email,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'member', status: 'pending',
    createdAt: new Date().toISOString(), approvedAt: null
  };
  store.users.push(user);
  await persistStore();
  io.to('admins').emit('membership:new', publicUser(user));
  res.status(201).json({ message: 'Request submitted', status: 'pending' });
});

app.post('/api/auth/login', async (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = store.users.find((u) => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  if (user.status !== 'approved') {
    return res.status(403).json({ error: user.status === 'declined' ? 'Your access request was declined' : 'Your account is waiting for admin approval', status: user.status });
  }
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = authFromToken(req.cookies[COOKIE_NAME]);
  if (!user || user.status !== 'approved') return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: publicUser(user) });
});

app.get('/api/trades', requireAuth, (req, res) => {
  const trades = [...store.trades].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ trades });
});

app.post('/api/trades', requireAdmin, async (req, res) => {
  const symbol = String(req.body.symbol || '').trim().toUpperCase();
  const direction = String(req.body.direction || '').trim().toUpperCase();
  const entry = String(req.body.entry || '').trim();
  const stopLoss = String(req.body.stopLoss || '').trim();
  const takeProfit = String(req.body.takeProfit || '').trim();
  const setup = String(req.body.setup || '').trim();
  const riskNote = String(req.body.riskNote || '').trim();

  if (!symbol || symbol.length > 20) return res.status(400).json({ error: 'Enter a valid symbol' });
  if (!['BUY', 'SELL'].includes(direction)) return res.status(400).json({ error: 'Direction must be BUY or SELL' });
  if (!entry) return res.status(400).json({ error: 'Enter an entry price or zone' });

  const trade = {
    id: uid('trd'), symbol, direction, entry, stopLoss, takeProfit,
    setup, riskNote, status: 'LIVE',
    createdAt: new Date().toISOString(), closedAt: null,
    postedBy: req.user.id
  };
  store.trades.push(trade);
  await persistStore();
  io.to('members').emit('trade:new', trade);
  sendTradePush(trade).catch(() => {});
  res.status(201).json({ trade });
});

app.patch('/api/trades/:id', requireAdmin, async (req, res) => {
  const trade = store.trades.find((t) => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  const allowedStatuses = ['LIVE', 'WIN', 'LOSS', 'BE', 'CLOSED'];
  if (req.body.status && allowedStatuses.includes(String(req.body.status).toUpperCase())) {
    trade.status = String(req.body.status).toUpperCase();
    trade.closedAt = trade.status === 'LIVE' ? null : new Date().toISOString();
  }
  ['entry', 'stopLoss', 'takeProfit', 'setup', 'riskNote'].forEach((key) => {
    if (req.body[key] !== undefined) trade[key] = String(req.body[key]).trim();
  });
  await persistStore();
  io.to('members').emit('trade:update', trade);
  res.json({ trade });
});

app.delete('/api/trades/:id', requireAdmin, async (req, res) => {
  const idx = store.trades.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Trade not found' });
  const [removed] = store.trades.splice(idx, 1);
  await persistStore();
  io.to('members').emit('trade:delete', { id: removed.id });
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = store.users.filter((u) => u.role !== 'admin').map(publicUser).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ users });
});

app.patch('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const status = String(req.body.status || '').toLowerCase();
  if (!['approved', 'declined', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const user = store.users.find((u) => u.id === req.params.id && u.role !== 'admin');
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.status = status;
  user.approvedAt = status === 'approved' ? new Date().toISOString() : null;
  if (status !== 'approved') {
    store.subscriptions = store.subscriptions.filter((s) => s.userId !== user.id);
  }
  await persistStore();
  io.to(`user:${user.id}`).emit('membership:status', { status });
  res.json({ user: publicUser(user) });
});

app.get('/api/push/public-key', requireAuth, (req, res) => {
  res.json({ publicKey: config.vapidPublicKey });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const subscription = req.body.subscription;
  if (!subscription || !subscription.endpoint || !subscription.keys) return res.status(400).json({ error: 'Invalid push subscription' });
  store.subscriptions = store.subscriptions.filter((s) => s.subscription.endpoint !== subscription.endpoint);
  store.subscriptions.push({ id: uid('sub'), userId: req.user.id, subscription, createdAt: new Date().toISOString() });
  await persistStore();
  res.status(201).json({ ok: true });
});

app.delete('/api/push/subscribe', requireAuth, async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  store.subscriptions = store.subscriptions.filter((s) => !(s.userId === req.user.id && s.subscription.endpoint === endpoint));
  await persistStore();
  res.json({ ok: true });
});

io.use((socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    const user = authFromToken(cookies[COOKIE_NAME]);
    if (!user || user.status !== 'approved') return next(new Error('Unauthorized'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});
io.on('connection', (socket) => {
  socket.join('members');
  socket.join(`user:${socket.user.id}`);
  if (socket.user.role === 'admin') socket.join('admins');
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`Capital Cartel running at http://localhost:${PORT}`);
  if (!store.users.some((u) => u.role === 'admin')) {
    console.log(`First-time setup: http://localhost:${PORT}/setup.html`);
  }
});
