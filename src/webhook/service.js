import { pool, query } from '../db.js';

// Consulta rapida de idempotencia: se o pedido ja foi processado, o webhook
// nem precisa chamar o HubSpot. A garantia real de baixa-1x fica no processCheckout.
export async function getProcessed(order_id) {
  const r = await query(
    'select status, result from processed_orders where order_id = $1', [order_id]);
  return r.rows[0] || null;
}

// Conta um webhook duplicado que caiu no atalho de idempotencia (observabilidade).
export async function bumpReceived(order_id) {
  await query(
    'update processed_orders set received_count = received_count + 1 where order_id = $1',
    [order_id]);
}

// Registra um alerta operacional (ex: pedido sem deal, deal sem itens).
export async function recordAlert(order_id, type, message) {
  await query(
    `insert into stock_alerts (order_id, type, message) values ($1, $2, $3)`,
    [order_id, type, message]);
}

// Processa a baixa de estoque de um pedido pago.
//
// Garantias:
//  - Idempotente por order_id: mesmo que N webhooks cheguem para o mesmo pedido
//    (inclusive simultaneos), a baixa acontece 1x so. O INSERT ... ON CONFLICT
//    reivindica o pedido; qualquer duplicado bate no conflito e retorna o resultado ja gravado.
//  - FEFO: consome o lote de validade mais proxima primeiro (index idx_batches_fefo),
//    travando os lotes com FOR UPDATE para evitar oversell entre pedidos concorrentes.
//  - Baixa parcial + alerta: se faltar saldo, baixa o que tem e registra 'shortage'.
//  - SKU inexistente: registra alerta 'unknown_sku' e segue os demais itens.
//
// Tudo roda numa unica transacao: erro no meio faz ROLLBACK e o pedido NAO fica
// marcado como processado, permitindo retry do webhook.
export async function processCheckout({ order_id, items, payloadHash }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reivindica o pedido. rowCount 0 => ja processado (ou sendo, por outra tx que commitou).
    const claim = await client.query(
      `insert into processed_orders (order_id, payload_hash, status)
       values ($1, $2, 'processing')
       on conflict (order_id) do nothing
       returning order_id`,
      [order_id, payloadHash]);

    if (claim.rowCount === 0) {
      await client.query(
        `update processed_orders set received_count = received_count + 1
         where order_id = $1`, [order_id]);
      const prev = await client.query(
        `select status, result from processed_orders where order_id = $1`, [order_id]);
      await client.query('COMMIT');
      return {
        idempotent: true,
        status: prev.rows[0]?.status,
        result: prev.rows[0]?.result,
      };
    }

    // Resolve os produtos ANTES de travar qualquer lote. Depois travamos em ordem
    // global deterministica (product_id crescente) — assim pedidos concorrentes que
    // tocam os mesmos produtos adquirem locks na MESMA ordem, sem deadlock ABBA.
    const resolved = [];
    for (const item of items) {
      const prod = await client.query(
        `select id, active from products where sku = $1`, [item.sku]);
      resolved.push({ item, product: prod.rows[0] || null });
    }

    const lines = [];

    // SKU inexistente ou produto inativo: alerta (distintos), sem baixa.
    for (const { item, product } of resolved) {
      if (!product) {
        await client.query(
          `insert into stock_alerts (order_id, sku, type, requested_qty, shortage_qty, message)
           values ($1, $2, 'unknown_sku', $3, $3, $4)`,
          [order_id, item.sku, item.quantity, `SKU nao cadastrado: ${item.sku}`]);
        lines.push({ sku: item.sku, requested: item.quantity, fulfilled: 0, shortage: item.quantity, unknown_sku: true });
      } else if (!product.active) {
        await client.query(
          `insert into stock_alerts (order_id, product_id, sku, type, requested_qty, shortage_qty, message)
           values ($1, $2, $3, 'inactive_product', $4, $4, $5)`,
          [order_id, product.id, item.sku, item.quantity, `Produto inativo (precisa reativar): ${item.sku}`]);
        lines.push({ sku: item.sku, requested: item.quantity, fulfilled: 0, shortage: item.quantity, inactive: true });
      }
    }

    // Itens ativos, ordenados por product_id (ordem de lock deterministica).
    const active = resolved
      .filter((r) => r.product && r.product.active)
      .sort((a, b) => {
        const x = BigInt(a.product.id), y = BigInt(b.product.id);
        return x < y ? -1 : x > y ? 1 : 0;
      });

    for (const { item, product } of active) {
      const productId = product.id;
      let need = item.quantity;
      let fulfilled = 0;

      // Lotes FEFO com saldo, travados p/ consumo atomico.
      const batches = await client.query(
        `select id, qty_on_hand from stock_batches
         where product_id = $1 and qty_on_hand > 0
         order by validade asc nulls last, id asc
         for update`, [productId]);

      for (const b of batches.rows) {
        if (need <= 0) break;
        const take = Math.min(need, b.qty_on_hand);
        await client.query(
          `update stock_batches set qty_on_hand = qty_on_hand - $1, updated_at = now()
           where id = $2`, [take, b.id]);
        await client.query(
          `insert into stock_movements (product_id, batch_id, order_id, qty, reason)
           values ($1, $2, $3, $4, 'sale')`, [productId, b.id, order_id, -take]);
        need -= take;
        fulfilled += take;
      }

      if (need > 0) {
        await client.query(
          `insert into stock_alerts
             (order_id, product_id, sku, type, requested_qty, fulfilled_qty, shortage_qty, message)
           values ($1, $2, $3, 'shortage', $4, $5, $6, $7)`,
          [order_id, productId, item.sku, item.quantity, fulfilled, need,
           `Estoque insuficiente para ${item.sku}: faltam ${need} un`]);
      }
      lines.push({ sku: item.sku, requested: item.quantity, fulfilled, shortage: need });
    }

    const result = { order_id, lines };
    await client.query(
      `update processed_orders set status = 'done', result = $2, processed_at = now()
       where order_id = $1`, [order_id, result]);

    await client.query('COMMIT');
    return { idempotent: false, status: 'done', result };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignora */ }
    throw e;
  } finally {
    client.release();
  }
}
