/**
 * db.ts — MySQL2 pool maxed for 100 teachers + 500 students
 *
 * NEVER concatenate SQL strings. Always use ? placeholders.
 * mysql2 parameterized queries = SQL injection proof by design.
 *
 * USAGE:
 *   import pool, { dbQuery, dbExecute, dbTransaction } from '../db';
 *
 *   // SELECT
 *   const students = await dbQuery<Student>(
 *     'SELECT * FROM students WHERE section_id = ? AND school_year = ?',
 *     [sectionId, schoolYear]
 *   );
 *
 *   // INSERT / UPDATE / DELETE
 *   const result = await dbExecute(
 *     'UPDATE attendance SET status = ? WHERE id = ?',
 *     ['present', id]
 *   );
 *
 *   // Transaction (attendance + SMS queue in one atomic op)
 *   await dbTransaction(async (conn) => {
 *     await conn.execute('INSERT INTO attendance ...', [...]);
 *     await conn.execute('INSERT INTO sms_queue ...', [...]);
 *   });
 */

import mysql, { Pool, PoolOptions, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();


const isProd = process.env.NODE_ENV === 'production';

// ─── Pool config ──────────────────────────────────────────────────────────────
//
// connectionLimit tuning for 500-student / 100-teacher school:
//   - 100 teachers won't all hit DB simultaneously
//   - Realistic concurrent DB queries at period peak: ~25–40
//   - connectionLimit: 30 covers peak + headroom without overloading MySQL
//   - queueLimit: 80 — queue bursts instead of dropping them
//   - waitForConnections: true — never throw "pool exhausted" during burst

const poolConfig: PoolOptions = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'childtrack_hs_db',

  // ── Connection pool ────────────────────────────────────────────────────────
  waitForConnections: true,
  connectionLimit:    isProd ? 30 : 15,  // prod: 30 concurrent, dev: 15
  queueLimit:         80,               // queue up to 80 before rejecting

  // ── Security ──────────────────────────────────────────────────────────────
  multipleStatements: false,   // blocks stacked queries: DROP TABLE attacks
  charset:            'utf8mb4',

  // ── Performance ───────────────────────────────────────────────────────────
  timezone:    '+08:00',       // Philippines PST — no date conversion overhead
  dateStrings: true,           // return dates as strings, not JS Date objects
  connectTimeout: 10_000,      // fail fast if DB unreachable (10s)
  namedPlaceholders: false,    // positional ? is faster than :named

  // ── Keep-alive — prevents "connection lost" on idle school nights ──────────
  enableKeepAlive:       true,
  keepAliveInitialDelay: 30_000,  // send keepalive after 30s idle

  // ── SSL (production remote DB only) ───────────────────────────────────────
  // Supports two env var formats:
  //   DB_SSL_CA_B64 — base64-encoded PEM (preferred, safe in .env files)
  //   DB_SSL_CA     — raw PEM string with literal \n escapes (legacy fallback)
  ...(isProd && (process.env.DB_SSL_CA_B64 || process.env.DB_SSL_CA)
    ? {
        ssl: {
          ca: process.env.DB_SSL_CA_B64
            ? Buffer.from(process.env.DB_SSL_CA_B64, 'base64').toString('utf8')
            : process.env.DB_SSL_CA!.replace(/\\n/g, '\n'),
          rejectUnauthorized: false,
        },
      }
    : {}),
};

const pool: Pool = mysql.createPool(poolConfig);

// ─── Startup validation ───────────────────────────────────────────────────────
(async () => {
  try {
    const conn = await pool.getConnection();

    // Quick schema sanity check — confirms DB is the right one
    const [rows]: any = await conn.query(
      `SELECT
        DATABASE() AS db,
        (SELECT COUNT(*) FROM students) AS studentCount,
        (SELECT COUNT(*) FROM teachers) AS teacherCount,
        @@max_connections AS maxConnections,
        @@innodb_buffer_pool_size AS bufferPool`
    );

    const info = rows[0];
    console.log(`✅ MySQL connected (${isProd ? 'production' : 'local'}) → ${info.db}`);
    console.log(`   Students: ${info.studentCount} | Teachers: ${info.teacherCount}`);
    console.log(`   MySQL max_connections: ${info.maxConnections} | Buffer pool: ${Math.round(info.bufferPool / 1024 / 1024)}MB`);

    // Warn if MySQL max_connections is lower than our pool size
    if (parseInt(info.maxConnections) < poolConfig.connectionLimit!) {
      console.warn(`⚠️  MySQL max_connections (${info.maxConnections}) < pool connectionLimit (${poolConfig.connectionLimit}). Increase max_connections in my.ini.`);
    }

    conn.release();
  } catch (err: any) {
    console.error('❌ MySQL connection failed:', err.message);
    process.exit(1);
  }
})();

// ─── Typed query helpers ──────────────────────────────────────────────────────

/**
 * SELECT queries — always use ? placeholders, never string concat.
 */
export async function dbQuery<T>(
  sql: string,
  params?: (string | number | boolean | null | Date)[]
): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

/**
 * INSERT / UPDATE / DELETE — returns affected rows + insertId.
 */
export async function dbExecute(
  sql: string,
  params?: (string | number | boolean | null | Date)[]
): Promise<ResultSetHeader> {
  const [result] = await pool.execute(sql, params);
  return result as ResultSetHeader;
}

/**
 * Batch INSERT — efficient for saving attendance for 500 students at once.
 * Instead of 500 individual INSERTs, sends 1 query.
 *
 * @example
 *   await dbBulkInsert(
 *     'INSERT INTO attendance (student_id, date, status, section_id) VALUES ?',
 *     rows.map(r => [r.studentId, r.date, r.status, r.sectionId])
 *   );
 */
export async function dbBulkInsert(
  sql: string,
  values: (string | number | boolean | null)[][]
): Promise<ResultSetHeader> {
  const [result] = await pool.query(sql, [values]);
  return result as ResultSetHeader;
}

/**
 * Transaction — wraps multiple queries atomically.
 * Auto-commits on success, auto-rollbacks on any error.
 *
 * Use for: attendance save + SMS queue insert (must both succeed or both fail)
 */
export async function dbTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Paginated query — for large student lists (500 students).
 * Avoids loading all 500 rows at once when only a page is needed.
 *
 * @example
 *   const { rows, total } = await dbPaginate<Student>(
 *     'SELECT * FROM students WHERE section_id = ?',
 *     [sectionId],
 *     { page: 1, pageSize: 50 }
 *   );
 */
export async function dbPaginate<T>(
  sql: string,
  params: (string | number | boolean | null)[],
  options: { page: number; pageSize: number }
): Promise<{ rows: T[]; total: number; pages: number }> {
  const { page, pageSize } = options;
  const offset = (page - 1) * pageSize;

  // Count query — strip ORDER BY for performance
  const countSql = `SELECT COUNT(*) AS total FROM (${sql.replace(/ORDER BY.*/i, '')}) AS _count`;
  const [countRows]: any = await pool.query(countSql, params);
  const total = parseInt(countRows[0]?.total ?? 0);

  // Data query with LIMIT/OFFSET
  const dataSql = `${sql} LIMIT ? OFFSET ?`;
  const [rows] = await pool.query(dataSql, [...params, pageSize, offset]);

  return {
    rows:  rows as T[],
    total,
    pages: Math.ceil(total / pageSize),
  };
}

// ─── Pool event monitoring ────────────────────────────────────────────────────
// Logs pool exhaustion so you know if connectionLimit needs raising

(pool as any).on?.('connection', () => {
  // New connection created — useful to track in dev
});

(pool as any).on?.('enqueue', () => {
  // A request is waiting for a free connection
  console.warn('[DB Pool] All connections in use — request queued. Consider raising connectionLimit.');
});

export default pool;