import pg from "pg";

import { env } from "../config/env.js";

const { Pool } = pg;

export type Database = pg.Pool;
export type DatabaseClient = pg.PoolClient | pg.Pool;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

export async function withTransaction<T>(
  db: Database,
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();

  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
