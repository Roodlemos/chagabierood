// ================================================================
// server.js — Chá de Panela: Gabriela & Rodolfo
// Backend: Node.js + Express + Mercado Pago SDK v2
// Admin: painel protegido por sessão + persistência em JSON
// ================================================================
require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { body, validationResult } = require('express-validator');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

// ── Mercado Pago ─────────────────────────────────────────────
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN || '',
  options: { timeout: 5000 },
});
const preferenceClient = new Preference(mpClient);
const paymentClient    = new Payment(mpClient);

// ── Express ───────────────────────────────────────────────────
const app      = express();
const PORT     = process.env.PORT     || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Segurança: Headers (Helmet) ───────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // Desativado para permitir assets externos (como Tailwind CDN e fontes do Google)
}));

// ── Segurança: Rate Limiting ──────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Limite de 100 requisições por IP
  message: { error: "Muitas requisições, tente novamente mais tarde." }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Limite de 5 tentativas de login por IP
  message: "Muitas tentativas de login, tente novamente em 15 minutos."
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Sessão ───────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'cha-panela-secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    maxAge:   1000 * 60 * 60 * 8,  // 8 horas
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' // true se estiver em produção (HTTPS)
  },
}));

// ── Persistência (SQLite) ─────────────────────────────────────────
const Database = require('better-sqlite3');
const isVercelEnv = process.env.VERCEL === '1' || process.env.VERCEL;
const DATA_DIR  = isVercelEnv ? '/tmp' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'database.sqlite');
const db = new Database(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, cat TEXT, emoji TEXT, nome TEXT, desc TEXT, valor REAL, fav INTEGER);
  CREATE TABLE IF NOT EXISTS guests (id TEXT PRIMARY KEY, name TEXT, companions TEXT, guestsCount INTEGER, createdAt TEXT);
  CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, payerName TEXT, giftId TEXT, giftName TEXT, valor REAL, pixCode TEXT, status TEXT, createdAt TEXT);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, nome TEXT, mensagem TEXT, color TEXT, createdAt TEXT);
`);

const DEFAULT_GIFTS = [
  { id:'panelas', cat:'cozinha', emoji:'🍳', nome:'Jogo de Panelas Antiaderente', desc:'5 peças premium com tampa de vidro, compatível com indução e fogão a gás.', valor:80, fav:false },
  { id:'batedeira', cat:'eletros', emoji:'🍰', nome:'Batedeira Planetária 750W', desc:'12 velocidades, tigela inox 4,5L. Acessórios gancho, batedor e globo.', valor:85, fav:true },
  { id:'jantar', cat:'mesa', emoji:'🍽️', nome:'Aparelho de Jantar 42 Peças', desc:'Porcelana branca para 6 pessoas: pratos, xícaras e travessas.', valor:75, fav:true }
];

// Migração de JSON para SQLite
const migrateFromJSON = () => {
  const GIFTS_FILE = path.join(DATA_DIR, 'gifts.json');
  const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');
  const DATA_FILE = path.join(DATA_DIR, 'purchases.json');
  const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

  if (fs.existsSync(GIFTS_FILE)) {
    try {
      const gifts = JSON.parse(fs.readFileSync(GIFTS_FILE, 'utf8'));
      const insert = db.prepare('INSERT OR IGNORE INTO gifts (id, cat, emoji, nome, desc, valor, fav) VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.transaction((items) => {
        for (const item of items) insert.run(item.id, item.cat, item.emoji || '🎁', item.nome, item.desc || '', parseFloat(item.valor) || 0, item.fav ? 1 : 0);
      })(gifts);
      fs.renameSync(GIFTS_FILE, GIFTS_FILE + '.bak');
    } catch(e) {}
  } else {
    const count = db.prepare('SELECT count(*) as c FROM gifts').get().c;
    if (count === 0) {
      const insert = db.prepare('INSERT INTO gifts (id, cat, emoji, nome, desc, valor, fav) VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.transaction((items) => {
        for (const item of items) insert.run(item.id, item.cat, item.emoji || '🎁', item.nome, item.desc || '', parseFloat(item.valor) || 0, item.fav ? 1 : 0);
      })(DEFAULT_GIFTS);
    }
  }

  if (fs.existsSync(GUESTS_FILE)) {
    try {
      const guests = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
      const insert = db.prepare('INSERT OR IGNORE INTO guests (id, name, companions, guestsCount, createdAt) VALUES (?, ?, ?, ?, ?)');
      db.transaction((items) => {
        for (const item of items) insert.run(item.id, item.name, JSON.stringify(item.companions || []), parseInt(item.guestsCount) || 0, item.createdAt);
      })(guests);
      fs.renameSync(GUESTS_FILE, GUESTS_FILE + '.bak');
    } catch(e) {}
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      const purchases = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const insert = db.prepare('INSERT OR IGNORE INTO purchases (id, payerName, giftId, giftName, valor, pixCode, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      db.transaction((items) => {
        for (const item of items) insert.run(item.id, item.payerName, item.giftId, item.giftName, parseFloat(item.valor) || 0, item.pixCode || '', item.status || 'pending', item.createdAt);
      })(purchases);
      fs.renameSync(DATA_FILE, DATA_FILE + '.bak');
    } catch(e) {}
  }
};
migrateFromJSON();

// ── Criptografia de Dados (AES-256-CBC) ────────────────────────
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return text;
  try {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex').slice(0, 32), iv);
    let encrypted = cipher.update(String(text));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch(e) { return text; }
}

function decrypt(text) {
  if (!text || typeof text !== 'string' || !text.includes(':')) return text;
  try {
    let textParts = text.split(':');
    if (textParts[0].length !== 32) return text; // IV length check
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex').slice(0, 32), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) { return text; }
}

const notifyAdmin = () => {
  if (global.adminClients) {
    global.adminClients.forEach(client => client.write(`event: update\ndata: {}\n\n`));
  }
};

const loadPurchases = () => {
  return db.prepare('SELECT * FROM purchases').all().map(p => ({
    ...p,
    payerName: decrypt(p.payerName),
    payerEmail: p.payerEmail ? decrypt(p.payerEmail) : null,
    pixCode: p.pixCode ? decrypt(p.pixCode) : ''
  }));
};

const savePurchases = (list) => {
  const insert = db.prepare('INSERT INTO purchases (id, payerName, giftId, giftName, valor, pixCode, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction((items) => {
    db.prepare('DELETE FROM purchases').run();
    for (const item of items) {
      insert.run(
        item.id,
        encrypt(item.payerName),
        item.giftId,
        item.giftName,
        parseFloat(item.valor) || 0,
        item.pixCode ? encrypt(item.pixCode) : '',
        item.status || 'pending',
        item.createdAt
      );
    }
  })(list);
  notifyAdmin();
};

const loadGuests = () => {
  return db.prepare('SELECT * FROM guests').all().map(g => ({
    ...g,
    name: decrypt(g.name),
    companions: JSON.parse(decrypt(g.companions) || '[]')
  }));
};

const saveGuests = (list) => {
  const insert = db.prepare('INSERT INTO guests (id, name, companions, guestsCount, createdAt) VALUES (?, ?, ?, ?, ?)');
  db.transaction((items) => {
    db.prepare('DELETE FROM guests').run();
    for (const item of items) {
      insert.run(
        item.id,
        encrypt(item.name),
        encrypt(JSON.stringify(item.companions || [])),
        parseInt(item.guestsCount) || 0,
        item.createdAt
      );
    }
  })(list);
  notifyAdmin();
};

const loadGifts = () => db.prepare('SELECT * FROM gifts').all().map(g => ({...g, fav: g.fav === 1}));
const saveGifts = (list) => {
  const insert = db.prepare('INSERT INTO gifts (id, cat, emoji, nome, desc, valor, fav) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction((items) => {
    db.prepare('DELETE FROM gifts').run();
    for (const item of items) insert.run(item.id, item.cat, item.emoji || '🎁', item.nome, item.desc || '', parseFloat(item.valor) || 0, item.fav ? 1 : 0);
  })(list);
  notifyAdmin();
};

const loadMessages = () => db.prepare('SELECT * FROM messages').all();
const saveMessages = (list) => {
  const insert = db.prepare('INSERT INTO messages (id, nome, mensagem, color, createdAt) VALUES (?, ?, ?, ?, ?)');
  db.transaction((items) => {
    db.prepare('DELETE FROM messages').run();
    for (const item of items) insert.run(item.id, item.nome, item.mensagem, item.color, item.createdAt);
  })(list);
  notifyAdmin();
};

// ── Middleware de log ─────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Middleware de autenticação admin ──────────────────────────
const requireAdmin = (req, res, next) => {
  if (req.session?.isAdmin) return next();
  res.redirect('/admin/login');
};

// ================================================================
// ROTAS PÚBLICAS
// ================================================================

// GET / — Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Retornos do checkout Mercado Pago
app.get('/sucesso',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/falha',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pendente', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── GET /api/gifts ────────────────────────────────────────────
app.get('/api/gifts', (req, res) => {
  res.json(loadGifts());
});

// ── POST /api/criar-preferencia ───────────────────────────────
app.post('/api/criar-preferencia', apiLimiter, [
  body('itemNome').trim().escape().notEmpty().withMessage("O campo 'itemNome' é obrigatório."),
  body('itemValor').isFloat({ min: 1 }).withMessage("O valor deve ser maior que R$ 1,00."),
  body('guestName').trim().escape().notEmpty().withMessage("O campo 'Seu Nome' é obrigatório."),
  body('mensagem').optional().trim().escape()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { itemNome, itemValor, guestName, mensagem } = req.body;

    const valor            = parseFloat(Number(itemValor).toFixed(2));
    const nomeItem         = String(itemNome);
    const nomePresenteador = String(guestName);
    const msgCarinho       = String(mensagem || '');
    const extRef           = `cha-panela-${Date.now()}-${nomePresenteador.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
    const isLocalhost      = BASE_URL.includes('localhost') || BASE_URL.includes('127.0.0.1');

    const preferenceData = {
      items: [{
        id:          `presente-${Date.now()}`,
        title:       `Presente: ${nomeItem}`,
        description: `De ${nomePresenteador}${msgCarinho ? ` — "${msgCarinho.slice(0, 100)}"` : ''}`,
        category_id: 'home',
        quantity:    1,
        unit_price:  valor,
        currency_id: 'BRL',
      }],
      payer: { name: nomePresenteador },
      payment_methods: {
        excluded_payment_types: [],
        installments:           12,
        default_installments:   1,
      },
      back_urls: {
        success: `${BASE_URL}/sucesso?item=${encodeURIComponent(nomeItem)}&guest=${encodeURIComponent(nomePresenteador)}`,
        failure: `${BASE_URL}/falha`,
        pending: `${BASE_URL}/pendente`,
      },
      ...(isLocalhost ? {} : { auto_return: 'approved' }),
      ...(isLocalhost ? {} : { notification_url: `${BASE_URL}/api/webhook` }),
      statement_descriptor: 'CHA GABRIELA RODOLFO',
      external_reference:   extRef,
      metadata: { item_nome: nomeItem, guest_name: nomePresenteador, mensagem: msgCarinho },
    };

    const preference = await preferenceClient.create({ body: preferenceData });
    console.log('[MP] Preference criada:', preference.id);

    // ── Salva compra como pendente ────────────────────────────
    const purchases = loadPurchases();
    purchases.push({
      id:           `pref-${Date.now()}`,
      preferenceId: preference.id,
      externalRef:  extRef,
      itemNome:     nomeItem,
      guestName:    nomePresenteador,
      mensagem:     msgCarinho,
      valor,
      status:       'pending',
      paymentId:    null,
      payerEmail:   null,
      createdAt:    new Date().toISOString(),
      updatedAt:    new Date().toISOString(),
    });
    savePurchases(purchases);

    return res.status(200).json({
      preferenceId: preference.id,
      checkoutUrl:  preference.init_point,
      sandboxUrl:   preference.sandbox_init_point,
    });

  } catch (err) {
    console.error('[MP] Erro ao criar preference:', err?.message || err);
    return res.status(500).json({
      error:   'Erro ao processar o pagamento. Tente novamente.',
      details: process.env.NODE_ENV !== 'production' ? err?.message : undefined,
    });
  }
});

// ── POST /api/webhook ─────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('[Webhook]', JSON.stringify(req.body));
    res.status(200).send('OK');

    if (type === 'payment' && data?.id) {
      const payment   = await paymentClient.get({ id: data.id });
      const status    = payment.status;
      const extRef    = payment.external_reference;
      const payer     = payment.payer;
      const valorPago = payment.transaction_amount;

      console.log(`[Webhook] Pagamento ${data.id} → ${status} | Ref: ${extRef}`);

      // Atualiza no arquivo
      const purchases = loadPurchases();
      const idx = purchases.findIndex(
        p => p.externalRef === extRef || p.preferenceId === payment.preference_id
      );
      if (idx >= 0) {
        purchases[idx].status     = status;
        purchases[idx].paymentId  = String(data.id);
        purchases[idx].payerEmail = payer?.email || null;
        purchases[idx].updatedAt  = new Date().toISOString();
        savePurchases(purchases);
        console.log(`[Webhook] ✅ Compra atualizada: status=${status}`);
      } else {
        // Pagamento sem preference registrada (ex: Pix direto)
        purchases.push({
          id:           `pay-${data.id}`,
          preferenceId: payment.preference_id || null,
          externalRef:  extRef || null,
          itemNome:     payment.description || 'Presente',
          guestName:    `${payer?.first_name || ''} ${payer?.last_name || ''}`.trim() || 'Convidado',
          mensagem:     '',
          valor:        valorPago,
          status,
          paymentId:    String(data.id),
          payerEmail:   payer?.email || null,
          createdAt:    new Date().toISOString(),
          updatedAt:    new Date().toISOString(),
        });
        savePurchases(purchases);
      }
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err?.message || err);
  }
});

// ── POST /api/rsvp ────────────────────────────────────────────
app.post('/api/rsvp', apiLimiter, [
  body('name').trim().escape().notEmpty().withMessage("Nome é obrigatório."),
  body('phone').optional().trim().escape(),
  body('guestsCount').optional().isInt(),
  body('companions.*').optional().trim().escape(),
  body('notes').optional().trim().escape()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { name, phone, guestsCount, companions, isAttending, notes } = req.body;

  const guests = loadGuests();
  guests.push({
    id: `rsvp-${Date.now()}`,
    name: String(name),
    phone: String(phone || ''),
    guestsCount: Number(guestsCount) || 0,
    companions: Array.isArray(companions) ? companions : [],
    isAttending: isAttending === true || isAttending === 'true',
    notes: String(notes || ''),
    createdAt: new Date().toISOString()
  });

  saveGuests(guests);
  res.json({ ok: true, message: 'Confirmação enviada com sucesso!' });
});

// ── GET & POST /api/messages ──────────────────────────────────
app.get('/api/messages', (req, res) => {
  res.json(loadMessages());
});

app.post('/api/messages', apiLimiter, [
  body('nome').trim().escape().notEmpty().withMessage("Nome é obrigatório."),
  body('mensagem').trim().escape().notEmpty().withMessage("Mensagem é obrigatória.")
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { nome, mensagem, color } = req.body;
  const messages = loadMessages();
  
  messages.push({
    id: `msg-${Date.now()}`,
    nome: String(nome),
    mensagem: String(mensagem).substring(0, 500),
    color: color || '', 
    createdAt: new Date().toISOString()
  });

  saveMessages(messages);
  res.json({ ok: true });
});

// ================================================================
// ROTAS ADMIN (protegidas por sessão)
// ================================================================

// GET /admin → redireciona
app.get('/admin', (req, res) => {
  if (req.session?.isAdmin) return res.redirect('/admin/dashboard');
  res.redirect('/admin/login');
});

// GET /admin/login — login page
app.get('/admin/login', (req, res) => {
  if (req.session?.isAdmin) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// POST /admin/login — autenticação
app.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER     || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'cha2026';

  let match = false;
  // Se a senha na env for um hash bcrypt (começa com $2a$ ou $2b$)
  if (ADMIN_PASS.startsWith('$2a$') || ADMIN_PASS.startsWith('$2b$')) {
    match = bcrypt.compareSync(password || '', ADMIN_PASS);
  } else {
    // Backwards compatibility para senhas planas
    // Em produção real, recomende sempre gerar e salvar o hash na env
    match = (password === ADMIN_PASS);
  }

  if (username === ADMIN_USER && match) {
    req.session.isAdmin   = true;
    req.session.loginTime = new Date().toISOString();
    return res.redirect('/admin/dashboard');
  }

  console.warn(`[Admin] Tentativa de login inválida: user="${username}" | IP: ${req.ip}`);
  res.redirect('/admin/login?error=1');
});

// GET /admin/dashboard — painel protegido
app.get('/admin/dashboard', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// GET /admin/api/stream — conexão persistente (SSE) com timeout de 5 minutos
global.adminClients = [];
app.get('/admin/api/stream', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  res.write('data: {"connected": true}\n\n');
  global.adminClients.push(res);
  
  // Timeout de 5 minutos
  const timer = setTimeout(() => {
    res.end();
  }, 5 * 60 * 1000);

  req.on('close', () => {
    clearTimeout(timer);
    global.adminClients = global.adminClients.filter(c => c !== res);
  });
});

// GET /admin/api/purchases — dados JSON para o dashboard
app.get('/admin/api/purchases', requireAdmin, (req, res) => {
  const purchases = loadPurchases();
  purchases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(purchases);
});

// GET /admin/api/purchases/:id/verificar — consulta status no Mercado Pago
app.get('/admin/api/purchases/:id/verificar', requireAdmin, async (req, res) => {
  try {
    const purchases = loadPurchases();
    const idx = purchases.findIndex(p => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Registro não encontrado.' });
    
    const compra = purchases[idx];
    if (compra.status === 'approved') {
      return res.json({ message: 'Pagamento já consta como aprovado.', status: 'approved' });
    }

    // Busca no Mercado Pago pela referência externa
    let searchResult;
    if (compra.externalRef) {
      searchResult = await paymentClient.search({ options: { external_reference: compra.externalRef } });
    }
    
    const payments = searchResult?.results || [];
    const approvedPayment = payments.find(p => p.status === 'approved');

    if (approvedPayment) {
      purchases[idx].status = 'approved';
      purchases[idx].paymentId = String(approvedPayment.id);
      purchases[idx].payerEmail = approvedPayment.payer?.email || null;
      purchases[idx].updatedAt = new Date().toISOString();
      savePurchases(purchases);
      return res.json({ message: 'Pagamento recebido com sucesso!', status: 'approved' });
    } else {
      const latest = payments[0];
      const currentStatus = latest ? latest.status : compra.status;
      return res.json({ message: 'Nenhum pagamento concluído encontrado.', status: currentStatus });
    }
  } catch (err) {
    console.error('[MP] Erro ao verificar pagamento:', err?.message || err);
    res.status(500).json({ error: 'Erro ao consultar Mercado Pago.' });
  }
});

// DELETE /admin/api/purchases/:id — remove um registro (admin)
app.delete('/admin/api/purchases/:id', requireAdmin, (req, res) => {
  const purchases = loadPurchases();
  const filtered  = purchases.filter(p => p.id !== req.params.id);
  savePurchases(filtered);
  res.json({ ok: true });
});


// GET /admin/api/guests — lista de convidados para o dashboard
app.get('/admin/api/guests', requireAdmin, (req, res) => {
  const guests = loadGuests();
  guests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(guests);
});

// DELETE /admin/api/guests/:id — remove um convidado (admin)
app.delete('/admin/api/guests/:id', requireAdmin, (req, res) => {
  const guests = loadGuests();
  const filtered = guests.filter(g => g.id !== req.params.id);
  saveGuests(filtered);
  res.json({ ok: true });
});

// GET /admin/api/gifts — lista de presentes para gerenciar (pode usar o público mas deixamos separado)
app.get('/admin/api/gifts', requireAdmin, (req, res) => {
  res.json(loadGifts());
});

// POST /admin/api/gifts — adiciona um presente
app.post('/admin/api/gifts', requireAdmin, (req, res) => {
  const { cat, emoji, nome, desc, valor, fav } = req.body;
  if (!nome || !valor || !cat) return res.status(400).json({ error: 'Dados incompletos.' });

  const gifts = loadGifts();
  gifts.push({
    id: `gift-${Date.now()}`,
    cat,
    emoji: emoji || '🎁',
    nome: String(nome).trim(),
    desc: String(desc || '').trim(),
    valor: parseFloat(valor),
    fav: fav === true || fav === 'true'
  });
  saveGifts(gifts);
  res.json({ ok: true });
});

// PUT /admin/api/gifts/:id — edita um presente
app.put('/admin/api/gifts/:id', requireAdmin, (req, res) => {
  const { cat, emoji, nome, desc, valor, fav } = req.body;
  if (!nome || !valor || !cat) return res.status(400).json({ error: 'Dados incompletos.' });

  const gifts = loadGifts();
  const idx = gifts.findIndex(g => g.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Presente não encontrado.' });

  gifts[idx] = {
    ...gifts[idx],
    cat,
    emoji: emoji || '🎁',
    nome: String(nome).trim(),
    desc: String(desc || '').trim(),
    valor: parseFloat(valor),
    fav: fav === true || fav === 'true'
  };
  saveGifts(gifts);
  res.json({ ok: true });
});

// DELETE /admin/api/gifts/:id — remove um presente
app.delete('/admin/api/gifts/:id', requireAdmin, (req, res) => {
  const gifts = loadGifts();
  const filtered = gifts.filter(g => g.id !== req.params.id);
  saveGifts(filtered);
  res.json({ ok: true });
});

// GET /admin/api/messages — lista de mensagens (recados)
app.get('/admin/api/messages', requireAdmin, (req, res) => {
  res.json(loadMessages());
});

// DELETE /admin/api/messages/:id — remove uma mensagem
app.delete('/admin/api/messages/:id', requireAdmin, (req, res) => {
  const messages = loadMessages();
  const filtered = messages.filter(m => m.id !== req.params.id);
  saveMessages(filtered);
  res.json({ ok: true });
});

// POST /admin/logout
app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL;

// ----------------------------------------------------------------------
// 8. Inicialização do Servidor (Local vs Vercel)
// ----------------------------------------------------------------------
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`\n==========================================================`);
    console.log(`  🌿 Chá de Panela — Gabriela & Rodolfo`);
    console.log(`  🚀 Servidor: http://localhost:${PORT}`);
    console.log(`  🔐 Admin:    http://localhost:${PORT}/admin`);
    console.log(`  💳 MP Token: ${process.env.MERCADO_PAGO_ACCESS_TOKEN ? '✅ Configurado' : '⚠️  Não definido'}`);
    console.log(`==========================================================\n`);
  });
}

module.exports = app;
