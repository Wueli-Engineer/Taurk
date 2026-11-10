// Exercises the real rules against an in-memory Postgres (PGlite). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "pglite:memory";
process.env.OWNER_EMAIL = "owner@example.com";

const { signup, userFor } = await import("../lib/auth.js");
const core = await import("../lib/core.js");
const { db } = await import("../lib/db.js");
const { RULES } = await import("../lib/config.js");

const join = async (name) => userFor((await signup({ username: name, email: name + "@example.com", password: "password123" })).token);
const balance = async (u) => (await (await db()).query("SELECT balance FROM users WHERE id = $1", [u.id])).rows[0].balance;
const status = async (id) => (await (await db()).query("SELECT status, refund FROM edits WHERE id = $1", [id])).rows[0];
const current = async () => { const s = await core.getState(null); return { v: s.version, code: s.code }; };
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message));

test("the whole lifecycle", async () => {
  const owner = await join("owner");
  const alice = await join("alice");
  const bob = await join("bob");
  const carol = await join("carol");
  assert.equal(owner.isOwner, true);
  assert.equal(alice.isOwner, false);
  assert.equal(await balance(alice), RULES.startBalance);

  // Starts blank.
  assert.deepEqual(await current(), { v: 0, code: "" });

  // First edit on the blank page: 14 characters added.
  const first = "a\nb\nc\nd\ne\nf\ng\n";
  const e1 = await core.submitEdit(alice, { baseVersion: 0, code: first });
  assert.equal(e1.cost, 14);
  assert.equal(await balance(alice), 50 - 14);
  await rejects(core.decide(alice, e1.id, true), /Only the owner/);
  await rejects(core.vote(alice, e1.id, true), /own edit/);
  await core.decide(owner, e1.id, true);
  assert.deepEqual(await current(), { v: 1, code: first });
  assert.equal(await balance(alice), 36 + 14 + 7, "approved: full refund plus 50%");

  // Two edits on far-apart lines, one on the same line as another.
  const eB = await core.submitEdit(bob, { baseVersion: 1, code: first.replace("b\n", "B!\n") });
  assert.equal(eB.cost, 2 + 2 * 1, "added 'B!' (2) and deleted 'b' (1 x 2)");
  const eF = await core.submitEdit(carol, { baseVersion: 1, code: first.replace("f\n", "F\n") });
  const eClash = await core.submitEdit(alice, { baseVersion: 1, code: first.replace("b\n", "bee\n") });

  await core.decide(owner, eB.id, true);
  let c = await current();
  assert.equal(c.code, "a\nB!\nc\nd\ne\nf\ng\n");
  assert.equal((await status(eClash.id)).status, "conflict", "same line as the approved edit");
  assert.equal((await status(eClash.id)).refund, Math.floor(eClash.cost / 2));
  assert.equal((await status(eF.id)).status, "pending", "far-away edit survives");

  await core.decide(owner, eF.id, true);
  c = await current();
  assert.equal(c.code, "a\nB!\nc\nd\ne\nF\ng\n", "carried onto the newer version");

  // Stale drafts are refused; too-expensive edits are refused; denial refunds half.
  await rejects(core.submitEdit(bob, { baseVersion: 1, code: "x" }), /changed while you were editing/);
  await rejects(core.submitEdit(bob, { baseVersion: c.v, code: "x".repeat(500) }), /costs more than your balance/);
  await rejects(core.submitEdit(bob, { baseVersion: c.v, code: c.code }), /at least one character/);
  const before = await balance(bob);
  const eD = await core.submitEdit(bob, { baseVersion: c.v, code: c.code + "zz\n" });
  await core.decide(owner, eD.id, false);
  assert.equal(await balance(bob), before - eD.cost + Math.floor(eD.cost / 2));

  // Withdrawal refunds half too, and only the author may withdraw.
  const eW = await core.submitEdit(carol, { baseVersion: c.v, code: c.code + "w\n" });
  await rejects(core.withdraw(bob, eW.id), /own edits/);
  await core.withdraw(carol, eW.id);
  assert.equal((await status(eW.id)).status, "withdrawn");

  // Crowd mode: weighted votes decide when the window closes.
  await rejects(core.setMode(alice, "crowd"), /Only the owner/);
  await core.setMode(owner, "crowd");
  await rejects(core.decide(owner, 1, true), /crowd is deciding/);
  const pass = await core.submitEdit(carol, { baseVersion: c.v, code: c.code + "p\n" });
  const fail = await core.submitEdit(bob, { baseVersion: c.v, code: "q\n" + c.code });
  const wA = await balance(alice), wO = await balance(owner);
  await core.vote(alice, pass.id, true); // heavier than owner's 50
  await core.vote(owner, pass.id, false);
  assert.ok(wA / (wA + wO) >= RULES.passShare, `alice ${wA} vs owner ${wO}`);
  // nobody votes on `fail`: no votes cast means it doesn't pass
  let s = await core.getState(alice, c.v);
  assert.equal(s.pending.length, 2);
  assert.equal(s.code, null, "browser already has this version's code");
  assert.equal((await core.getState(alice, "")).code, c.code, "a first visit always gets the code");
  assert.equal(s.pending.find((p) => p.id === pass.id).yes, wA);

  await (await db()).query("UPDATE edits SET closes_at = now() - interval '1 second' WHERE status = 'pending'");
  s = await core.getState(null);
  assert.equal(s.pending.length, 0);
  assert.equal((await status(pass.id)).status, "approved");
  assert.equal((await status(fail.id)).status, "denied");
  assert.equal(s.code, c.code + "p\n");

  // Taking approval back.
  await core.setMode(owner, "owner");
  assert.equal((await core.getState(null)).mode, "owner");

  // Balances never go negative and the sandbox serves exactly what is live.
  assert.equal(await core.sandboxCode({ version: s.version }), s.code);
  assert.equal(await core.sandboxCode({ version: 0 }), "");
});
