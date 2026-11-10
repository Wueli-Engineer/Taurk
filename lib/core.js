// The rules of the site: submitting, voting on, approving and denying edits.
import { db } from "./db.js";
import { RULES } from "./config.js";
import { UserError } from "./auth.js";
import { measure, priceOf, hunksOf, rebase, normalize } from "./diff.js";

// Balances keep fractions to the cent: half of 25 is 12.5.
const share = (n, s) => Math.round(n * s * 100) / 100;
const fmt = (n) => String(Math.round(n * 100) / 100);
const iso = (d) => (d ? new Date(d).toISOString() : null);

async function lockState(t) {
  const { rows } = await t.query("SELECT mode, current_version FROM state WHERE id = 1 FOR UPDATE");
  return rows[0];
}
async function codeOf(t, version) {
  if (!version) return "";
  const { rows } = await t.query("SELECT code FROM versions WHERE id = $1", [version]);
  return rows[0] ? rows[0].code : "";
}
async function lockEdit(t, id) {
  const { rows } = await t.query("SELECT * FROM edits WHERE id = $1 FOR UPDATE", [id]);
  return rows[0] || null;
}
async function close(t, edit, status, refund) {
  await t.query("UPDATE edits SET status = $2, refund = $3, decided_at = now() WHERE id = $1", [edit.id, status, refund]);
  if (refund > 0) await t.query("UPDATE users SET balance = balance + $2 WHERE id = $1", [edit.user_id, refund]);
}

/** Make an edit live, then carry every other pending edit onto the new code or close it as a conflict. */
async function approve(t, st, edit) {
  const current = await codeOf(t, st.current_version);
  const next = edit.base_version === st.current_version ? edit.code : rebase(current, edit.hunks);
  if (next == null || next === current) {
    await close(t, edit, "conflict", share(edit.cost, RULES.deniedRefund));
    return false;
  }
  const { rows } = await t.query("INSERT INTO versions (code, edit_id) VALUES ($1, $2) RETURNING id", [next, edit.id]);
  const v = rows[0].id;
  await t.query("UPDATE state SET current_version = $1 WHERE id = 1", [v]);
  st.current_version = v;
  await close(t, edit, "approved", edit.cost + share(edit.cost, RULES.approvedBonus));

  const others = await t.query("SELECT * FROM edits WHERE status = 'pending' AND id <> $1 ORDER BY id FOR UPDATE", [edit.id]);
  for (const o of others.rows) {
    const moved = rebase(next, o.hunks);
    if (moved == null || moved === next || moved.length > RULES.maxCodeLength) {
      await close(t, o, "conflict", share(o.cost, RULES.deniedRefund));
    } else {
      await t.query("UPDATE edits SET code = $2, base_version = $3, hunks = $4::jsonb WHERE id = $1", [o.id, moved, v, JSON.stringify(hunksOf(next, moved))]);
    }
  }
  return true;
}

async function tally(t, editId) {
  const { rows } = await t.query(
    `SELECT COALESCE(SUM(weight) FILTER (WHERE yes), 0)::float8 AS yes,
            COALESCE(SUM(weight) FILTER (WHERE NOT yes), 0)::float8 AS no
       FROM votes WHERE edit_id = $1`,
    [editId],
  );
  return rows[0];
}
const passes = ({ yes, no }) => yes + no > 0 && yes >= RULES.passShare * (yes + no);

/** Crowd mode: settle every edit whose voting window has ended, oldest first. Caller holds the state lock. */
async function settleDue(t, st) {
  if (st.mode !== "crowd") return;
  const { rows } = await t.query("SELECT id FROM edits WHERE status = 'pending' AND closes_at <= now() ORDER BY closes_at, id");
  for (const { id } of rows) {
    const e = await lockEdit(t, id);
    if (!e || e.status !== "pending") continue; // closed as a conflict by an earlier approval in this loop
    if (passes(await tally(t, id))) await approve(t, st, e);
    else await close(t, e, "denied", share(e.cost, RULES.deniedRefund));
  }
}

export async function settleIfDue() {
  const d = await db();
  const { rows } = await d.query(
    "SELECT 1 FROM edits e, state s WHERE s.mode = 'crowd' AND e.status = 'pending' AND e.closes_at <= now() LIMIT 1",
  );
  if (!rows.length) return;
  await d.tx(async (t) => settleDue(t, await lockState(t)));
}

function needUser(user) {
  if (!user) throw new UserError("Sign in first.", 401);
}

export async function submitEdit(user, { baseVersion, code, note }) {
  needUser(user);
  code = normalize(code);
  note = String(note || "").trim().slice(0, 140);
  if (code.length > RULES.maxCodeLength) throw new UserError(`The app can't be longer than ${RULES.maxCodeLength.toLocaleString()} characters.`);
  const d = await db();
  return d.tx(async (t) => {
    const st = await lockState(t);
    await settleDue(t, st);
    if (Number(baseVersion) !== st.current_version) {
      throw new UserError("The app changed while you were editing. Your draft has been moved onto the new version; check it and submit again.", 409);
    }
    const { rows: [me] } = await t.query("SELECT balance FROM users WHERE id = $1 FOR UPDATE", [user.id]);
    const current = await codeOf(t, st.current_version);
    const balance = Number(me.balance);
    const m = measure(current, code, Math.floor(balance));
    const cost = m ? priceOf(m) : Infinity;
    if (cost === 0) throw new UserError("Change at least one character first.");
    if (cost > balance) throw new UserError(`This edit costs more than your balance of ${fmt(balance)} characters. Make it smaller.`);
    await t.query("UPDATE users SET balance = balance - $2 WHERE id = $1", [user.id, cost]);
    const { rows } = await t.query(
      `INSERT INTO edits (user_id, base_version, code, hunks, added, deleted, cost, note, status, closes_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'pending',
               CASE WHEN $9 = 'crowd' THEN now() + make_interval(hours => $10::int) END)
       RETURNING id`,
      [user.id, st.current_version, code, JSON.stringify(hunksOf(current, code)), m.added, m.deleted, cost, note, st.mode, RULES.voteWindowHours],
    );
    return { id: rows[0].id, cost };
  });
}

export async function vote(user, editId, yes) {
  needUser(user);
  const d = await db();
  return d.tx(async (t) => {
    const st = await lockState(t);
    await settleDue(t, st);
    const e = await lockEdit(t, editId);
    if (!e || e.status !== "pending") throw new UserError("Voting on this edit has closed.", 409);
    if (e.user_id === user.id) throw new UserError("You can't vote on your own edit.");
    const { rows: [me] } = await t.query("SELECT balance FROM users WHERE id = $1", [user.id]);
    await t.query(
      `INSERT INTO votes (edit_id, user_id, yes, weight) VALUES ($1, $2, $3, $4)
       ON CONFLICT (edit_id, user_id) DO UPDATE SET yes = EXCLUDED.yes, weight = EXCLUDED.weight`,
      [editId, user.id, !!yes, Number(me.balance)],
    );
  });
}

export async function decide(user, editId, approveIt) {
  needUser(user);
  if (!user.isOwner) throw new UserError("Only the owner can approve or deny edits directly.", 403);
  const d = await db();
  return d.tx(async (t) => {
    const st = await lockState(t);
    if (st.mode !== "owner") throw new UserError("The crowd is deciding edits now. Take back approval in Owner settings first.", 409);
    const e = await lockEdit(t, editId);
    if (!e) throw new UserError("That edit doesn't exist.", 404);
    if (e.status !== "pending") throw new UserError("This edit has already been decided.", 409);
    if (approveIt) {
      if (!(await approve(t, st, e))) throw new UserError("This edit no longer fits the current code, so it was closed as a conflict.", 409);
    } else {
      await close(t, e, "denied", share(e.cost, RULES.deniedRefund));
    }
  });
}

export async function withdraw(user, editId) {
  needUser(user);
  const d = await db();
  return d.tx(async (t) => {
    await lockState(t);
    const e = await lockEdit(t, editId);
    if (!e || e.user_id !== user.id) throw new UserError("You can only withdraw your own edits.", 403);
    if (e.status !== "pending") throw new UserError("This edit has already been decided.", 409);
    await close(t, e, "withdrawn", share(e.cost, RULES.deniedRefund));
  });
}

export async function setMode(user, mode) {
  needUser(user);
  if (!user.isOwner) throw new UserError("Only the owner can change who approves edits.", 403);
  if (mode !== "owner" && mode !== "crowd") throw new UserError("Unknown mode.");
  const d = await db();
  return d.tx(async (t) => {
    await lockState(t);
    await t.query("UPDATE state SET mode = $1 WHERE id = 1", [mode]);
    if (mode === "crowd") {
      await t.query("UPDATE edits SET closes_at = now() + make_interval(hours => $1::int) WHERE status = 'pending' AND closes_at IS NULL", [RULES.voteWindowHours]);
    } else {
      await t.query("UPDATE edits SET closes_at = NULL WHERE status = 'pending'");
    }
  });
}

/** Everything the page needs. `have` is the version the browser already holds; its code is skipped. */
export async function getState(user, have) {
  await settleIfDue();
  const d = await db();
  const { rows: [st] } = await d.query("SELECT mode, current_version FROM state WHERE id = 1");
  const uid = user ? user.id : 0;
  const [cur, pending, history, mine, me] = await Promise.all([
    d.query(
      `SELECT v.id, v.created_at, u.username, e.added, e.deleted FROM versions v
         LEFT JOIN edits e ON e.id = v.edit_id LEFT JOIN users u ON u.id = e.user_id WHERE v.id = $1`,
      [st.current_version],
    ),
    d.query(
      `SELECT e.id, e.user_id, u.username, e.added, e.deleted, e.cost, e.note, e.hunks, e.created_at, e.closes_at,
              COALESCE(SUM(v.weight) FILTER (WHERE v.yes), 0)::float8 AS yes,
              COALESCE(SUM(v.weight) FILTER (WHERE NOT v.yes), 0)::float8 AS no,
              COUNT(v.user_id)::int AS voters,
              BOOL_OR(v.yes) FILTER (WHERE v.user_id = $1) AS my_vote
         FROM edits e JOIN users u ON u.id = e.user_id LEFT JOIN votes v ON v.edit_id = e.id
        WHERE e.status = 'pending' GROUP BY e.id, u.username ORDER BY e.id`,
      [uid],
    ),
    d.query(
      `SELECT v.id, v.created_at, e.id AS edit_id, u.username, e.added, e.deleted, e.note FROM versions v
         LEFT JOIN edits e ON e.id = v.edit_id LEFT JOIN users u ON u.id = e.user_id ORDER BY v.id DESC LIMIT 40`,
    ),
    uid
      ? d.query("SELECT id, status, cost, refund, decided_at FROM edits WHERE user_id = $1 AND status <> 'pending' ORDER BY decided_at DESC LIMIT 8", [uid])
      : { rows: [] },
    uid ? d.query("SELECT balance FROM users WHERE id = $1", [uid]) : { rows: [] },
  ]);
  const v = cur.rows[0];
  const version = st.current_version;
  return {
    rules: RULES,
    mode: st.mode,
    me: user ? { id: user.id, username: user.username, isOwner: user.isOwner, balance: Number(me.rows[0]?.balance ?? 0) } : null,
    version,
    versionInfo: v ? { at: iso(v.created_at), by: v.username, added: v.added, deleted: v.deleted } : null,
    code: have != null && have !== "" && Number(have) === version ? null : await codeOf(d, version),
    pending: pending.rows.map((e) => ({
      id: e.id, by: e.username, mine: e.user_id === uid, added: e.added, deleted: e.deleted, cost: e.cost, note: e.note,
      hunks: e.hunks, at: iso(e.created_at), closesAt: iso(e.closes_at), yes: e.yes, no: e.no, voters: e.voters,
      myVote: e.my_vote == null ? null : e.my_vote,
    })),
    history: history.rows.map((h) => ({ id: h.id, at: iso(h.created_at), editId: h.edit_id, by: h.username, added: h.added, deleted: h.deleted, note: h.note })),
    mine: mine.rows.map((m) => ({ id: m.id, status: m.status, cost: m.cost, refund: Number(m.refund), at: iso(m.decided_at) })),
  };
}

/** Code for the sandbox: a live version, or a pending edit's proposed code. */
export async function sandboxCode({ version, edit }) {
  const d = await db();
  if (edit != null) {
    const { rows } = await d.query("SELECT code FROM edits WHERE id = $1", [edit]);
    return rows[0] ? rows[0].code : null;
  }
  if (version === 0) return "";
  const { rows } = await d.query("SELECT code FROM versions WHERE id = $1", [version]);
  return rows[0] ? rows[0].code : null;
}
