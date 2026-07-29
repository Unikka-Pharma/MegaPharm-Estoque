import { config } from '../config.js';

// Cliente minimo da API do HubSpot. Usa fetch nativo (Node 18+).
// Precisa de um Private App token com escopos: crm.objects.deals.read + crm.objects.line_items.read.
async function hsFetch(path, opts = {}) {
  if (!config.hubspot.token) {
    const e = new Error('HUBSPOT_API_TOKEN nao configurado');
    e.status = 500;
    throw e;
  }
  const res = await fetch(config.hubspot.baseUrl + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${config.hubspot.token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`HubSpot ${res.status}: ${body.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// Busca os line items de um deal e retorna [{ sku, quantity, name }].
// Itens sem SKU ou com quantidade <= 0 sao descartados (o webhook alerta se sobrar vazio).
export async function getDealLineItems(dealId) {
  const assoc = await hsFetch(
    `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/line_items?limit=100`);
  const ids = (assoc.results || [])
    .map((r) => r.toObjectId ?? r.id)
    .filter((v) => v != null)
    .map(String);
  if (!ids.length) return [];

  const skuProp = config.hubspot.skuProperty;
  const data = await hsFetch(`/crm/v3/objects/line_items/batch/read`, {
    method: 'POST',
    body: JSON.stringify({
      properties: [skuProp, 'quantity', 'name'],
      inputs: ids.map((id) => ({ id })),
    }),
  });

  // Teto sao p/ quantidade: evita estourar coluna integer no Postgres (max ~2.1bi),
  // que causaria erro 22003, ROLLBACK e loop de retry no webhook (payload deterministico).
  const MAX_QTY = 1_000_000;

  const items = [];
  for (const li of data.results || []) {
    const p = li.properties || {};
    const sku = String(p[skuProp] ?? '').trim();
    const quantity = Math.floor(Number(p.quantity ?? 0));
    if (!sku || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QTY) continue;
    items.push({ sku, quantity, name: p.name || null });
  }
  return items;
}
