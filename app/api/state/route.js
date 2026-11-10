import { getState } from "../../../lib/core.js";
import { handler, json, currentUser } from "../../../lib/http.js";

export const dynamic = "force-dynamic";

export const GET = handler(async (req) => {
  const have = new URL(req.url).searchParams.get("have");
  return json(await getState(await currentUser(), have));
});
