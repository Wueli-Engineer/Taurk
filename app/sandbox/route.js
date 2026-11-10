// Serves the crowd's code. The CSP `sandbox` directive gives it an opaque origin even if
// someone opens this URL directly, so it can never read the site's cookies or call its API
// as the visitor. It also can't load anything from the network.
import { sandboxCode } from "../../lib/core.js";

export const dynamic = "force-dynamic";

const CSP = [
  "sandbox allow-scripts allow-forms allow-modals allow-pointer-lock",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const edit = p.has("edit") ? Number(p.get("edit")) : null;
  const version = p.has("v") ? Number(p.get("v")) : null;
  const bad = (edit != null && !(Number.isInteger(edit) && edit > 0)) || (edit == null && !(Number.isInteger(version) && version >= 0));
  let code = null;
  try {
    code = bad ? null : await sandboxCode({ version, edit });
  } catch (e) {
    console.error(e);
  }
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    // Live versions never change, so they can be cached; pending edits can be moved onto newer code.
    "Cache-Control": edit == null && code != null ? "public, max-age=31536000, immutable" : "no-store",
  };
  if (code == null) return new Response("Not found", { status: 404, headers: { ...headers, "Content-Type": "text/plain" } });
  return new Response(code, { headers });
}
