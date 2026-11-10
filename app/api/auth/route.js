import { signup, login, logout } from "../../../lib/auth.js";
import { handler, body, json, setSession, sessionToken } from "../../../lib/http.js";

export const dynamic = "force-dynamic";

export const POST = handler(async (req) => {
  const b = await body(req);
  if (b.action === "signup") return setSession(json({ ok: true }), await signup(b));
  if (b.action === "login") return setSession(json({ ok: true }), await login(b));
  if (b.action === "logout") {
    await logout(await sessionToken());
    return setSession(json({ ok: true }), null);
  }
  return json({ error: "Unknown action." }, 400);
});
