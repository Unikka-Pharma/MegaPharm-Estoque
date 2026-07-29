# MegaPharm — Estoque

Controle de estoque com **lote / fabricação / validade** e **baixa automática idempotente** via webhook do checkout.

- **Auth**: painel admin protegido por login (JWT em cookie httpOnly).
- **Baixa idempotente**: cada pedido dá baixa **1x só**, mesmo que o webhook chegue várias vezes (dedupe por `order_id`).
- **FEFO**: consome o lote de **validade mais próxima** primeiro.
- **Baixa parcial + alerta**: se faltar saldo, baixa o que tem e registra alerta para reposição.
- **Metabase**: lê o Postgres direto para o relatório da equipe comercial.

## Stack
Node 20+ · Express · PostgreSQL (`pg`, SQL puro) · sem build de frontend.

## Setup

```bash
cp .env.example .env          # ajuste segredos e credenciais
docker compose up -d          # sobe o Postgres (ou use um Postgres seu em DATABASE_URL)
npm install
npm run migrate               # cria as tabelas
npm run seed                  # cria o admin (ADMIN_EMAIL/ADMIN_PASSWORD) + dados de exemplo
npm start                     # http://localhost:3000
```

Login no painel com `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Webhook do checkout-simples + HubSpot

O checkout-simples **não envia SKU/quantidade** — um pedido é uma transação com um valor
único. Por isso, quando chega o evento `transaction.paid`, buscamos os **line items do deal
no HubSpot** (pelo `external_ref` = id do deal) e damos a baixa a partir deles.

```
checkout-simples (transaction.paid)  ->  external_ref = deal HubSpot
   ->  GET line items do deal (SKU + quantidade)  ->  baixa FEFO idempotente
```

### Endpoint
```
POST /webhooks/checkout
Content-Type: application/json
x-webhook-signature: <HMAC-SHA256 hex do corpo cru, com WEBHOOK_SECRET>
```

Envelope emitido pelo checkout-simples:
```json
{
  "event": "transaction.paid",
  "transaction": {
    "transaction_id": "clx...",          // chave de idempotência
    "external_ref": "<id do deal HubSpot>",
    "checkout": { "description": "..." }
  },
  "timestamp": "..."
}
```

- **Idempotência**: `transaction.transaction_id` (também aceita `id` / `order_id`).
- **Deal**: `transaction.external_ref` (fallback: `checkout.external_ref`, `metadata.deal_id`).
- **Evento**: só os de `ACCEPTED_EVENTS` (padrão `transaction.paid`) dão baixa.
- **SKU**: propriedade do line item no HubSpot, config. via `HUBSPOT_SKU_PROPERTY` (padrão `hs_sku`).

### Comportamento
| Situação | Resultado |
|---|---|
| Pedido novo | Busca itens no HubSpot, baixa FEFO, `200 {ok:true, idempotent:false}` |
| Webhook repetido (mesmo `transaction_id`) | **Não** repete baixa nem chama HubSpot, `200 {idempotent:true}` |
| Saldo insuficiente | Baixa parcial + alerta `shortage`, `200` |
| SKU não cadastrado | Alerta `unknown_sku`, `200` |
| Produto inativo | Alerta `inactive_product` (sem baixa), `200` |
| Pedido sem `external_ref` | Alerta `no_deal`, `200 {ignored:true}` |
| Deal sem itens com SKU | Alerta `no_items`, `200 {ignored:true}` |
| Evento fora do allowlist | `200 {ignored:true}` |
| Assinatura inválida | `401` |
| Erro (HubSpot 429/5xx ou DB) | `500` — checkout reenvia; pedido não fica marcado, retry reprocessa limpo |

### Ligar em produção (sem tocar no checkout)
1. **HubSpot** → criar um *Private App* com escopos `crm.objects.deals.read` +
   `crm.objects.line_items.read`; pôr o token em `HUBSPOT_API_TOKEN`.
2. **Checkout-simples** → no painel `/webhooks`, criar endpoint para
   `POST https://<seu-host>/webhooks/checkout`, evento `transaction.paid`, com um **secret**;
   pôr o mesmo valor em `WEBHOOK_SECRET`.
3. Conferir que o SKU do estoque = propriedade `hs_sku` do line item (senão ajustar `HUBSPOT_SKU_PROPERTY`).

> Em dev, deixe `WEBHOOK_SECRET` vazio para desligar a verificação de assinatura.
> Em produção o boot **falha** se `WEBHOOK_SECRET` ou `JWT_SECRET` não estiverem definidos.

## API (painel, requer login)

| Método | Rota | Ação |
|---|---|---|
| GET | `/api/products` | lista produtos + saldo total |
| POST | `/api/products` | cria produto |
| PUT | `/api/products/:id` | edita produto |
| GET | `/api/products/:id/batches` | lotes do produto |
| POST | `/api/products/:id/batches` | entrada de lote |
| POST | `/api/batches/:id/adjust` | ajuste de saldo (±) |
| GET | `/api/movements` | ledger (filtra por `order_id`) |
| GET | `/api/alerts` | alertas pendentes |
| POST | `/api/alerts/:id/resolve` | resolve alerta |
| GET | `/api/reports/low-stock` | estoque ≤ mínimo |
| GET | `/api/reports/expiring?days=90` | lotes vencendo |

## Modelo de dados
`products` → `stock_batches` (lote/fabricação/validade/saldo) · `stock_movements` (ledger) · `processed_orders` (idempotência) · `stock_alerts` · `users`.
