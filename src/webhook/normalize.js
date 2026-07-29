// Normaliza o envelope do checkout-simples para { order_id, event, deal_id, description }.
//
// Formato emitido pelo checkout-simples (transaction.paid):
//   { "event": "transaction.paid",
//     "transaction": { "transaction_id": "clx...", "external_ref": "<deal HubSpot>",
//                      "amount_cents": 12900, "metadata": {...},
//                      "checkout": { "description": "...", "external_ref": "...", "metadata": {...} } },
//     "timestamp": "..." }
//
// Tolera tambem um objeto "plano" (sem envelope) para facilitar testes.
export function normalizeCheckoutEnvelope(body) {
  if (!body || typeof body !== 'object') return null;

  const t = body.transaction && typeof body.transaction === 'object' ? body.transaction : body;

  const order_id = String(t.transaction_id ?? t.id ?? body.order_id ?? '').trim();
  if (!order_id) return null;

  const event = String(body.event ?? t.status ?? '').toLowerCase();

  // external_ref = id do deal no HubSpot (quando HubSpot esta ligado no checkout).
  const deal_id = String(
    t.external_ref ??
    t.checkout?.external_ref ??
    t.metadata?.hubspot_deal_id ??
    t.metadata?.deal_id ??
    body.deal_id ?? '').trim();

  const description = t.checkout?.description ?? t.description ?? null;

  return { order_id, event, deal_id, description };
}
