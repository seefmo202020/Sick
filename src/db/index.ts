import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * No `.env` file is required to run this project.
 *
 * The app falls back to a local PostgreSQL instance automatically.
 * On Bonto (or any host) you only need ONE environment variable:
 *   DATABASE_URL
 * Everything else (Google OAuth keys, base URL) is saved encrypted
 * inside the database from the in-app "ربط القناة و API" page.
 */
const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const databaseUrl = (process.env.DATABASE_URL || DEFAULT_DATABASE_URL).trim();

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool, { schema });
