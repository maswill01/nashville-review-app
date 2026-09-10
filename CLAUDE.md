# Working rules for this repo

A personal Nashville places tracker. One owner, one user, deployed on Railway
straight from `main`.

## Workflow: branch, then merge yourself

The owner does not want to review a pull request before every change. Unless they
say otherwise for a specific piece of work:

1. **Branch off the current `main`.** Never commit directly to `main`, and never
   reuse a branch whose pull request is already merged — start a fresh one.
2. **Make the change and verify it** (see *Verifying a change* below).
3. **Open a pull request and merge it yourself**, squash, without waiting for a
   review. The pull request is not a review gate here; it exists so every change
   is one revertable commit on `main` with a "Revert" button in the GitHub UI.
4. **Delete the branch after merging** and report what landed, with the commit SHA.

Merging to `main` deploys to Railway. That is the owner's stated preference — they
would rather see it live and ask for a rollback than review diffs up front.

### Branch names

`<type>/<short-kebab-summary>` — the type says what kind of change it is, the
summary says which change, so a list of branches reads as a changelog.

| Type        | For                                                         |
| ----------- | ----------------------------------------------------------- |
| `feat/`     | new behavior the owner would notice                         |
| `fix/`      | something behaving wrong                                     |
| `refactor/` | restructuring with no behavior change                        |
| `docs/`     | README, this file, comments                                  |
| `chore/`    | dependencies, config, tooling                                |

Good: `feat/map-view`, `fix/date-off-by-one`, `chore/bump-express`.
Bad: `updates`, `claude/kind-thompson-c7ucav`, `fix/stuff`.

## Rolling back

Every change is one squashed commit on `main`, so a rollback is one revert:

```bash
git revert <sha> && git push origin main
```

Or hit **Revert** on the merged pull request in GitHub.

**Reverting code does not revert the database.** The schema is applied on boot from
`SCHEMA` in `db.js` using `ADD COLUMN IF NOT EXISTS`, so:

- Adding a column is safe to roll back — the column stays behind, unused and empty.
- **Dropping or renaming a column is not.** The data is gone and a code revert will
  not bring it back. Ask the owner before writing a migration that drops, renames,
  or rewrites existing column data, even though every other change here is
  auto-merged. That is the one exception to merging without asking.

## Verifying a change

There is no test suite and no CI — no `.github/workflows`, so nothing checks a push
but you. Verify before merging, because merging deploys.

Run the app against a scratch Postgres:

```bash
npm install
createdb nashville
DATABASE_URL=postgresql://localhost/nashville APP_PASSWORD=test SESSION_SECRET=dev \
  node server.js
```

Then exercise what you changed — `curl` the API, or drive the UI with Playwright
(Chromium is available in the Claude Code sandbox) and check the sheet at phone
width, ~390px. It is a phone app first; a change that only looks right on a desktop
viewport is not verified.

Check both themes when touching CSS. The stylesheet has a full
`prefers-color-scheme: dark` palette and it is easy to add a color that only works
in light mode.

## What this project is, and what it deliberately is not

- **Two runtime dependencies**, `express` and `pg`. That is a deliberate ceiling —
  less to patch on an app nobody is maintaining full time. Do not add a dependency
  without asking; there is almost always a standard-library way.
- **No build step.** `public/` is served as-is. Plain ES modules in the browser, no
  bundler, no transpiler, no framework. Keep it that way.
- **Single shared password**, HMAC cookie, no user accounts. Appropriate for a list
  of restaurants on a URL nobody knows. Do not put anything sensitive in here.
- **Schema lives in `db.js`** and applies itself on boot. There is no migration
  tool; new columns go in as `ADD COLUMN IF NOT EXISTS` so an existing database
  picks them up on the next deploy.

## Data hygiene

The whole point of the current form design: anything you might later filter on is
picked, not typed. Neighborhoods come from the canonical list in
`public/data/nashville.js` (shared by the server and the browser), tags autocomplete
from tags already used, and place names come from a search provider so entries carry
coordinates and a stable place id. If you add a new filterable field, give it a
picker, not a text box.
