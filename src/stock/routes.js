import { Router } from 'express';
import { query, withTx } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { getCatalogProducts, setProductSkus } from '../hubspot/client.js';

export const stockRouter = Router();
stockRouter.use(requireAuth);

/* ---------------- Produtos ---------------- */

// Importa o catalogo de produtos do HubSpot. Produtos cujo SKU ja existe sao
// ignorados (on conflict do nothing); produtos sem SKU ou sem nome tambem.
// Definida antes de POST '/products' e das rotas com :id (nao ha conflito de path,
// mas mantem os endpoints de produto agrupados).
stockRouter.post('/products/import-hubspot', async (req, res) => {
  let catalog;
  try {
    catalog = await getCatalogProducts();
  } catch (e) {
    // Repassa erro do HubSpot (token ausente, escopo faltando -> 403, etc.) com mensagem clara.
    const status = e.status && e.status >= 400 && e.status < 500 ? e.status : 502;
    return res.status(status).json({ error: `Falha ao consultar o HubSpot: ${e.message}` });
  }

  // Produtos sem SKU no HubSpot recebem um SKU numerico em sequencia (10, 20, 30, ...).
  // Ordem estavel por id do HubSpot para a atribuicao ser reproduzivel.
  const needSku = catalog
    .filter((it) => !it.sku && it.id)
    .sort((a, b) => Number(a.id) - Number(b.id));

  // Ponto de partida: continua a partir do maior SKU numerico ja existente (no catalogo
  // do HubSpot e no banco local), arredondando pro proximo multiplo de 10. Assim nao
  // reinicia em 10 e nao colide com o que ja foi criado. 1a vez (sem SKU) comeca em 10.
  const numericFrom = (s) => (/^\d+$/.test(String(s ?? '')) ? parseInt(s, 10) : 0);
  const maxCatalog = catalog.reduce((m, it) => Math.max(m, numericFrom(it.sku)), 0);
  // {1,18} evita estourar bigint no cast.
  const dbMax = await query(
    `select coalesce(max(sku::bigint), 0)::bigint as m from products where sku ~ '^[0-9]{1,18}$'`);
  const maxLocal = Number(dbMax.rows[0]?.m || 0);
  let seq = Math.floor(Math.max(maxCatalog, maxLocal) / 10) * 10 + 10;

  for (const it of needSku) { it.sku = String(seq); seq += 10; }

  // Grava os SKUs gerados de volta no HubSpot (a menos que writeBackSkus:false no body),
  // para o hs_sku existir nos dois lados e a baixa por venda casar o produto. Precisa do
  // escopo crm.objects.products.write. Se falhar, os gerados NAO sao importados localmente
  // (evita duplicar o mesmo produto com numero diferente numa proxima tentativa).
  const writeBack = req.body?.writeBackSkus !== false;
  let skusWritten = 0;
  let writeError = null;
  let generatedImportable = true;
  if (writeBack && needSku.length) {
    try {
      skusWritten = await setProductSkus(needSku.map((it) => ({ id: it.id, sku: it.sku })));
    } catch (e) {
      writeError = e.status === 403
        ? 'Sem escopo crm.objects.products.write no token — SKUs NAO foram gravados no HubSpot; produtos sem SKU nao foram importados'
        : `Falha ao gravar SKUs no HubSpot: ${e.message}`;
      generatedImportable = false;
    }
  }
  const generatedSkuSet = new Set(needSku.map((it) => it.sku));

  let imported = 0, skipped = 0, invalid = 0;
  await withTx(async (c) => {
    for (const item of catalog) {
      const sku = item.sku;
      if (!sku) { invalid++; continue; }  // sem SKU e sem id: nao da p/ identificar
      // Gerado mas nao gravado no HubSpot -> segura a importacao pra retry limpo depois.
      if (!generatedImportable && generatedSkuSet.has(sku)) continue;
      // Nome e obrigatorio (coluna NOT NULL); se faltar, usa o proprio SKU como nome.
      const name = item.name || sku;

      const r = await c.query(
        `insert into products (sku, name)
         values ($1, $2)
         on conflict (sku) do nothing
         returning id`,
        [sku, name]);
      if (r.rowCount) imported++; else skipped++;
    }
  });

  res.json({
    total: catalog.length,
    imported, skipped, invalid,
    generatedSkus: needSku.length,
    skusWrittenToHubspot: skusWritten,
    writeError,
  });
});

stockRouter.get('/products', async (_req, res) => {
  const r = await query(
    `select p.*,
            coalesce(sum(b.qty_on_hand), 0)::int as qty_total,
            count(b.id) filter (where b.qty_on_hand > 0)::int as lotes_ativos
     from products p
     left join stock_batches b on b.product_id = p.id
     group by p.id
     order by p.name`);
  res.json(r.rows);
});

stockRouter.post('/products', async (req, res) => {
  const { sku, name, unit, min_qty } = req.body || {};
  if (!sku || !name) return res.status(400).json({ error: 'sku e name obrigatorios' });
  try {
    const r = await query(
      `insert into products (sku, name, unit, min_qty)
       values ($1, $2, coalesce($3, 'un'), $4)
       returning *`,
      [String(sku).trim(), String(name).trim(), unit || null,
       Number.isFinite(+min_qty) ? Math.max(0, +min_qty) : 0]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'SKU ja existe' });
    throw e;
  }
});

stockRouter.put('/products/:id', async (req, res) => {
  const { name, unit, min_qty, active } = req.body || {};
  const r = await query(
    `update products set
       name = coalesce($2, name),
       unit = coalesce($3, unit),
       min_qty = coalesce($4, min_qty),
       active = coalesce($5, active),
       updated_at = now()
     where id = $1
     returning *`,
    [req.params.id, name ?? null, unit ?? null,
     Number.isFinite(+min_qty) ? Math.max(0, +min_qty) : null,
     typeof active === 'boolean' ? active : null]);
  if (!r.rowCount) return res.status(404).json({ error: 'produto nao encontrado' });
  res.json(r.rows[0]);
});

/* ---------------- Lotes ---------------- */

stockRouter.get('/products/:id/batches', async (req, res) => {
  const r = await query(
    `select * from stock_batches where product_id = $1
     order by validade asc nulls last, id`, [req.params.id]);
  res.json(r.rows);
});

// Entrada de lote: novo lote, ou reforca a quantidade de um lote existente (mesmo lote).
stockRouter.post('/products/:id/batches', async (req, res) => {
  const { lote, fabricacao, validade, quantity } = req.body || {};
  const qty = Number(quantity);
  if (!lote || !Number.isInteger(qty) || qty <= 0)
    return res.status(400).json({ error: 'lote e quantity (inteiro > 0) obrigatorios' });
  try {
    const out = await withTx(async (c) => {
      const up = await c.query(
        `insert into stock_batches (product_id, lote, fabricacao, validade, qty_on_hand)
         values ($1, $2, $3, $4, $5)
         on conflict (product_id, lote) do update
           set qty_on_hand = stock_batches.qty_on_hand + excluded.qty_on_hand,
               fabricacao  = coalesce(excluded.fabricacao, stock_batches.fabricacao),
               validade    = coalesce(excluded.validade, stock_batches.validade),
               updated_at  = now()
         returning *`,
        [req.params.id, String(lote).trim(), fabricacao || null, validade || null, qty]);
      await c.query(
        `insert into stock_movements (product_id, batch_id, order_id, qty, reason, created_by)
         values ($1, $2, null, $3, 'entry', $4)`,
        [req.params.id, up.rows[0].id, qty, req.user.sub]);
      return up.rows[0];
    });
    res.status(201).json(out);
  } catch (e) {
    if (e.code === '23503') return res.status(404).json({ error: 'produto nao encontrado' });
    throw e;
  }
});

// Ajuste manual de saldo de um lote (correcao de inventario). delta pode ser +/-.
stockRouter.post('/batches/:id/adjust', async (req, res) => {
  const { delta, note } = req.body || {};
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0)
    return res.status(400).json({ error: 'delta inteiro != 0 obrigatorio' });
  try {
    const out = await withTx(async (c) => {
      const b = await c.query(
        `update stock_batches set qty_on_hand = qty_on_hand + $2, updated_at = now()
         where id = $1 returning *`, [req.params.id, d]);
      if (!b.rowCount) { const e = new Error('nf'); e.http = 404; throw e; }
      await c.query(
        `insert into stock_movements (product_id, batch_id, qty, reason, note, created_by)
         values ($1, $2, $3, 'adjustment', $4, $5)`,
        [b.rows[0].product_id, b.rows[0].id, d, note || null, req.user.sub]);
      return b.rows[0];
    });
    res.json(out);
  } catch (e) {
    if (e.http === 404) return res.status(404).json({ error: 'lote nao encontrado' });
    if (e.code === '23514') return res.status(400).json({ error: 'saldo nao pode ficar negativo' });
    throw e;
  }
});

/* ---------------- Movimentos ---------------- */

stockRouter.get('/movements', async (req, res) => {
  const { order_id, product_id, limit } = req.query;

  // Valida os numericos em JS (evita 500 por erro de cast no Postgres).
  let pid = null;
  if (product_id != null && product_id !== '') {
    if (!/^\d+$/.test(String(product_id)))
      return res.status(400).json({ error: 'product_id invalido' });
    pid = String(product_id);
  }
  let lim = 100;
  if (limit != null && limit !== '') {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1)
      return res.status(400).json({ error: 'limit invalido' });
    lim = Math.min(n, 500);
  }

  const r = await query(
    `select m.*, p.sku, p.name as product_name, b.lote
     from stock_movements m
     join products p on p.id = m.product_id
     left join stock_batches b on b.id = m.batch_id
     where ($1::text is null or m.order_id = $1)
       and ($2::bigint is null or m.product_id = $2)
     order by m.created_at desc
     limit $3`,
    [order_id || null, pid, lim]);
  res.json(r.rows);
});

/* ---------------- Alertas ---------------- */

stockRouter.get('/alerts', async (req, res) => {
  const showResolved = req.query.resolved === 'true';
  const r = await query(
    `select * from stock_alerts
     where ($1 or resolved = false)
     order by created_at desc limit 500`, [showResolved]);
  res.json(r.rows);
});

stockRouter.post('/alerts/:id/resolve', async (req, res) => {
  const r = await query(
    `update stock_alerts set resolved = true, resolved_at = now()
     where id = $1 returning *`, [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'alerta nao encontrado' });
  res.json(r.rows[0]);
});

/* ---------------- Relatorios (Metabase pode ler as mesmas queries no Postgres) ---------------- */

stockRouter.get('/reports/low-stock', async (_req, res) => {
  const r = await query(
    `select p.id, p.sku, p.name, p.min_qty,
            coalesce(sum(b.qty_on_hand), 0)::int as qty_total
     from products p
     left join stock_batches b on b.product_id = p.id
     where p.active
     group by p.id
     having coalesce(sum(b.qty_on_hand), 0) <= p.min_qty
     order by qty_total asc, p.name`);
  res.json(r.rows);
});

stockRouter.get('/reports/expiring', async (req, res) => {
  // days=0 (vencendo hoje) e valido — nao pode virar 90 por causa de '|| 90'.
  const parsed = Number(req.query.days);
  const days = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 90;
  const r = await query(
    `select b.*, p.sku, p.name as product_name
     from stock_batches b
     join products p on p.id = b.product_id
     where b.qty_on_hand > 0 and b.validade is not null
       and b.validade <= current_date + make_interval(days => $1)
     order by b.validade asc`, [days]);
  res.json(r.rows);
});
