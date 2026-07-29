import 'express-async-errors';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { authRouter } from './auth/routes.js';
import { stockRouter } from './stock/routes.js';
import { webhookRouter } from './webhook/routes.js';
import { ensureAdmin } from './auth/bootstrap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cookieParser());
// Captura o corpo cru (rawBody) p/ verificacao HMAC do webhook.
app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRouter);
app.use('/webhooks', webhookRouter);
app.use('/api', stockRouter);

// Painel admin estatico
app.use(express.static(path.join(__dirname, '..', 'public')));

// Handler de erro final
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'erro interno' });
});

app.listen(config.port, async () => {
  console.log(`MegaPharm estoque em http://localhost:${config.port}`);
  try {
    await ensureAdmin();
  } catch (e) {
    console.error('ensureAdmin falhou:', e.message);
  }
});
