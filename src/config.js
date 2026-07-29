import 'dotenv/config';

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Env ${name} obrigatoria (veja .env.example)`);
  return v;
}

// Em producao o segredo e obrigatorio; em dev cai num default so pra facilitar.
// Evita rodar em producao com constante publica (forja de token / HMAC desligado).
function requiredInProd(name, devDefault) {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Env ${name} obrigatoria em producao`);
  return devDefault;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  env: NODE_ENV,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: requiredInProd('JWT_SECRET', 'dev-secret-troque'),
  jwtExpires: process.env.JWT_EXPIRES || '12h',
  webhookSecret: requiredInProd('WEBHOOK_SECRET', ''),
  acceptedEvents: (process.env.ACCEPTED_EVENTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  hubspot: {
    token: process.env.HUBSPOT_API_TOKEN || '',
    baseUrl: process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com',
    skuProperty: process.env.HUBSPOT_SKU_PROPERTY || 'hs_sku',
  },
  admin: {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
};
