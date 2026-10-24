import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
