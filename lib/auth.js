import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";
import { RULES } from "./config.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
export const COOKIE = "tpc_session";

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return salt.toString("hex") + ":" + key.toString("hex");
}
async function checkPassword(pw, stored) {
  const [salt, hex] = String(stored).split(":");
  if (!salt || !hex) return false;
  const key = await scrypt(pw, Buffer.from(salt, "hex"), 64);
  const want = Buffer.from(hex, "hex");
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const ownerEmail = () => (process.env.OWNER_EMAIL || "").trim().toLowerCase();

export async function signup({ username, email, password }) {
  username = String(username || "").trim();
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new UserError("Usernames are 3 to 20 letters, numbers or underscores.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new UserError("Enter a valid email address.");
  if (password.length < 8 || password.length > 200) throw new UserError("Passwords need at least 8 characters.");
  const d = await db();
  const pw = await hashPassword(password);
  try {
    const { rows } = await d.query(
      "INSERT INTO users (username, email, pw_hash, balance) VALUES ($1, $2, $3, $4) RETURNING id",
      [username, email, pw, RULES.startBalance],
    );
    return startSession(rows[0].id);
  } catch (e) {
    if (e && e.code === "23505") {
      throw new UserError(String(e.detail || e.message).includes("email") ? "That email already has an account. Log in instead." : "That username is taken.");
    }
    throw e;
  }
}

export async function login({ email, password }) {
  email = String(email || "").trim().toLowerCase();
  const d = await db();
  const { rows } = await d.query("SELECT id, pw_hash FROM users WHERE email = $1", [email]);
  const ok = rows[0] && (await checkPassword(String(password || ""), rows[0].pw_hash));
  if (!ok) throw new UserError("That email and password don't match.", 401);
  return startSession(rows[0].id);
}

async function startSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const d = await db();
  await d.query("DELETE FROM sessions WHERE expires_at < now()");
  await d.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha(token), userId],
  );
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function logout(token) {
  if (!token) return;
  const d = await db();
  await d.query("DELETE FROM sessions WHERE token_hash = $1", [sha(token)]);
}

/** The signed-in user for a session token, or null. */
export async function userFor(token) {
  if (!token) return null;
  const d = await db();
  const { rows } = await d.query(
    `SELECT u.id, u.username, u.email, u.balance FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha(token)],
  );
  const u = rows[0];
  if (!u) return null;
  return { id: u.id, username: u.username, balance: Number(u.balance), isOwner: !!ownerEmail() && u.email === ownerEmail() };
}
