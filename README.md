# The Public Changes

A public website that starts as a blank page. Anyone can sign up and edit the page's code directly, but every character costs them:

- **Adding** a character costs 1 from their balance, and **deleting** one costs 2.
- New accounts start with **50** characters.
- **Approved** edits refund the full cost plus 50%, so good contributors grow their balance.
- **Denied**, withdrawn or conflicting edits refund half the cost.
- At first the **owner approves or denies every edit**. When the owner hands approval to the crowd, each edit is open for **24 hours**. It goes live if at least **51%** of the votes cast, weighted by each voter's balance, say yes. The owner can take approval back at any time.
- Many edits can wait at once. When one goes live, the others are carried onto the new code automatically. Any that touch the same or adjacent lines are closed as conflicts, with a half refund.

All of these numbers live in `lib/config.js`.

## Safety model

The crowd's code is served from `/sandbox` with a `Content-Security-Policy: sandbox` header and shown in a sandboxed iframe. It runs with an opaque origin: it can't read the site's cookies, can't call the site's API as the visitor, can't navigate the page, and can't load anything from the network. Accounts and balances live only on the server. State-changing requests must come from the site's own origin, and session cookies are `HttpOnly` and `SameSite=Strict`.

## Deploy to Vercel

1. Put this folder in a GitHub repository and import it at vercel.com/new. Vercel detects Next.js automatically.
2. In the Vercel project, open **Storage**, create a **Neon Postgres** database and connect it to the project. This sets `DATABASE_URL`.
3. In **Settings → Environment Variables**, add `OWNER_EMAIL` with the email you will sign up with.
4. Deploy, then sign up on the live site with that email. You are the owner.

The tables are created automatically on the first request.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env.local   # then set OWNER_EMAIL
npm run dev                  # http://localhost:3000, data kept in ./.data via PGlite
npm test                     # the economy and approval rules, against an in-memory Postgres
```

## Before handing approval to the crowd

These aren't built yet and matter once strangers decide what goes live:

- **Email verification**, so one person can't farm 50-character starting grants with throwaway accounts.
- **Rate limits** on sign-up and login. Vercel's firewall rules can do this without code.
- **Moderation**: deleting abusive accounts, and an owner rollback to an earlier version.
