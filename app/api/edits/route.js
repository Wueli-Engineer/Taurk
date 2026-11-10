import { submitEdit } from "../../../lib/core.js";
import { handler, body, json, currentUser } from "../../../lib/http.js";

export const dynamic = "force-dynamic";

export const POST = handler(async (req) => {
  const b = await body(req);
  return json(await submitEdit(await currentUser(), b));
});
