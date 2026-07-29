import crypto from 'node:crypto';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Verifica header X-Signature no formato 'sha256=<hex>' = HMAC-SHA256 do corpo cru.
// Comparacao timing-safe. Sem segredo configurado => verificacao desligada (apenas dev).
export function verifySignature(rawBody, header, secret) {
  if (!secret) return true;
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  let a, b;
  try {
    a = Buffer.from(provided, 'hex');
    b = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
