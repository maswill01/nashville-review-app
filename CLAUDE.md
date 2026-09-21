# Working rules for this repo

A Nashville places tracker shared by a small group of friends, deployed on Railway
straight from `main`. One owner, several accounts: everyone keeps their own list and
can read everyone else's.

## Workflow: branch, then merge yourself

The owner does not want to review a pull request before every change. Unless they
say otherwise for a specific piece of work:

1. **Branch off the current `main`.** Never commit directly to `main`, and never
   reuse a branch whose pull request is already merged — start a fresh one.
2. **Make the change and verify it** (see *Verifying a change* below).
3. **Open a pull request and merge it yourself**, squash, without waiting for a
   review. The pull request is not a review gate here; it exists so every change
   is one revertable commit on `main` with a "Revert" button in the GitHub UI.
4. **Report what landed**, with the commit SHA.

Deleting the merged branch is the owner's setting to make, not a step here:
GitHub **Settings → General → Automatically delete head branches** cleans them up
on merge. Claude Code sandboxes generally cannot delete a remote branch — the git
relay drops delete-pushes and the GitHub tools expose no branch-delete — so do not
spend turns trying.

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
DATABASE_URL=postgresql://localhost/nashville INVITE_CODE=test SESSION_SECRET=dev \
  OWNER_USERNAME=dev OWNER_PASSWORD=dev-password node server.js
```

`OWNER_USERNAME`/`OWNER_PASSWORD` seed an account on a fresh database so there is
something to log in as; without them the first thing to do is sign up through the
form with the invite code.

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
- **Accounts, but barely.** Username and password per person, scrypt-hashed, signed
  cookie, no session table. Signup needs the shared `INVITE_CODE`. Every account
  holder can read every other account's places and notes — there is no private
  entry, by decision. Do not put anything sensitive in here.
- **Schema lives in `db.js`** and applies itself on boot. There is no migration
  tool; new columns go in as `ADD COLUMN IF NOT EXISTS` so an existing database
  picks them up on the next deploy.

## The code in one pass

Eight source files. Nothing is generated, nothing is bundled, and no file imports
anything you cannot read in this repo except `express` and `pg`.

| File | What lives there |
| ---- | ---------------- |
| `server.js` | The whole backend: the routes, the input coercion, the per-account scoping, static serving. There is no router split on purpose — one file is still the right size. |
| `auth.js` | scrypt password hashing and the signed session cookie. No database and no Express in it: it is the crypto, `server.js` does the SQL. Also the in-memory login throttle. |
| `db.js` | The `pg` pool, two type parsers, and `SCHEMA` — the entire schema, applied on every boot. |
| `place-search.js` | Server-side proxy to Google Places or Foursquare. Holds the provider key and maps their taxonomies onto this app's eight categories. |
| `public/data/nashville.js` | Canonical neighborhoods, their aliases, `normalizeNeighborhood`, `normalizeTags`. **Imported by both the server and the browser.** |
| `public/app.js` | The entire frontend: filter state, whose list you are reading, list rendering, the add/edit sheet, place search, tag entry. No framework, no state library. |
| `public/login.html` | The password page. Posts to `/api/login` and redirects; it shares nothing with `app.js`. |
| `public/index.html` | App shell and the whole form. Every control has an `id` that `app.js` reads by hand. |
| `public/styles.css` | One stylesheet: light palette, then a full `prefers-color-scheme: dark` block that redefines it. |

One request path covers most of the app: `app.js` holds a `state` object, `load()`
turns it into `/api/places?status&category&q&sort`, the server turns that into a
`WHERE`/`ORDER BY`, and the rows come back as JSON for `cardHtml`. **All filtering
and sorting is server-side.** The browser never holds the full list, so a new
filter needs a query parameter, not a client-side `.filter()`.

That is also why viewing a friend's list costs almost nothing: `state.viewing` adds
`?user=` to the same route, and every existing filter keeps working against it.
`viewedUserId` in `server.js` turns that into the `user_id` the `WHERE` clause uses.
Writes never consult it — they use `req.user.id` — so read-only is a property of the
shape rather than a check that can be forgotten on a new route.

`README.md` has the route table, the Railway deploy steps, and the place-search
provider setup. Read it rather than re-deriving any of that.

### The data model

One table, `places`, one row per place. Both statuses live in it.

| Column | Worth knowing |
| ------ | ------------- |
| `name` | The only required field. Everything else is nullable. |
| `category` | `restaurant`, `breakfast`, `bar`, `coffee`, `music`, `activity`, `shop`, `other`. Anything unrecognized falls back to `other` rather than erroring. |
| `status` | `visited` or `wishlist`. Decides which half of the form shows and which columns the server keeps. |
| `rating` | 1–10 to one decimal place, so 8.5 is a score. `NUMERIC(3, 1)`; the buttons cover the whole numbers and the box beside them takes anything in between. Widened from 1–5 in `39a323c`; old rows were left alone, so pre-widening entries read low. Forced null on wishlist rows. |
| `price` | 1–4. |
| `would_return`, `visit_date` | Visited only — the server nulls both on a wishlist row. |
| `source` | Who recommended it. The form only shows it on the wishlist, but it is kept on both statuses so promoting a place to visited does not lose it. |
| `neighborhood` | Passed through `normalizeNeighborhood`. Unrecognized values are kept exactly as typed — custom neighborhoods are allowed. |
| `tags` | One comma-separated `TEXT` column, not a join table. `/api/tags` splits it with `STRING_TO_ARRAY` to build the autocomplete vocabulary, scoped to one person. |
| `user_id` | Who the row belongs to. Nullable in the schema only so the column could land on a database full of rows that predate accounts; `bootstrapOwner` claims those on the next boot. Set once at insert and never reassigned, which is why it is deliberately **not** in `PLACE_COLUMNS`. |
| `lat`, `lng`, `place_provider`, `place_id` | Come from the search provider. Coordinates are stored as a pair or not at all. |

## Adding or changing a field

A field is five files, and skipping any one of them fails quietly rather than
loudly:

1. **`db.js`** — add it to `SCHEMA` as its own
   `ALTER TABLE places ADD COLUMN IF NOT EXISTS`. Do not edit the `CREATE TABLE`
   block; a database that already exists never runs it again.
2. **`server.js`** — add it to `PLACE_COLUMNS` (that array drives the `INSERT`
   columns, the `UPDATE` assignments, and the parameter order) and give it a
   coercion in `normalizePlace`. A column missing from `PLACE_COLUMNS` is simply
   never written, with no error.
3. **`public/index.html`** — the control, with an `id`.
4. **`public/app.js`** — read it in `openSheet` *and* write it into the payload in
   `save`. Do only the second and editing an existing place silently blanks it.
5. **`public/styles.css`** — if it needs styling, check the dark block too.

If the field is something you would ever filter on, it also needs a branch in the
`/api/places` `WHERE` clause and a picker rather than a text box — see *Data
hygiene* below.

## Data hygiene

The whole point of the current form design: anything you might later filter on is
picked, not typed. Neighborhoods come from the canonical list in
`public/data/nashville.js` (shared by the server and the browser), tags autocomplete
from tags already used, and place names come from a search provider so entries carry
coordinates and a stable place id. If you add a new filterable field, give it a
picker, not a text box.

## Things that will bite you

Each of these is load-bearing and none of them looks it:

- **The two type parsers in `db.js`.** `DATE` (oid 1082) is parsed as a raw
  `'YYYY-MM-DD'` string, because node-pg's default `Date` object is local midnight
  and shifts a visit date by a day once serialized to UTC JSON. `NUMERIC` (1700) is
  parsed to a `Number`, because the default ships coordinates to the browser as
  `"36.160000"`. Deleting either line reintroduces a bug that was already fixed.
- **`public/data/nashville.js` must stay free of Node and DOM references.** The
  server imports it off disk; the browser loads the same file over HTTP as
  `/data/nashville.js`. One `process.env` or one `document.` breaks the other side.
  It is also the reason the server imports out of `public/` at all — one canonical
  list, no second copy to drift.
- **Duplicate places are a handshake, not an error, and the handshake is per person.**
  A partial unique index on `(user_id, place_provider, place_id)` catches the same
  search result saved twice by the same person. `POST /api/places` splits on which
  way the clash goes:
  - **Already on your wishlist, saved as visited** — the expected way to use the
    app, not a mistake. The server merges and moves the row (`200`, plus
    `moved_from: 'wishlist'` for the toast). `promoteFromWishlist` lets the
    incoming values win wherever the form had something and keeps the wishlist
    row's otherwise, because the visited half of the form does not show `source`
    and would silently drop it. Tags union and notes keep both halves: the move
    happens without a prompt, so it must not destroy anything.
  - **Any other clash** — `409` *with the existing row attached*, because
    re-rating a place or wishlisting one you have been to would overwrite or null
    a rating nobody asked to lose. `adoptExistingPlace` in `app.js` points the
    open sheet at that row while keeping what was typed, so a second Save updates
    rather than duplicating. It deliberately does not call `openSheet(place)` —
    that repaints every control from the row and throws the entry away, which is
    the bug the split fixed.

  If you touch either side, keep both — and keep the `user_id` in both. The index
  was global before accounts, which would have stopped a second person from ever
  saving a restaurant someone else already had and handed them the other person's
  row to edit.
- **Every read needs a `user_id` in its `WHERE` clause.** `/api/places`, `/api/stats`
  and `/api/tags` all scope to one account; `PUT` and `DELETE` scope to the caller's,
  so someone else's row reads as `404` rather than `403`. A new route that forgets
  this leaks quietly rather than erroring.
- **Rule order in `place-search.js` decides categories.** First match wins —
  breakfast ahead of coffee, bar ahead of restaurant. A new pattern in the wrong
  position silently re-buckets places.
- **`SESSION_SECRET` is the login.** The cookie is
  `HMAC(SESSION_SECRET, 'authenticated:v1')` — there is no session store. Changing
  the secret logs out every device, and that is also the only way to revoke a
  session.
