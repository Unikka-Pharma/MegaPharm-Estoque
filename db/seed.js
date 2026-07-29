import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth/password.js';
import { config } from '../src/config.js';

async function main() {
  if (!config.admin.email || !config.admin.password) {
    console.error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env');
    process.exit(1);
  }

  const email = config.admin.email.toLowerCase();
  const hash = await hashPassword(config.admin.password);
  await pool.query(
    `insert into users (email, password_hash, name, role)
     values ($1, $2, 'Admin', 'admin')
     on conflict (email) do update set password_hash = excluded.password_hash`,
    [email, hash]);
  console.log(`admin pronto: ${email}`);

  // Dados de exemplo (nunca em producao)
  if (config.env !== 'production') {
    const p = await pool.query(
      `insert into products (sku, name, unit, min_qty)
       values ('MED-001', 'Produto Exemplo A', 'un', 5)
       on conflict (sku) do update set name = excluded.name
       returning id`);
    await pool.query(
      `insert into stock_batches (product_id, lote, fabricacao, validade, qty_on_hand)
       values ($1, 'L2401', '2025-01-10', '2027-01-10', 100)
       on conflict (product_id, lote) do nothing`,
      [p.rows[0].id]);
    console.log('produto de exemplo MED-001 (lote L2401, 100 un)');
  }

  await pool.end();
  console.log('seed done');
}

main().catch((e) => { console.error(e); process.exit(1); });
