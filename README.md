# 🌿 Chá de Panela — Gabriela & Rodolfo

Landing page de lista de presentes para chá de panela com integração direta ao **Mercado Pago** (Pix + Cartão de Crédito/Débito).

---

## 📁 Estrutura do Projeto

```
cha-de-panela/
├── public/
│   └── index.html          # Frontend completo (Tailwind CSS + JS vanilla)
├── server.js               # Backend Node.js + Express + Mercado Pago SDK
├── package.json
├── .env                    # Variáveis locais (não commitar!)
├── .env.example            # Modelo das variáveis de ambiente
├── .gitignore
└── README.md
```

---

## 🚀 Como rodar localmente

### 1. Pré-requisitos

- **Node.js** >= 18.0.0
- Conta no [Mercado Pago Developers](https://www.mercadopago.com.br/developers)

### 2. Instalar dependências

```bash
npm install
```

### 3. Configurar variáveis de ambiente

```bash
# Copie o arquivo de exemplo
cp .env.example .env

# Edite o .env com suas credenciais reais
```

Abra o `.env` e preencha:

```env
MERCADO_PAGO_ACCESS_TOKEN=TEST-SEU_TOKEN_AQUI
PORT=3000
BASE_URL=http://localhost:3000
```

> 🔑 Obtenha seu Access Token em: [mercadopago.com.br/developers/panel](https://www.mercadopago.com.br/developers/panel)  
> Use credenciais de **TESTE** para desenvolvimento local.

### 4. Iniciar o servidor

```bash
npm start
# ou para desenvolvimento com hot-reload:
npm run dev
```

Acesse: **[http://localhost:3000](http://localhost:3000)**

---

## 💳 Integração Mercado Pago

### Como funciona o fluxo

```
Usuário clica em "Presentear"
        ↓
Modal com nome + mensagem
        ↓
POST /api/criar-preferencia  (backend)
        ↓
Mercado Pago retorna preferenceId + checkoutUrl
        ↓
Usuário é redirecionado para o Checkout do MP
        ↓
Pagamento com Pix / Cartão / outros métodos
        ↓
Mercado Pago redireciona de volta para /sucesso ou /falha
        ↓
Webhook POST /api/webhook confirma o pagamento
```

### Rotas do Backend

| Método | Rota                    | Descrição                                        |
|--------|-------------------------|--------------------------------------------------|
| `GET`  | `/`                     | Serve a landing page                             |
| `POST` | `/api/criar-preferencia`| Gera preference no Mercado Pago                  |
| `POST` | `/api/webhook`          | Recebe notificações de status de pagamento       |
| `GET`  | `/sucesso`              | Retorno pós-pagamento aprovado                   |
| `GET`  | `/falha`                | Retorno pós-pagamento recusado                   |
| `GET`  | `/pendente`             | Retorno pós-pagamento pendente                   |

### Body do POST `/api/criar-preferencia`

```json
{
  "itemNome": "Jogo de Panelas Premium",
  "itemValor": 350.00,
  "guestName": "Maria Silva",
  "mensagem": "Felicidades para vocês! 💚"
}
```

### Resposta de sucesso

```json
{
  "preferenceId": "1234567890-abc-def",
  "checkoutUrl": "https://www.mercadopago.com.br/checkout/v1/redirect?...",
  "sandboxUrl":  "https://sandbox.mercadopago.com.br/checkout/v1/redirect?..."
}
```

---

## 🌐 Deploy em Produção

### Configuração necessária para produção

1. **Altere no `.env`:**
   ```env
   MERCADO_PAGO_ACCESS_TOKEN=APP_USR-SEU_TOKEN_PRODUCAO
   BASE_URL=https://seudominio.com.br
   ```

2. **No `server.js`**, troque `sandboxUrl` por `checkoutUrl` na resposta do frontend (`index.html`, linha que define `checkoutUrl`):
   ```js
   // Em produção, use:
   const checkoutUrl = data.checkoutUrl;
   ```

3. **Webhooks**: Configure o `BASE_URL` para a URL pública do seu servidor. O Mercado Pago precisa acessar `/api/webhook` externamente.

### Para testes locais com webhook (usando ngrok)

```bash
# Instale ngrok e execute:
ngrok http 3000

# Copie a URL gerada (ex: https://abc123.ngrok.io) e coloque no .env:
BASE_URL=https://abc123.ngrok.io
```

### Opções de deploy gratuito/low-cost

| Plataforma  | Free Tier | Ideal para             |
|-------------|-----------|------------------------|
| **Railway** | ✅ Sim    | Node.js — Recomendado  |
| **Render**  | ✅ Sim    | Deploy automático via Git |
| **Fly.io**  | ✅ Sim    | Alta performance       |

---

## 🎨 Personalização

### Trocar os presentes da lista

Edite o array `PRESENTES` no `<script>` do `public/index.html`:

```js
const PRESENTES = [
  {
    id: 'panelas',
    nome: 'Jogo de Panelas Premium',
    descricao: 'Descrição do item...',
    valor: 350.00,
    emoji: '🍳',
    cor: 'from-emerald-50 to-teal-50',
    borda: 'border-emerald-200',
  },
  // ... adicione mais itens
];
```

### Trocar data e local do evento

No `.env`:
```env
EVENT_DATE=14 de Setembro de 2025
EVENT_LOCATION=Salão de Festas Vila Verde — São Paulo/SP
```

Ou diretamente no HTML dentro das tags com `id="event-date"` e `id="event-location"`.

---

## 🔮 Próximos Passos (roadmap sugerido)

- [ ] **Banco de dados** — Salvar pagamentos e mensagens (SQLite via `better-sqlite3` ou Supabase)
- [ ] **Painel admin** — Visualizar quem presenteou e as mensagens
- [ ] **E-mail** — Enviar confirmação automática ao casal via `nodemailer`
- [ ] **Controle de estoque** — Marcar presentes como "já presenteado"
- [ ] **Pix transparente** — Integração direta com Pix sem redirecionar para o checkout externo

---

## 🛠️ Stack

| Camada    | Tecnologia                                |
|-----------|-------------------------------------------|
| Backend   | Node.js 18+ · Express 4                   |
| Frontend  | HTML5 · Tailwind CSS (CDN) · JS Vanilla   |
| Pagamento | Mercado Pago SDK v2 (`mercadopago`)        |
| Fontes    | Google Fonts (Inter + Playfair Display)   |
# chagabierood
