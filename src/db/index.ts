import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://atproto_tailnet:atproto_tailnet@localhost:5432/atproto_tailnet",
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
