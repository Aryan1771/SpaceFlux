import { createClient } from "@libsql/client";

const databaseUrl = process.env.DATABASE_URL;
const authToken = process.env.DATABASE_AUTH_TOKEN;

if (!databaseUrl || !authToken) {
  throw new Error("Missing DATABASE_URL or DATABASE_AUTH_TOKEN.");
}

export const db = createClient({
  url: databaseUrl,
  authToken
});

export async function queryOne(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] ?? null;
}

export async function queryMany(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}
