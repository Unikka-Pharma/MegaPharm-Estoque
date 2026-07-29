import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { verifyPassword, hashPassword } from './password.js';
import { signToken, requireAuth, requireAdmin } from './middleware.js';
import { config } from '../config.js';

export const authRouter = Router();

// Limita tentativas de login por IP (freia brute force / credential stuffing).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'muitas tentativas, tente novamente mais tarde' },
});

// Hash fixo comparado quando o usuario nao existe, pra igualar o tempo de resposta
// (bcrypt sempre roda) e nao vazar quais e-mails estao cadastrados.
const DUMMY_HASH = '$2a$10$sd90WPxC9SVun.UrtSGqT.Em6Kx/bzuAfetLeQCEBxLFEDrh0f5i2';

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'email e senha obrigatorios' });

  const r = await query('select * from users where email = $1', [email.toLowerCase()]);
  const user = r.rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok)
    return res.status(401).json({ error: 'credenciais invalidas' });

  res.cookie('token', signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.sub, email: req.user.email, role: req.user.role });
});

// Admin cria novos usuarios da equipe
authRouter.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'email e senha obrigatorios' });
  try {
    const hash = await hashPassword(password);
    const r = await query(
      `insert into users (email, password_hash, name, role)
       values ($1, $2, $3, $4)
       returning id, email, name, role`,
      [email.toLowerCase(), hash, name || null, role === 'admin' ? 'admin' : 'operator']);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email ja existe' });
    throw e;
  }
});
