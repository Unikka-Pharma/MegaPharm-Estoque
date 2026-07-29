// Mock da API do HubSpot para desenvolvimento/teste local do webhook de estoque.
// Uso: npm run mock:hubspot  (e aponte HUBSPOT_BASE_URL=http://localhost:3200 no .env)
//
// NAO usar em producao — em producao HUBSPOT_BASE_URL deve ser https://api.hubapi.com
// com um Private App token real em HUBSPOT_API_TOKEN.
import http from 'node:http';

const PORT = Number(process.env.MOCK_HUBSPOT_PORT || 3200);

// deal id -> ids dos line items associados
const DEAL_LINEITEMS = {
  'DEAL-1': ['LI-1', 'LI-2'],
  'DEAL-EMPTY': [],
  'DEAL-AB': ['LI-A', 'LI-B'],   // MED-001 depois MED-002
  'DEAL-BA': ['LI-B', 'LI-A'],   // ordem oposta — exercita ordem de lock (deadlock)
  'DEAL-INACTIVE': ['LI-INACT'],
  'DEAL-HUGE': ['LI-HUGE'],
};

// line item id -> propriedades (como o HubSpot devolve: valores string)
const LINEITEMS = {
  'LI-1': { hs_sku: 'MED-001', quantity: '2', name: 'Produto Exemplo A' },
  'LI-2': { hs_sku: 'MED-777', quantity: '1', name: 'SKU inexistente no estoque' },
  'LI-A': { hs_sku: 'MED-001', quantity: '1', name: 'Produto A' },
  'LI-B': { hs_sku: 'MED-002', quantity: '1', name: 'Produto B' },
  'LI-INACT': { hs_sku: 'MED-INACT', quantity: '1', name: 'Produto inativo' },
  'LI-HUGE': { hs_sku: 'MED-001', quantity: '999999999999', name: 'Qtd absurda' },
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!(req.headers.authorization || '').startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"message":"no token"}');
    }

    const m = req.url.match(/^\/crm\/v4\/objects\/deals\/([^/]+)\/associations\/line_items/);
    if (req.method === 'GET' && m) {
      const ids = DEAL_LINEITEMS[decodeURIComponent(m[1])] || [];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: ids.map((id) => ({ toObjectId: id })) }));
    }

    if (req.method === 'POST' && req.url.startsWith('/crm/v3/objects/line_items/batch/read')) {
      const { inputs = [] } = JSON.parse(body || '{}');
      const results = inputs
        .map(({ id }) => (LINEITEMS[id] ? { id, properties: LINEITEMS[id] } : null))
        .filter(Boolean);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"message":"not found"}');
  });
});

server.listen(PORT, () => console.log(`mock HubSpot em http://localhost:${PORT}`));
