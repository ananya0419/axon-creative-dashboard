# Axon Creative Dashboard

Shows which video/playable/endcard creatives are **picking up** or **performing**
right now across all of Felicity Games' currently-LIVE Axon (AppLovin) UA
campaigns, plus a **Recently added** table of everything uploaded to the
creative library in the last 4 weeks.

Live site (once Pages is enabled): `https://<your-github-username>.github.io/<this-repo-name>/`

## How it stays fresh

`.github/workflows/update-data.yml` runs `scripts/build.mjs` on a daily
schedule (07:00 UTC by default — edit the cron line if your team needs it
earlier/later) and whenever you manually trigger it from the **Actions** tab
("Run workflow"). That script:

1. Fetches the account's campaign list and filters to `status = LIVE` —
   the active campaign set is re-resolved on every run, not hardcoded.
2. Pulls the last 30 days of asset-level spend per campaign, plus the
   authoritative day-level campaign totals, from Axon's Reporting API.
3. Computes each creative's daily spend share, flags the ones holding
   >5% of a campaign's day for 3+ straight days, and classifies them as
   **Picking up** / **Performing** / **Fading** (fading ones are dropped).
4. Pulls each asset's `upload_time` from Axon's Management API to build
   the "recently added" list and the "days live" figure.
5. Grabs a poster-frame thumbnail for every video via `ffmpeg`.
6. Writes `docs/final_data_active.json`, `docs/recent_creatives_final.json`,
   `docs/meta.json`, and the poster JPGs — then the workflow commits and
   pushes those if anything changed.

`docs/index.html` is a static page with no build step: it just `fetch()`s
those three JSON files client-side and renders. **It never calls Axon
directly and never contains API keys** — that's exactly why the daily
Action (which runs with secrets, server-side) is necessary.

The **Refresh** button on the page re-fetches those same JSON files (bypassing
the browser cache) and shows a "Data as of ..." timestamp. It updates the page
to whatever the most recent *scheduled or manually-triggered* Action run has
published — it does not kick off a new pull itself. To force a brand new pull
on demand, go to the repo's **Actions → Update creative dashboard data → Run
workflow**; it takes a minute or two, after which Refresh on the page will
pick it up.

## One-time setup

1. **Create the GitHub repo** (you've already decided: new, public).
   On github.com: New repository → name it (e.g. `axon-creative-dashboard`) →
   Public → create (no README/gitignore needed, this folder already has them).

2. **Push this folder:**
   ```bash
   cd axon-creative-dashboard
   git init
   git add .
   git commit -m "Initial dashboard + daily pull workflow"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```

3. **Add the two repo secrets** (Settings → Secrets and variables → Actions →
   New repository secret). Use the same values already in your Axon
   constants memory:
   - `AXON_MANAGEMENT_KEY` — the Campaign Management API key (`ak_...`)
   - `AXON_REPORT_KEY` — the Reporting API key

   Never commit these to the repo — they only ever live in GitHub's
   encrypted secrets store and are injected as env vars during the
   workflow run.

4. **Enable GitHub Pages** (Settings → Pages):
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/docs**
   - Save. GitHub will give you the live URL in a minute or two.

5. **Do a first manual run** to confirm the secrets work and refresh the
   data beyond today's seed snapshot: Actions tab → "Update creative
   dashboard data" → **Run workflow**.

That's it — after this, it updates itself daily with no further action.

## Local development

```bash
AXON_MANAGEMENT_KEY=... AXON_REPORT_KEY=... node scripts/build.mjs
cd docs && npx serve .   # or any static file server
```

## Notes / known tradeoffs

- The dashboard is **public** (per the visibility choice made when this was
  set up) — spend figures and creative names are visible to anyone with the
  link, and the repo/Pages site are not access-controlled. If that changes,
  moving to a private repo requires a paid GitHub plan for Pages (Actions
  still works free either way), or swapping Pages for a different static host.
- "Days live" is based on the asset's upload date to Axon's library, not when
  a specific campaign started serving it — treat it as an upper bound.
- The "Fading" classification silently excludes creatives that qualified
  earlier in the window and have since dropped under 5% share — that's
  intentional (this page is forward-looking), but it means a creative with
  a long, now-cooled-off run won't show up here even though it mattered.
