import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  console.error('pg pool error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

// Executa fn dentro de uma transacao com client dedicado.
// Faz COMMIT no sucesso, ROLLBACK em erro, e sempre libera o client.
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignora erro de rollback */ }
    throw e;
  } finally {
    client.release();
  }
}
