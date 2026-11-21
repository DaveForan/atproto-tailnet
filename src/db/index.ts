/**
 * @module db
 * The pg Pool (shared with connect-pg-simple sessions) and the typed Drizzle client.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { config } from "../config.js";

/** Raw pg connection pool, shared with session middleware and Drizzle. */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
