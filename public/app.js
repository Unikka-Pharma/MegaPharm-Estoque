const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) { showLogin(); throw new Error('401'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `erro ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('pt-BR') : '—';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('pt-BR') : '—';

/* ---------- Auth ---------- */
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const me = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value }),
    });
    $('#who').textContent = me.email;
    showApp();
    loadProducts();
    refreshAlertBadge();
  } catch (err) {
    $('#login-error').textContent = err.message === '401' ? 'credenciais inválidas' : err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------- Tabs ---------- */
$$('header nav button').forEach((b) => b.addEventListener('click', () => {
  $$('header nav button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const tab = b.dataset.tab;
  $$('.tab').forEach((t) => t.classList.add('hidden'));
  $(`#tab-${tab}`).classList.remove('hidden');
  if (tab === 'produtos') loadProducts();
  if (tab === 'alertas') loadAlerts();
  if (tab === 'movimentos') loadMovements();
  if (tab === 'relatorios') loadReports();
}));

/* ---------- Produtos ---------- */
async function loadProducts() {
  const rows = await api('/api/products');
  $('#products tbody').innerHTML = rows.map((p) => {
    const low = p.qty_total <= p.min_qty;   // no/abaixo do mínimo -> destaca
    return `
    <tr>
      <td><span class="sku">${esc(p.sku)}</span></td>
      <td><span class="pname">${esc(p.name)}</span>${p.active ? '' : ' <span class="pill">inativo</span>'}</td>
      <td class="num">
        <span class="qty${low ? ' low' : ''}">${p.qty_total}</span><span class="unit">${esc(p.unit)}</span>
      </td>
      <td class="num dim">${p.lotes_ativos}</td>
      <td class="num dim">${p.min_qty}</td>
      <td class="right">
        <button class="btn-sm" data-batches="${p.id}" data-name="${esc(p.name)}">Ver lotes</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">Nenhum produto cadastrado.</td></tr>';
  $$('#products [data-batches]').forEach((b) =>
    b.addEventListener('click', () => openBatches(b.dataset.batches, b.dataset.name)));
}

$('#btn-import-hubspot').addEventListener('click', async () => {
  const btn = $('#btn-import-hubspot');
  if (!confirm('Importar o catálogo de produtos do HubSpot?\n\n' +
    'Produtos com SKU já cadastrado serão ignorados. Produtos sem SKU no HubSpot ' +
    'recebem um SKU numérico em sequência (10, 20, 30…), que também é gravado de volta no HubSpot.')) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Importando…';
  try {
    const r = await api('/api/products/import-hubspot', { method: 'POST' });
    alert(
      'Importação concluída.\n\n' +
      `Novos produtos: ${r.imported}\n` +
      `  (SKU gerado automaticamente: ${r.generatedSkus ?? 0})\n` +
      `SKUs gravados no HubSpot: ${r.skusWrittenToHubspot ?? 0}\n` +
      `Já existiam (ignorados): ${r.skipped}\n` +
      `Sem identificação (ignorados): ${r.invalid}\n` +
      `Total no HubSpot: ${r.total}` +
      (r.writeError ? `\n\n⚠️ ${r.writeError}` : ''));
    loadProducts();
  } catch (err) {
    alert('Falha na importação: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#btn-new-product').addEventListener('click', () => $('#product-form').classList.toggle('hidden'));
$('#p-cancel').addEventListener('click', () => $('#product-form').classList.add('hidden'));
$('#product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        sku: $('#p-sku').value, name: $('#p-name').value,
        unit: $('#p-unit').value, min_qty: Number($('#p-min').value),
      }),
    });
    $('#product-form').reset();
    $('#product-form').classList.add('hidden');
    loadProducts();
  } catch (err) { alert(err.message); }
});

/* ---------- Lotes (modal) ---------- */
let currentProductId = null;
async function openBatches(id, name) {
  currentProductId = id;
  $('#bm-title').textContent = `Lotes — ${name}`;
  $('#bm-error').textContent = '';
  $('#bm-filter').value = '';
  $('#bm-show-zero').checked = false;
  $('#batch-modal').classList.remove('hidden');
  await loadBatches();
}
let currentBatches = [];

async function loadBatches() {
  currentBatches = await api(`/api/products/${currentProductId}/batches`);
  renderBatches();
}

// Renderiza a lista já filtrada. Por padrão esconde lotes zerados — depois de
// meses de operação a maioria dos lotes fica em 0 e só polui a tela.
function renderBatches() {
  const q = ($('#bm-filter').value || '').trim().toLowerCase();
  const showZero = $('#bm-show-zero').checked;

  const comSaldo = currentBatches.filter((b) => b.qty_on_hand > 0);
  const total = comSaldo.reduce((s, b) => s + b.qty_on_hand, 0);
  const zerados = currentBatches.length - comSaldo.length;
  $('#bm-summary').innerHTML =
    `<strong>${comSaldo.length}</strong> lote(s) com saldo · <strong>${total}</strong> un`
    + (zerados ? ` · ${zerados} zerado(s)` : '');

  const list = currentBatches.filter((b) =>
    (showZero || b.qty_on_hand > 0) &&
    (!q || String(b.lote).toLowerCase().includes(q)));

  $('#batch-table tbody').innerHTML = list.map((b) => `
    <tr>
      <td><span class="sku">${esc(b.lote)}</span></td>
      <td class="dim">${fmtDate(b.fabricacao)}</td>
      <td>${fmtDate(b.validade)}</td>
      <td class="num"><span class="qty${b.qty_on_hand === 0 ? ' dim' : ''}">${b.qty_on_hand}</span></td>
      <td class="right"><button class="btn-sm" data-adjust="${b.id}">Ajustar</button></td>
    </tr>`).join('')
    || `<tr><td colspan="5" class="empty">${
         currentBatches.length ? 'Nenhum lote bate com o filtro.' : 'Nenhum lote cadastrado.'
       }</td></tr>`;

  $$('#batch-table [data-adjust]').forEach((btn) => btn.addEventListener('click', async () => {
    const delta = prompt('Ajuste de saldo (ex: -3 para baixa, 10 para entrada):');
    if (delta === null) return;
    const note = prompt('Motivo (opcional):') || '';
    try {
      await api(`/api/batches/${btn.dataset.adjust}/adjust`, {
        method: 'POST', body: JSON.stringify({ delta: Number(delta), note }),
      });
      loadBatches(); loadProducts();
    } catch (err) { alert(err.message); }
  }));
}
$('#bm-close').addEventListener('click', () => $('#batch-modal').classList.add('hidden'));
$('#bm-filter').addEventListener('input', renderBatches);
$('#bm-show-zero').addEventListener('change', renderBatches);
$('#batch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#bm-error').textContent = '';
  try {
    await api(`/api/products/${currentProductId}/batches`, {
      method: 'POST',
      body: JSON.stringify({
        lote: $('#b-lote').value, fabricacao: $('#b-fab').value || null,
        validade: $('#b-val').value || null, quantity: Number($('#b-qty').value),
      }),
    });
    $('#batch-form').reset();
    loadBatches(); loadProducts();
  } catch (err) { $('#bm-error').textContent = err.message; }
});

/* ---------- Alertas ---------- */
async function loadAlerts() {
  const rows = await api('/api/alerts');
  $('#alerts tbody').innerHTML = rows.map((a) => `
    <tr>
      <td>${fmtDateTime(a.created_at)}</td>
      <td><span class="pill ${a.type}">${a.type}</span></td>
      <td>${esc(a.order_id || '—')}</td>
      <td>${esc(a.sku || '—')}</td>
      <td>${esc(a.message || '')}</td>
      <td><button class="link" data-resolve="${a.id}">resolver</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhum alerta pendente. 🎉</td></tr>';
  $$('#alerts [data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/alerts/${b.dataset.resolve}/resolve`, { method: 'POST' });
    loadAlerts(); refreshAlertBadge();
  }));
}
async function refreshAlertBadge() {
  try {
    const rows = await api('/api/alerts');
    const badge = $('#alert-badge');
    if (rows.length) { badge.textContent = rows.length; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch { /* ignora */ }
}

/* ---------- Movimentos ---------- */
async function loadMovements() {
  const q = $('#mov-filter').value.trim();
  const rows = await api('/api/movements' + (q ? `?order_id=${encodeURIComponent(q)}` : ''));
  $('#movements tbody').innerHTML = rows.map((m) => `
    <tr>
      <td>${fmtDateTime(m.created_at)}</td>
      <td>${esc(m.sku)}</td>
      <td>${esc(m.product_name)}</td>
      <td>${esc(m.lote || '—')}</td>
      <td class="num" style="color:${m.qty < 0 ? 'var(--danger)' : 'var(--brand)'}">${m.qty > 0 ? '+' : ''}${m.qty}</td>
      <td>${esc(m.reason)}</td>
      <td>${esc(m.order_id || '—')}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">Nenhum movimento.</td></tr>';
}
let movTimer;
$('#mov-filter').addEventListener('input', () => { clearTimeout(movTimer); movTimer = setTimeout(loadMovements, 300); });

/* ---------- Relatórios ---------- */
async function loadReports() {
  const low = await api('/api/reports/low-stock');
  $('#low-stock tbody').innerHTML = low.map((p) => `
    <tr><td><span class="sku">${esc(p.sku)}</span></td><td><span class="pname">${esc(p.name)}</span></td>
      <td class="num"><span class="qty low">${p.qty_total}</span></td>
      <td class="num dim">${p.min_qty}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">Tudo acima do mínimo. 🎉</td></tr>';
  loadExpiring();
}
async function loadExpiring() {
  const days = Number($('#exp-days').value) || 90;
  const rows = await api(`/api/reports/expiring?days=${days}`);
  $('#expiring tbody').innerHTML = rows.map((b) => `
    <tr><td><span class="sku">${esc(b.sku)}</span></td><td><span class="pname">${esc(b.product_name)}</span></td>
      <td><span class="sku">${esc(b.lote)}</span></td>
      <td>${fmtDate(b.validade)}</td><td class="num"><span class="qty">${b.qty_on_hand}</span></td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">Nada vencendo nesse prazo.</td></tr>';
}
$('#exp-days').addEventListener('change', loadExpiring);

/* ---------- Boot ---------- */
(async function boot() {
  try {
    const me = await api('/auth/me');
    $('#who').textContent = me.email;
    showApp();
    loadProducts();
    refreshAlertBadge();
  } catch {
    showLogin();
  }
})();
