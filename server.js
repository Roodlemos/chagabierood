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
  },
}));

// ── Persistência de compras (JSON file) ───────────────────────
const isVercelEnv = process.env.VERCEL === '1' || process.env.VERCEL;
const DATA_DIR  = isVercelEnv ? '/tmp' : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'purchases.json');
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');

if (!isVercelEnv) {
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  if (!fs.existsSync(GUESTS_FILE)) fs.writeFileSync(GUESTS_FILE, '[]', 'utf8');
}

const loadPurchases = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
};

const savePurchases = (list) => {
  if (isVercelEnv && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
};

const loadGuests = () => {
  try { return JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8')); }
  catch { return []; }
};

const saveGuests = (list) => {
  if (isVercelEnv && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GUESTS_FILE, JSON.stringify(list, null, 2), 'utf8');
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

// ── POST /api/criar-preferencia ───────────────────────────────
app.post('/api/criar-preferencia', async (req, res) => {
  try {
    const { itemNome, itemValor, guestName, mensagem } = req.body;

    // Validação
    if (!itemNome || String(itemNome).trim() === '')
      return res.status(400).json({ error: "O campo 'itemNome' é obrigatório." });
    if (!itemValor || isNaN(Number(itemValor)) || Number(itemValor) < 1)
      return res.status(400).json({ error: 'O valor deve ser maior que R$ 1,00.' });
    if (!guestName || String(guestName).trim() === '')
      return res.status(400).json({ error: "O campo 'Seu Nome' é obrigatório." });

    const valor            = parseFloat(Number(itemValor).toFixed(2));
    const nomeItem         = String(itemNome).trim();
    const nomePresenteador = String(guestName).trim();
    const msgCarinho       = (mensagem || '').trim();
    const extRef           = `cha-panela-${Date.now()}-${nomePresenteador.replace(/\s+/g, '_').toLowerCase()}`;
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
app.post('/api/rsvp', (req, res) => {
  const { name, phone, guestsCount, isAttending, notes } = req.body;
  if (!name || String(name).trim() === '') return res.status(400).json({ error: 'Nome é obrigatório.' });

  const guests = loadGuests();
  guests.push({
    id: `rsvp-${Date.now()}`,
    name: String(name).trim(),
    phone: phone ? String(phone).trim() : '',
    guestsCount: Number(guestsCount) || 0,
    isAttending: isAttending === true || isAttending === 'true',
    notes: notes ? String(notes).trim() : '',
    createdAt: new Date().toISOString()
  });

  saveGuests(guests);
  res.json({ ok: true, message: 'Confirmação enviada com sucesso!' });
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
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER     || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'cha2026';

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin   = true;
    req.session.loginTime = new Date().toISOString();
    return res.redirect('/admin/dashboard');
  }

  console.warn(`[Admin] Tentativa de login inválida: user="${username}"`);
  res.redirect('/admin/login?error=1');
});

// GET /admin/dashboard — painel protegido
app.get('/admin/dashboard', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
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

// PATCH /admin/api/purchases/:id/status — atualiza status manualmente
app.patch('/admin/api/purchases/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const allowed = ['approved', 'pending', 'rejected', 'cancelled'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: 'Status inválido.' });

  const purchases = loadPurchases();
  const idx = purchases.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Registro não encontrado.' });

  purchases[idx].status    = status;
  purchases[idx].updatedAt = new Date().toISOString();
  savePurchases(purchases);
  res.json(purchases[idx]);
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
