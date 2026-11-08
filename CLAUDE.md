# Бюджет по чекам — notes for Claude

Static site on GitHub Pages (published straight from `main`, root folder) + Supabase (Google sign-in, tables with RLS,
private `photos` storage, Edge Function `recognize` that reads receipts with Gemini). Overview for humans: `README.md`.

## Agent team

This repo is worked on by the agent team (rules: `~/.claude/team/PIPELINE.md`). Board project: `cheki`, task prefix `CHK`.

- **Run locally:** `python -m http.server 8765` in the repo root, open http://localhost:8765/.
  In a worktree use another port (8766, 8767, …) so it does not clash with the owner's server.
  `.claude/` is gitignored, so a worktree has no `launch.json`: create `.claude/launch.json` there with your port if you need the preview tools.
- **Sign-in:** almost everything is behind Google sign-in. Agents never sign in through Google themselves.
  Test the signed-out screens and the code paths you can; for signed-in flows ask the owner (via Coordinator) to sign in once
  in the browser pane at your localhost port — the Supabase session then stays in that origin's storage. Otherwise report the flow as not verified.
- **Main flows to regression-test:** sign-in screen renders and links to `privacy.html`; after sign-in the books bar, budget card,
  breakdowns and receipt list render; add a receipt manually; upload a photo (recognition runs in the Edge Function); import a bank statement (CSV/Excel); invite link.
- **File format:** `app.js` and `style.css` use **CRLF** line endings, every other text file uses LF — keep them as they are.
  When you change `style.css` or a script, bump the `?v=N` query in `index.html` for that file so phones do not keep the old cache.
- **Sensitive:** `.env` (service key), `monobank/keys/` and `data/` are gitignored and must never be committed or printed.
  `config.js` holds only the public `anon` key. The privacy policy (`privacy.html`) and the Monobank API application make promises about data —
  any change in what data is collected, stored or sent to third parties needs Security & Privacy and the owner's OK.
- **Deploy:** merging to `main` publishes the site within a minute or two. Supabase changes (SQL in `supabase/*.sql`,
  the `recognize` Edge Function) are deployed separately and only after the owner's OK.
- **Language:** the site UI and README are in Russian; code, commits and PRs are in English.
