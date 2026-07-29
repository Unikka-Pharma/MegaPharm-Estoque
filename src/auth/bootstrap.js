import { query } from '../db.js';
import { hashPassword } from './password.js';
import { config } from '../config.js';

// Cria o admin inicial se ainda nao existir (idempotente).
// Facilita o deploy no Portainer: basta setar ADMIN_EMAIL/ADMIN_PASSWORD nas
// variaveis do stack — nao precisa rodar `seed` via shell.
// Usa ON CONFLICT DO NOTHING: nao sobrescreve a senha se o admin ja existe
// (troca de senha depois e feita no app, nao pela env).
export async function ensureAdmin() {
  if (!config.admin.email || !config.admin.password) return;
  const email = config.admin.email.toLowerCase();
  const hash = await hashPassword(config.admin.password);
  const r = await query(
    `insert into users (email, password_hash, name, role)
     values ($1, $2, 'Admin', 'admin')
     on conflict (email) do nothing`,
    [email, hash]);
  if (r.rowCount) console.log(`admin inicial criado: ${email}`);
}
