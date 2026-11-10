// A database created by the first release (whole-number balances, rounded-down rewards)
// must be upgraded once, crediting everyone what rounding withheld.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const dir = mkdtempSync(path.join(tmpdir(), "tpc-migrate-"));
process.env.DATABASE_URL = "pglite:" + dir;
const { SCHEMA } = await import("../lib/db.js");

test("upgrades a first-release database once", async () => {
  // Build the old layout and the state it would be in after approving a 25-character edit.
  const old = new PGlite(dir);
  await old.exec(SCHEMA.replaceAll("NUMERIC(14,2)", "INTEGER"));
  await old.exec(`
    INSERT INTO users (username, email, pw_hash, balance) VALUES ('tyler', 't@example.com', 'x', 62), ('sam', 's@example.com', 'x', 46);
    INSERT INTO edits (user_id, base_version, code, hunks, added, deleted, cost, status, refund)
      VALUES (1, 0, 'a', '[]', 25, 0, 25, 'approved', 37),
             (2, 0, 'b', '[]', 9, 0, 9, 'denied', 4),
             (2, 0, 'c', '[]', 3, 0, 3, 'pending', 0);
  `);
  await old.close();

  const { db, resetDb } = await import("../lib/db.js");
  const bal = async () => (await (await db()).query("SELECT username, balance FROM users ORDER BY id")).rows.map((r) => [r.username, r.balance]);
  assert.deepEqual(await bal(), [["tyler", 62.5], ["sam", 46.5]]);
  const refunds = (await (await db()).query("SELECT status, refund FROM edits ORDER BY id")).rows;
  assert.deepEqual(refunds.map((r) => r.refund), [37.5, 4.5, 0]);

  // Starting again must not credit anyone twice.
  await resetDb();
  assert.deepEqual(await bal(), [["tyler", 62.5], ["sam", 46.5]]);
  await resetDb();
  rmSync(dir, { recursive: true, force: true });
});
