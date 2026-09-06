const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-api-key,x-admin-key'
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function db(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error('Database is not configured');
  return { url: env.TURSO_DATABASE_URL.replace(/\/$/, '') + '/v2/pipeline', token: env.TURSO_AUTH_TOKEN };
}

async function sql(env, statements) {
  const d = db(env);
  const response = await fetch(d.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: statements.map(statement => ({ type: 'execute', stmt: { sql: statement.sql, args: (statement.args || []).map(value => ({ type: typeof value === 'number' ? 'integer' : 'text', value: String(value) })) } })) })
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  const payload = await response.json();
  const error = payload.results?.find(result => result.type === 'error');
  if (error) throw new Error(error.error?.message || 'Database query failed');
  return payload.results?.map(result => result.response?.result || { rows: [], affected_row_count: 0 }) || [];
}

async function init(env) {
  await sql(env, [
    { sql: 'CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0, wallet_address TEXT, network TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)' },
    { sql: 'CREATE TABLE IF NOT EXISTS earnings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, source TEXT NOT NULL, provider_event_id TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)' },
    { sql: 'CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, wallet_address TEXT NOT NULL, network TEXT NOT NULL, status TEXT NOT NULL, transaction_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)' },
    { sql: 'CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL, provider_ref TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, created_at DESC)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC)' }
  ]);
}

function auth(request, env) { const key = request.headers.get('x-api-key'); return Boolean(env.API_KEY && key && key === env.API_KEY); }
function adminAuth(request, env) { const key = request.headers.get('x-admin-key'); return Boolean(env.ADMIN_INGEST_KEY && key && key === env.ADMIN_INGEST_KEY); }
function validUserId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{3,80}$/.test(value); }
function cents(value) { const n = typeof value === 'number' ? value : Number(String(value)); if (!Number.isFinite(n) || n < 0 || n > 1000000000000) throw new Error('invalid amount'); return Math.round(n * 100); }
function usdt(value) { return (Number(value || 0) / 100).toFixed(2); }
async function body(request) { return await request.json().catch(() => ({})); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ ok: true, service: 'usdt-wallet-worker' });
    if (!auth(request, env)) return json({ error: 'authentication required' }, 401);
    try {
      await init(env);
      if (request.method === 'POST' && url.pathname === '/api/user/create') {
        const b = await body(request); if (!validUserId(b.userId)) return json({ error: 'invalid userId' }, 400);
        await sql(env, [{ sql: 'INSERT OR IGNORE INTO users(user_id) VALUES (?)', args: [b.userId] }]);
        return json({ userId: b.userId, created: true });
      }
      let match = url.pathname.match(/^\/api\/balance\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        const [r] = await sql(env, [{ sql: 'SELECT user_id, balance_cents, wallet_address, network FROM users WHERE user_id = ?', args: [match[1]] }]);
        if (!r.rows.length) return json({ error: 'user not found' }, 404);
        const x = r.rows[0]; return json({ userId: x[0], balance: `${usdt(x[1])} USDT`, balanceUsdt: usdt(x[1]), walletAddress: x[2], network: x[3] });
      }
      if (request.method === 'POST' && url.pathname === '/api/earn') {
        if (!adminAuth(request, env)) return json({ error: 'admin authentication required' }, 403);
        const b = await body(request); if (!validUserId(b.userId) || !b.providerEventId || !b.source) return json({ error: 'userId, providerEventId and source required' }, 400);
        const amount = cents(b.amount); const id = crypto.randomUUID();
        try { await sql(env, [{ sql: 'INSERT INTO earnings(id,user_id,amount_cents,source,provider_event_id) VALUES(?,?,?,?,?)', args: [id,b.userId,amount,b.source,b.providerEventId] }, { sql: 'UPDATE users SET balance_cents=balance_cents+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?', args: [amount,b.userId] }]); } catch { return json({ error: 'duplicate or invalid earning' }, 409); }
        return json({ earningId: id, userId: b.userId, amount: `${usdt(amount)} USDT` }, 201);
      }
      if (request.method === 'POST' && url.pathname === '/api/withdraw') {
        const b = await body(request); if (!validUserId(b.userId) || !b.walletAddress || !['TRC20','ERC20','BEP20'].includes(b.network)) return json({ error: 'invalid withdrawal data' }, 400);
        const amount = cents(b.amount); if (amount < 1000) return json({ error: 'minimum withdrawal is 10.00 USDT' }, 400);
        const [r] = await sql(env, [{ sql: 'SELECT balance_cents FROM users WHERE user_id=?', args: [b.userId] }]);
        if (!r.rows.length) return json({ error: 'user not found' }, 404); if (Number(r.rows[0][0]) < amount) return json({ error: 'insufficient balance' }, 400);
        const id = crypto.randomUUID();
        try { await sql(env, [{ sql: 'UPDATE users SET balance_cents=balance_cents-?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND balance_cents>=?', args: [amount,b.userId,amount] }, { sql: "INSERT INTO withdrawals(id,user_id,amount_cents,wallet_address,network,status) VALUES(?,?,?,?,?,'pending')", args: [id,b.userId,amount,b.walletAddress,b.network] }]); } catch { return json({ error: 'withdrawal failed' }, 409); }
        return json({ withdrawalId: id, status: 'pending', amount: `${usdt(amount)} USDT` }, 201);
      }
      match = url.pathname.match(/^\/api\/withdrawals\/([^/]+)$/);
      if (request.method === 'GET' && match) { const [r] = await sql(env, [{ sql: 'SELECT id,amount_cents,wallet_address,network,status,transaction_id,created_at FROM withdrawals WHERE user_id=? ORDER BY created_at DESC', args: [match[1]] }]); return json({ withdrawals: r.rows.map(x => ({ id:x[0], amount_cents:x[1], wallet_address:x[2], network:x[3], status:x[4], transaction_id:x[5], created_at:x[6], amount:`${usdt(x[1])} USDT` })) }); }
      match = url.pathname.match(/^\/api\/transaction\/([^/]+)$/);
      if (request.method === 'GET' && match) { const [r] = await sql(env, [{ sql: 'SELECT * FROM transactions WHERE id=?', args: [match[1]] }]); return r.rows.length ? json(r.rows[0]) : json({ error: 'transaction not found' }, 404); }
      return json({ error: 'not found' }, 404);
    } catch (error) { return json({ error: error?.message || 'server error' }, 500); }
  }
};
