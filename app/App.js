"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { measure, priceOf, hunksOf, rebase, normalize } from "../lib/diff.js";

const SANDBOX = "allow-scripts allow-forms allow-modals allow-pointer-lock";
const POLL_MS = 6000;
const CLIENT_DIFF_LIMIT = 20000;

async function api(path, payload) {
  const res = await fetch(path, payload === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || "The server didn't answer. Check your connection and try again."); e.status = res.status; throw e; }
  return data;
}

// Balances can hold fractions (62.5); show at most two decimals, none when whole.
const chars = (n) => String(Math.round(Number(n) * 100) / 100);

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(iso).toLocaleDateString();
}
function left(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "closing";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + "h " : "") + m + "m left";
}

function Diff({ hunks }) {
  if (!hunks || !hunks.length) return null;
  return (
    <div className="diff" role="figure" aria-label="Lines changed">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="hunk">line {h.newStart}</div>
          {h.lines.filter((l) => l[0] !== "\\").map((l, j) => (
            <div key={j} className={l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx"}>
              <span className="sign">{l[0] === " " ? "" : l[0]}</span>{l.slice(1) || " "}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Tally({ e, rules, mode }) {
  const total = e.yes + e.no;
  const pct = total ? Math.round((e.yes / total) * 100) : 0;
  return (
    <div className="tally">
      <div className="meter" role="img" aria-label={`${pct}% of weighted votes say yes, ${Math.round(rules.passShare * 100)}% needed`}>
        <i style={{ width: pct + "%" }} />
        <b style={{ left: rules.passShare * 100 + "%" }} />
      </div>
      <span className="small muted num">
        {e.voters ? `${e.voters} ${e.voters === 1 ? "vote" : "votes"} · ${pct}% yes by weight` : "No votes yet"}
        {mode === "owner" ? " · advisory" : ""}
      </span>
    </div>
  );
}

export default function App() {
  const [s, setS] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [code, setCode] = useState("");
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState(null);
  const [stale, setStale] = useState(false);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState("edit");
  const [view, setView] = useState(null); // {kind: "edit"|"version"|"draft", id}
  const [msg, setMsg] = useState(null); // {text, bad}
  const [busy, setBusy] = useState(false);
  const [confirmMode, setConfirmMode] = useState(false);
  const versionRef = useRef(null), codeRef = useRef(""), draftRef = useRef(""), baseRef = useRef(null);
  draftRef.current = draft; baseRef.current = base;

  const refresh = useCallback(async () => {
    try {
      const data = await api("/api/state?have=" + (versionRef.current ?? ""));
      if (data.code != null) {
        const oldCode = codeRef.current, newCode = data.code, d = draftRef.current;
        const dirty = versionRef.current != null && d !== oldCode;
        if (!dirty) { setDraft(newCode); setBase(data.version); setStale(false); }
        else {
          const moved = rebase(newCode, hunksOf(oldCode, d));
          if (moved != null) { setDraft(moved); setBase(data.version); setStale(false); }
          else setStale(true); // keep the draft; submitting will be refused until they reset
        }
        codeRef.current = newCode; versionRef.current = data.version; setCode(newCode);
      }
      setS(data); setLoadErr("");
    } catch (e) {
      setLoadErr(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

  // Live price of the draft, recomputed shortly after typing pauses.
  const [m, setM] = useState({ added: 0, deleted: 0 });
  useEffect(() => {
    const t = setTimeout(() => setM(measure(code, normalize(draft), CLIENT_DIFF_LIMIT)), 120);
    return () => clearTimeout(t);
  }, [code, draft]);
  const cost = m ? priceOf(m) : null;

  async function act(fn, ok) {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ text: ok }); await refresh(); }
    catch (e) { setMsg({ text: e.message, bad: true }); if (e.status === 409) await refresh(); }
    finally { setBusy(false); }
  }

  const me = s?.me, rules = s?.rules, mode = s?.mode;
  const pendingCount = s?.pending.length ?? 0;
  const blank = s && s.version === 0;

  const stageSrc = useMemo(() => {
    if (!s) return null;
    if (view?.kind === "edit") return "/sandbox?edit=" + view.id;
    if (view?.kind === "version") return "/sandbox?v=" + view.id;
    if (view?.kind === "draft") return null;
    return "/sandbox?v=" + s.version;
  }, [s, view]);

  function submit(e) {
    e.preventDefault();
    if (!me) return setTab("account");
    act(async () => {
      const r = await api("/api/edits", { baseVersion: base, code: normalize(draft), note });
      setNote(""); setDraft(codeRef.current); setView(null);
      setMsg({ text: `Edit #${r.id} submitted. ${r.cost} characters are held until it's decided.` });
      setTab("pending");
    });
  }
  function onKey(e) {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const t = e.target; t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end");
      setDraft(t.value);
    }
  }

  const viewing = view && (view.kind === "draft" ? "your draft" : view.kind === "edit" ? `proposed edit #${view.id}` : `version ${view.id}`);

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <strong>The Public Changes</strong>
          <span className="small muted num">
            {s ? (s.version ? `version ${s.version}` : "blank") + ` · ${pendingCount} pending · ${mode === "crowd" ? "the crowd decides" : "the owner decides"}` : "loading"}
          </span>
        </div>
        <div className="who">
          {me ? (
            <>
              <span className="balance num" title="Your character balance">{chars(me.balance)} chars</span>
              <span className="small">{me.username}{me.isOwner ? " · owner" : ""}</span>
              <button className="btn quiet small" onClick={() => act(() => api("/api/auth", { action: "logout" }))}>Log out</button>
            </>
          ) : (
            <button className="btn small" onClick={() => setTab("account")}>Sign up or log in</button>
          )}
        </div>
      </header>

      <main className="stage">
        {viewing && (
          <div className="viewing">
            <span>Previewing {viewing}. Only you see this.</span>
            <button className="btn quiet small" onClick={() => setView(null)}>Back to live</button>
          </div>
        )}
        {view?.kind === "draft" ? (
          <iframe key="draft" title="Preview of your draft" sandbox={SANDBOX} srcDoc={draft} />
        ) : stageSrc ? (
          <iframe key={stageSrc} title="The app everyone is building" sandbox={SANDBOX} src={stageSrc} />
        ) : null}
        {blank && !view && (
          <div className="blank">
            <h1>This page is empty.</h1>
            <p>It becomes whatever people build here, a few characters at a time. Every character you add costs one from your balance; every character you delete costs {rules?.deleteMultiplier ?? 2}.</p>
            <button className="btn" onClick={() => { setTab(me ? "edit" : "account"); document.getElementById("draft")?.focus(); }}>
              {me ? "Write the first characters" : "Sign up to write the first characters"}
            </button>
          </div>
        )}
        {loadErr && <div className="err">{loadErr}</div>}
      </main>

      <aside className="side">
        <nav className="tabs" role="tablist">
          {[["edit", "Edit"], ["pending", `Pending (${pendingCount})`], ["history", "History"], me?.isOwner && ["owner", "Owner"], !me && ["account", "Account"]]
            .filter(Boolean).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); setMsg(null); }}>{label}</button>
            ))}
        </nav>
        {msg && <p className={"msg" + (msg.bad ? " bad" : "")} role="status">{msg.text}</p>}

        {tab === "edit" && (
          <form className="pane edit" onSubmit={submit}>
            <p className="small muted">
              This is the whole app's code. Change it, then submit your edit for approval. Small edits are cheap: adding a character costs 1, deleting one costs {rules?.deleteMultiplier ?? 2}.
            </p>
            {stale && (
              <p className="msg bad">The app changed and your draft now overlaps the new code. <button type="button" className="link" onClick={() => { setDraft(code); setBase(s.version); setStale(false); }}>Start again from the latest version</button></p>
            )}
            <textarea id="draft" className="code" value={draft} spellCheck={false} autoCapitalize="off" autoComplete="off"
              aria-label="The app's code" placeholder={"<!doctype html>\n<h1>Hello</h1>"}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
            <div className="price num">
              {cost == null ? <span className="bad-t">More than {CLIENT_DIFF_LIMIT.toLocaleString()} characters changed</span> : (
                <>
                  <span className="add-t">+{m.added}</span>
                  <span className="del-t">−{m.deleted}{m.deleted ? ` ×${rules?.deleteMultiplier ?? 2}` : ""}</span>
                  <span>= <b>{cost}</b>{me ? ` of your ${chars(me.balance)}` : ""}</span>
                </>
              )}
            </div>
            <input className="note" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder="What does this edit do? (optional)" aria-label="Short description of the edit" />
            <div className="row">
              <button className="btn" disabled={busy || stale || !cost || (me && cost > me.balance)}>
                {!me ? "Sign up to submit" : me && cost > me.balance ? "Not enough characters" : "Submit edit"}
              </button>
              <button type="button" className="btn quiet" disabled={draft === code} onClick={() => setView({ kind: "draft" })}>Preview</button>
              <button type="button" className="btn quiet" disabled={draft === code} onClick={() => { setDraft(code); setView(null); }}>Reset</button>
            </div>
          </form>
        )}

        {tab === "pending" && (
          <div className="pane">
            <p className="small muted">
              {mode === "crowd"
                ? `Each edit is open for ${rules.voteWindowHours} hours. It goes live if at least ${Math.round(rules.passShare * 100)}% of the votes cast, weighted by each voter's balance, say yes.`
                : "The owner approves or denies every edit for now. Votes are shown to help them decide."}
            </p>
            {!s?.pending.length && <p className="empty">No edits are waiting. Change something in the Edit tab.</p>}
            <ul className="cards">
              {s?.pending.map((e) => (
                <li key={e.id} className="card">
                  <div className="row between">
                    <strong>#{e.id} by {e.by}{e.mine ? " (you)" : ""}</strong>
                    <span className="small muted num">{mode === "crowd" && e.closesAt ? left(e.closesAt) : ago(e.at)}</span>
                  </div>
                  {e.note && <p className="enote">{e.note}</p>}
                  <span className="small num"><span className="add-t">+{e.added}</span> <span className="del-t">−{e.deleted}</span> · costs {e.cost}</span>
                  <Diff hunks={e.hunks} />
                  <Tally e={e} rules={rules} mode={mode} />
                  <div className="row">
                    <button className="btn quiet small" onClick={() => setView({ kind: "edit", id: e.id })}>Preview</button>
                    {me && !e.mine && (
                      <>
                        <button className={"btn quiet small" + (e.myVote === true ? " picked" : "")} aria-pressed={e.myVote === true} disabled={busy} onClick={() => act(() => api(`/api/edits/${e.id}`, { action: "vote", yes: true }))}>Yes</button>
                        <button className={"btn quiet small" + (e.myVote === false ? " picked" : "")} aria-pressed={e.myVote === false} disabled={busy} onClick={() => act(() => api(`/api/edits/${e.id}`, { action: "vote", yes: false }))}>No</button>
                      </>
                    )}
                    {me?.isOwner && mode === "owner" && (
                      <>
                        <button className="btn small" disabled={busy} onClick={() => act(() => api(`/api/edits/${e.id}`, { action: "approve" }), `Edit #${e.id} is live.`)}>Approve</button>
                        <button className="btn danger small" disabled={busy} onClick={() => act(() => api(`/api/edits/${e.id}`, { action: "deny" }), `Edit #${e.id} denied.`)}>Deny</button>
                      </>
                    )}
                    {e.mine && <button className="btn quiet small" disabled={busy} onClick={() => act(() => api(`/api/edits/${e.id}`, { action: "withdraw" }), `Edit #${e.id} withdrawn. Half its cost came back.`)}>Withdraw</button>}
                  </div>
                </li>
              ))}
            </ul>
            {!!s?.mine.length && (
              <>
                <h3>Your decided edits</h3>
                <ul className="plain small">
                  {s.mine.map((x) => (
                    <li key={x.id} className="num">#{x.id} {x.status === "conflict" ? "closed (overlapped a newer change)" : x.status} · {x.refund >= x.cost ? `+${chars(x.refund - x.cost)} earned` : `${chars(x.refund)} of ${x.cost} back`} · {ago(x.at)}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="pane">
            <ul className="plain">
              {s?.history.map((h) => (
                <li key={h.id} className="hist">
                  <div>
                    <strong className="num">v{h.id}</strong> <span className="small">by {h.by || "someone"} · <span className="add-t">+{h.added}</span> <span className="del-t">−{h.deleted}</span> · {ago(h.at)}</span>
                    {h.note && <div className="small muted">{h.note}</div>}
                  </div>
                  {h.id !== s.version && <button className="btn quiet small" onClick={() => setView({ kind: "version", id: h.id })}>View</button>}
                </li>
              ))}
              <li className="hist"><div><strong>v0</strong> <span className="small muted">the blank page</span></div></li>
            </ul>
          </div>
        )}

        {tab === "owner" && me?.isOwner && (
          <div className="pane">
            <h3>Who approves edits</h3>
            <p>{mode === "owner" ? "You do. Every edit waits for your Approve or Deny." : `The crowd does. Edits are open for ${rules.voteWindowHours} hours and need ${Math.round(rules.passShare * 100)}% of weighted votes.`}</p>
            {!confirmMode ? (
              <button className="btn" onClick={() => setConfirmMode(true)}>{mode === "owner" ? "Hand approval to the crowd" : "Take approval back"}</button>
            ) : (
              <div className="confirm">
                <p className="small">{mode === "owner"
                  ? `Pending edits will get a ${rules.voteWindowHours}-hour voting window starting now. You can take approval back at any time.`
                  : "Voting windows stop. Pending edits will wait for your decision."}</p>
                <div className="row">
                  <button className="btn" disabled={busy} onClick={() => act(async () => { await api("/api/settings", { mode: mode === "owner" ? "crowd" : "owner" }); setConfirmMode(false); }, mode === "owner" ? "The crowd now decides." : "You decide again.")}>Confirm</button>
                  <button className="btn quiet" onClick={() => setConfirmMode(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "account" && !me && <Account rules={rules} onDone={async (t) => { setMsg({ text: t }); await refresh(); setTab("edit"); }} />}
      </aside>
    </div>
  );
}

function Account({ rules, onDone }) {
  const [isNew, setIsNew] = useState(true);
  const [f, setF] = useState({ username: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      await api("/api/auth", { action: isNew ? "signup" : "login", ...f });
      await onDone(isNew ? `Welcome. You have ${rules?.startBalance ?? 50} characters to spend.` : "Logged in.");
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="pane account" onSubmit={go}>
      <h3>{isNew ? "Create an account" : "Log in"}</h3>
      {isNew && <p className="small muted">You start with {rules?.startBalance ?? 50} characters. Approved edits earn them back plus {Math.round((rules?.approvedBonus ?? 0.5) * 100)}%.</p>}
      {isNew && <label>Username<input id="username" value={f.username} onChange={set("username")} autoComplete="username" required /></label>}
      <label>Email<input id="email" type="email" value={f.email} onChange={set("email")} autoComplete="email" required /></label>
      <label>Password<input id="password" type="password" value={f.password} onChange={set("password")} autoComplete={isNew ? "new-password" : "current-password"} minLength={isNew ? 8 : undefined} required /></label>
      {err && <p className="msg bad">{err}</p>}
      <div className="row">
        <button className="btn" disabled={busy}>{isNew ? "Create account" : "Log in"}</button>
        <button type="button" className="link" onClick={() => { setIsNew(!isNew); setErr(""); }}>{isNew ? "I already have an account" : "I need an account"}</button>
      </div>
    </form>
  );
}
