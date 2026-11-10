import { vote, decide, withdraw } from "../../../../lib/core.js";
import { handler, body, json, currentUser } from "../../../../lib/http.js";

export const dynamic = "force-dynamic";

export const POST = handler(async (req, { params }) => {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) return json({ error: "Unknown edit." }, 404);
  const b = await body(req);
  const user = await currentUser();
  if (b.action === "vote") await vote(user, id, !!b.yes);
  else if (b.action === "approve") await decide(user, id, true);
  else if (b.action === "deny") await decide(user, id, false);
  else if (b.action === "withdraw") await withdraw(user, id);
  else return json({ error: "Unknown action." }, 400);
  return json({ ok: true });
});
