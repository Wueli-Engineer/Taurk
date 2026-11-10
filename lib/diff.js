// Shared by the browser (live cost counter) and the server (the price actually charged).
import { diffChars, structuredPatch, applyPatch } from "diff";
import { RULES } from "./config.js";

export const normalize = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

/**
 * Count the characters an edit adds and deletes.
 * Returns null when the edit is larger than `limit` character operations,
 * so a huge paste can't make the server do unbounded work.
 */
export function measure(before, after, limit) {
  if (before === after) return { added: 0, deleted: 0 };
  const opts = limit != null ? { maxEditLength: Math.max(1, limit) } : undefined;
  const parts = diffChars(before, after, opts);
  if (!parts) return null;
  let added = 0, deleted = 0;
  for (const p of parts) {
    if (p.added) added += p.value.length;
    else if (p.removed) deleted += p.value.length;
  }
  return { added, deleted };
}

export const priceOf = ({ added, deleted }) => added + RULES.deleteMultiplier * deleted;

/** Line hunks describing an edit, used to show diffs and to carry edits onto newer versions. */
export function hunksOf(before, after) {
  return structuredPatch("app", "app", before, after, "", "", { context: 1 }).hunks;
}

/**
 * Re-apply an edit's hunks onto newer code. Returns the new code, or null when
 * the edit touches lines that have since changed (a conflict).
 */
export function rebase(code, hunks) {
  if (!hunks || !hunks.length) return code;
  const out = applyPatch(code, { hunks });
  return out === false ? null : out;
}
