/**
 * @module db
 * Database connection and Drizzle ORM instance.
 * Exports a pg Pool (for connect-pg-simple sessions) and a typed Drizzle client
 * pre-loaded with the application schema.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { config } from "../config.js";

/** Raw pg connection pool, shared with session middleware and Drizzle. */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

/** Drizzle ORM client bound to the pool and full application schema. */
export const db = drizzle(pool, { schema });

/** TypeScript type for the Drizzle client, useful for dependency injection. */
export type Database = typeof db;
