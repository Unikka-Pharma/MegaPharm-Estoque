import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { verifySignature } from '../webhook/hmac.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';

// Rotas de diagnostico — SOMENTE admin logado. Nunca retornam segredos crus
// (token/secret): expoem apenas prefixo/tamanho, escopos e status HTTP.
export const diagRouter = Router();
diagRouter.use(requireAuth, requireAdmin);

const REQUIRED_HUBSPOT_SCOPES = ['crm.objects.deals.read', 'crm.objects.line_items.read'];

// Pista sobre o token sem vaza-lo: prefixo, tamanho e se tem cara de API Key
// legada (UUID) em vez de Private App token (pat-...).
function tokenHint(t) {
  if (!t) return null;
  return {
    prefix: t.slice(0, 8),
    length: t.length,
    looksLegacyApiKey: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(t),
    looksPrivateApp: t.startsWith('pat-'),
  };
}

// GET /api/diag/hubspot
// Confirma se o HUBSPOT_API_TOKEN e valido, tem os escopos certos e le deals/line items.
diagRouter.get('/hubspot', async (_req, res) => {
  const token = config.hubspot.token;
  const out = {
    configured: !!token,
    token: tokenHint(token),
    baseUrl: config.hubspot.baseUrl,
    skuProperty: config.hubspot.skuProperty,
    scopes: null,
    missingScopes: null,
    checks: {},
    ok: false,
  };
  if (!token) {
    out.hint = 'HUBSPOT_API_TOKEN vazio na stack';
    return res.status(200).json(out);
  }

  const auth = { Authorization: `Bearer ${token}` };
  try {
    // Escopos + hub do token (endpoint de info de Private App).
    const info = await fetch(`${config.hubspot.baseUrl}/oauth/v2/private-apps/get/access-token-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenKey: token }),
    });
    out.checks.tokenInfo = info.status;
    if (info.ok) {
      const body = await info.json().catch(() => ({}));
      out.scopes = body.scopes || [];
      out.hubId = body.hubId ?? null;
      out.missingScopes = REQUIRED_HUBSPOT_SCOPES.filter((s) => !out.scopes.includes(s));
    }

    // Leitura real de deals e line items (os 2 escopos que o webhook usa).
    const deals = await fetch(`${config.hubspot.baseUrl}/crm/v3/objects/deals?limit=1`, { headers: auth });
    out.checks.dealsRead = deals.status;
    const li = await fetch(`${config.hubspot.baseUrl}/crm/v3/objects/line_items?limit=1`, { headers: auth });
    out.checks.lineItemsRead = li.status;

    // Leitura do catalogo de produtos (usada pela importacao). Reproduz EXATAMENTE
    // a query do cliente (properties repetido) e captura o corpo do erro quando falha,
    // para revelar a mensagem real do HubSpot (400 "Invalid request" fica mascarado).
    const prodUrl = `${config.hubspot.baseUrl}/crm/v3/objects/products?limit=1`
      + `&properties=${encodeURIComponent(config.hubspot.skuProperty)}&properties=name`;
    const prod = await fetch(prodUrl, { headers: auth });
    out.checks.productsRead = prod.status;
    out.hasProductsScope = Array.isArray(out.scopes)
      ? out.scopes.includes('crm.objects.products.read') || out.scopes.includes('e-commerce')
      : null;
    if (!prod.ok) {
      out.checks.productsError = (await prod.text().catch(() => '')).slice(0, 300);
    }

    out.ok = deals.status === 200 && li.status === 200 &&
      (out.missingScopes ? out.missingScopes.length === 0 : true);
    if (!out.ok) {
      if (deals.status === 401 || li.status === 401) out.hint = 'Token invalido ou expirado (401)';
      else if (deals.status === 403 || li.status === 403) out.hint = 'Token valido mas sem escopo de leitura (403)';
      else if (out.missingScopes && out.missingScopes.length) out.hint = `Faltam escopos: ${out.missingScopes.join(', ')}`;
    }
    if (prod.status !== 200) {
      out.productsHint = prod.status === 403
        ? 'Falta o escopo crm.objects.products.read no Private App'
        : prod.status === 400
          ? `A propriedade de SKU "${config.hubspot.skuProperty}" pode nao existir no objeto de produtos (veja productsError)`
          : `Leitura de produtos retornou ${prod.status}`;
    }
  } catch (e) {
    out.error = e.message;
  }
  res.status(200).json(out);
});

// GET /api/diag/webhook
// Estado do WEBHOOK_SECRET + auto-teste do HMAC (assina e confere com a propria verificacao).
diagRouter.get('/webhook', (_req, res) => {
  const secret = config.webhookSecret;
  const configured = !!secret;

  let selfTest = 'pulado (sem secret — verificacao desligada)';
  if (configured) {
    const sample = Buffer.from('{"diag":"ping"}');
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(sample).digest('hex');
    const good = verifySignature(sample, sig, secret);          // assinatura correta -> aceita
    const bad = verifySignature(sample, 'sha256=deadbeef', secret); // errada -> rejeita
    selfTest = good && !bad ? 'ok' : 'FALHOU';
  }

  res.status(200).json({
    configured,
    verificationEnabled: configured,
    warning: configured ? null : 'WEBHOOK_SECRET vazio: verificacao de assinatura DESLIGADA (nao use assim em producao)',
    acceptedEvents: config.acceptedEvents,
    selfTest,
  });
});

// POST /api/diag/webhook/sign
// Devolve a assinatura esperada para o corpo enviado. Mande o MESMO payload que o
// checkout-simples envia e compare com o header dele: se baterem, o segredo e o mesmo.
diagRouter.post('/webhook/sign', (req, res) => {
  if (!config.webhookSecret) return res.status(400).json({ error: 'WEBHOOK_SECRET nao configurado' });
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const hex = crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  res.json({
    header: 'x-webhook-signature',
    signature: hex,              // formato hex puro (como o checkout-simples envia)
    withPrefix: `sha256=${hex}`, // formato alternativo tambem aceito pela verificacao
    bytesHashed: raw.length,
  });
});
