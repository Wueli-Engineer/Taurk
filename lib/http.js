import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE, UserError, userFor } from "./auth.js";

export async function currentUser() {
  const jar = await cookies();
  return userFor(jar.get(COOKIE)?.value);
}

export async function sessionToken() {
  const jar = await cookies();
  return jar.get(COOKIE)?.value;
}

export const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

// State-changing requests must come from this site's own pages (blocks cross-site form posts).
function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") || req.headers.get("host"));
  } catch {
    return false;
  }
}

export function handler(fn) {
  return async (req, ctx) => {
    try {
      if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "Requests must come from this site." }, 403);
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  };
}

export async function body(req) {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}

export function setSession(res, session) {
  res.cookies.set(COOKIE, session ? session.token : "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session ? session.maxAge : 0,
  });
  return res;
}
