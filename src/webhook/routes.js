import { Router } from 'express';
import { verifySignature, sha256 } from './hmac.js';
import { normalizeCheckoutEnvelope } from './normalize.js';
import { processCheckout, getProcessed, recordAlert, bumpReceived } from './service.js';
import { getDealLineItems } from '../hubspot/client.js';
import { config } from '../config.js';

export const webhookRouter = Router();

// POST /webhooks/checkout
// Recebe o evento transaction.paid do checkout-simples, busca os line items do
// deal no HubSpot (via external_ref) e da baixa idempotente no estoque.
webhookRouter.post('/checkout', async (req, res) => {
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  // O checkout-simples assina com o header 'x-webhook-signature'. Aceita 'x-signature' como alias.
  const sigHeader = req.get('x-webhook-signature') || req.get('x-signature');
  if (!verifySignature(raw, sigHeader, config.webhookSecret)) {
    return res.status(401).json({ error: 'assinatura invalida' });
  }

  const evt = normalizeCheckoutEnvelope(req.body);
  if (!evt) return res.status(400).json({ error: 'payload sem transaction_id' });

  const event = (evt.event || req.get('x-webhook-event') || '').toLowerCase();
  // Fail-closed: com allowlist configurada, evento vazio/ausente NAO passa.
  if (config.acceptedEvents.length && !config.acceptedEvents.includes(event)) {
    return res.status(200).json({ ignored: true, reason: `evento '${event || '(vazio)'}' ignorado` });
  }

  try {
    // Idempotencia rapida: pedido ja finalizado => nao chama o HubSpot de novo.
    const prev = await getProcessed(evt.order_id);
    if (prev && prev.status === 'done') {
      await bumpReceived(evt.order_id);
      return res.status(200).json({ ok: true, idempotent: true, status: prev.status, result: prev.result });
    }

    if (!evt.deal_id) {
      await recordAlert(evt.order_id, 'no_deal',
        `Pedido ${evt.order_id} sem external_ref (deal HubSpot) — nao da pra buscar os itens`);
      return res.status(200).json({ ignored: true, reason: 'sem deal_id (external_ref)' });
    }

    // Busca os itens no HubSpot FORA de qualquer transacao (chamada de rede).
    const items = await getDealLineItems(evt.deal_id);
    if (!items.length) {
      await recordAlert(evt.order_id, 'no_items',
        `Deal ${evt.deal_id} (pedido ${evt.order_id}) sem line items com SKU`);
      return res.status(200).json({ ignored: true, reason: 'deal sem itens com SKU' });
    }

    // Baixa idempotente + FEFO (transacao curta, sem chamadas externas dentro).
    const out = await processCheckout({
      order_id: evt.order_id,
      items,
      payloadHash: sha256(raw),
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    // Erro transitorio (HubSpot 429/5xx/rede ou DB): 500 sinaliza retry ao checkout.
    // O pedido nao ficou marcado como processado, entao o retry reprocessa do zero.
    console.error('webhook baixa erro:', e.message);
    return res.status(500).json({ error: 'falha ao processar baixa' });
  }
});
