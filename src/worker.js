import { createClient } from '@libsql/client/web';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });

function db(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    throw new Error('Database is not configured');
  }

  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN
  });
}

function auth(request, env) {
  const key = request.headers.get('x-api-key');
  return !!(
    env.API_KEY &&
    key &&
    key === env.API_KEY
  );
}

function adminAuth(request, env) {
  const key = request.headers.get('x-admin-key');
  return !!(
    env.ADMIN_INGEST_KEY &&
    key &&
    key === env.ADMIN_INGEST_KEY
  );
}

function validUserId(value) {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{3,80}$/.test(value)
  );
}

function cents(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n < 0 || n > 1000000000000) {
    throw new Error('invalid amount');
  }

  return Math.round(n * 100);
}

function usdt(value) {
  return (Number(value || 0) / 100).toFixed(2);
}

async function body(request) {
  return await request.json().catch(() => ({}));
}

async function init(client) {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      wallet_address TEXT,
      network TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS earnings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      source TEXT NOT NULL,
      provider_event_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      network TEXT NOT NULL,
      status TEXT NOT NULL,
      transaction_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider_ref TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ], 'write');
}

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers':
            'content-type,x-api-key,x-admin-key'
        }
      });
    }

    // Health check بدون API key
    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: 'usdt-wallet-worker'
      });
    }

    // Authentication
    if (!auth(request, env)) {
      return json({
        error: 'authentication required'
      }, 401);
    }

    try {

      const client = db(env);

      await init(client);

      // =========================
      // CREATE USER
      // =========================

      if (
        request.method === 'POST' &&
        url.pathname === '/api/user/create'
      ) {

        const b = await body(request);

        if (!validUserId(b.userId)) {
          return json({
            error: 'invalid userId'
          }, 400);
        }

        await client.execute({
          sql: `
            INSERT OR IGNORE INTO users(user_id)
            VALUES (?)
          `,
          args: [b.userId]
        });

        return json({
          ok: true,
          userId: b.userId
        });
      }

      // =========================
      // GET BALANCE
      // =========================

      const balanceMatch =
        url.pathname.match(/^\/api\/balance\/([^/]+)$/);

      if (
        request.method === 'GET' &&
        balanceMatch
      ) {

        const userId = balanceMatch[1];

        const result = await client.execute({
          sql: `
            SELECT
              user_id,
              balance_cents,
              wallet_address,
              network
            FROM users
            WHERE user_id = ?
          `,
          args: [userId]
        });

        if (!result.rows.length) {
          return json({
            error: 'user not found'
          }, 404);
        }

        const user = result.rows[0];

        return json({
          ok: true,
          userId: user.user_id,
          balance: `${usdt(user.balance_cents)} USDT`,
          balanceUsdt: usdt(user.balance_cents),
          walletAddress: user.wallet_address || null,
          network: user.network || null
        });
      }

      // =========================
      // EARN
      // =========================

      if (
        request.method === 'POST' &&
        url.pathname === '/api/earn'
      ) {

        if (!adminAuth(request, env)) {
          return json({
            error: 'admin authentication required'
          }, 403);
        }

        const b = await body(request);

        if (
          !validUserId(b.userId) ||
          !b.providerEventId ||
          !b.source
        ) {
          return json({
            error:
              'userId, providerEventId and source required'
          }, 400);
        }

        const amount = cents(b.amount);

        if (amount <= 0) {
          return json({
            error: 'amount must be greater than zero'
          }, 400);
        }

        const earningId = crypto.randomUUID();

        try {

          await client.execute({
            sql: `
              INSERT INTO earnings
              (
                id,
                user_id,
                amount_cents,
                source,
                provider_event_id
              )
              VALUES (?, ?, ?, ?, ?)
            `,
            args: [
              earningId,
              b.userId,
              amount,
              b.source,
              b.providerEventId
            ]
          });

          await client.execute({
            sql: `
              UPDATE users
              SET
                balance_cents =
                  balance_cents + ?,
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE user_id = ?
            `,
            args: [
              amount,
              b.userId
            ]
          });

        } catch (e) {

          return json({
            error: 'duplicate or invalid earning'
          }, 409);
        }

        return json({
          ok: true,
          earningId,
          userId: b.userId,
          amount: `${usdt(amount)} USDT`
        }, 201);
      }

      // =========================
      // WITHDRAW
      // =========================

      if (
        request.method === 'POST' &&
        url.pathname === '/api/withdraw'
      ) {

        const b = await body(request);

        if (
          !validUserId(b.userId) ||
          !b.walletAddress ||
          !['TRC20', 'ERC20', 'BEP20'].includes(b.network)
        ) {
          return json({
            error: 'invalid withdrawal data'
          }, 400);
        }

        const amount = cents(b.amount);

        if (amount < 1000) {
          return json({
            error:
              'minimum withdrawal is 10.00 USDT'
          }, 400);
        }

        const result = await client.execute({
          sql: `
            SELECT balance_cents
            FROM users
            WHERE user_id = ?
          `,
          args: [b.userId]
        });

        if (!result.rows.length) {
          return json({
            error: 'user not found'
          }, 404);
        }

        if (
          Number(result.rows[0].balance_cents) <
          amount
        ) {
          return json({
            error: 'insufficient balance'
          }, 400);
        }

        const withdrawalId =
          crypto.randomUUID();

        try {

          await client.execute({
            sql: `
              UPDATE users
              SET
                balance_cents =
                  balance_cents - ?,
                wallet_address = ?,
                network = ?,
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE user_id = ?
              AND balance_cents >= ?
            `,
            args: [
              amount,
              b.walletAddress,
              b.network,
              b.userId,
              amount
            ]
          });

          await client.execute({
            sql: `
              INSERT INTO withdrawals
              (
                id,
                user_id,
                amount_cents,
                wallet_address,
                network,
                status
              )
              VALUES (?, ?, ?, ?, ?, 'pending')
            `,
            args: [
              withdrawalId,
              b.userId,
              amount,
              b.walletAddress,
              b.network
            ]
          });

        } catch (e) {

          return json({
            error: 'withdrawal failed'
          }, 409);
        }

        return json({
          ok: true,
          withdrawalId,
          status: 'pending',
          amount: `${usdt(amount)} USDT`
        }, 201);
      }

      // =========================
      // WITHDRAWAL HISTORY
      // =========================

      const withdrawalMatch =
        url.pathname.match(
          /^\/api\/withdrawals\/([^/]+)$/
        );

      if (
        request.method === 'GET' &&
        withdrawalMatch
      ) {

        const result = await client.execute({
          sql: `
            SELECT
              id,
              amount_cents,
              wallet_address,
              network,
              status,
              transaction_id,
              created_at
            FROM withdrawals
            WHERE user_id = ?
            ORDER BY created_at DESC
          `,
          args: [withdrawalMatch[1]]
        });

        return json({
          ok: true,
          withdrawals:
            result.rows.map(x => ({
              id: x.id,
              amount:
                `${usdt(x.amount_cents)} USDT`,
              walletAddress:
                x.wallet_address,
              network:
                x.network,
              status:
                x.status,
              transactionId:
                x.transaction_id,
              createdAt:
                x.created_at
            }))
        });
      }

      // =========================
      // TRANSACTION
      // =========================

      const transactionMatch =
        url.pathname.match(
          /^\/api\/transaction\/([^/]+)$/
        );

      if (
        request.method === 'GET' &&
        transactionMatch
      ) {

        const result = await client.execute({
          sql: `
            SELECT *
            FROM transactions
            WHERE id = ?
          `,
          args: [transactionMatch[1]]
        });

        if (!result.rows.length) {
          return json({
            error: 'transaction not found'
          }, 404);
        }

        return json({
          ok: true,
          transaction: result.rows[0]
        });
      }

      // =========================
      // NOT FOUND
      // =========================

      return json({
        error: 'not found'
      }, 404);

    } catch (error) {

      return json({
        error:
          error?.message ||
          'server error'
      }, 500);
    }
  }
};
