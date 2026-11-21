/**
 * Last-resort device lock recovery (ADR-0035). It removes trusted devices, recovery codes and sessions.
 * Security: server and database access is the proof of authority.
 * Usage in the app container: node dist/scripts/reset-device-lock.js <handle-or-did>
 */
import { eq, or } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { users, trustedDevices, recoveryCodes, deviceTrustRequests } from "../db/schema.js";

async function main(): Promise<number> {
  const who = process.argv[2];
  if (!who) {
    console.error("usage: reset-device-lock <handle-or-did>");
    return 2;
  }
  const [user] = await db
    .select({ id: users.id, handle: users.handle, did: users.did })
    .from(users)
    .where(or(eq(users.handle, who.replace(/^@/, "")), eq(users.did, who)));
  if (!user) {
    console.error(`no user with handle or DID "${who}"`);
    return 1;
  }
  const devices = await db.delete(trustedDevices).where(eq(trustedDevices.userId, user.id)).returning({ id: trustedDevices.id });
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
  await db.delete(deviceTrustRequests).where(eq(deviceTrustRequests.userId, user.id));
  const sessions = await pool.query(
    `DELETE FROM "session" WHERE sess->>'userId' = $1 OR sess->>'pendingUserId' = $1`,
    [user.id],
  );
  console.log(
    `device lock reset for @${user.handle} (${user.did}): ${devices.length} trusted device(s) removed, ${sessions.rowCount ?? 0} session(s) ended`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
