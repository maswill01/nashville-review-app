# Nashville List

A tracker for the restaurants, breakfast spots, bars, coffee shops, music venues,
and other places you hit around Nashville. Built to be used on a phone: one screen,
big tap targets, and installable to your home screen.

Everyone has their own account and their own list. Signing up takes an invite code,
so it stays the group of people you actually gave it to.

Two lists in one:

- **Been** — what you visited, rated 1-10, price, notes, whether you'd go back
- **Want to go** — the running list of places you keep hearing about, and who told you

The form follows the status: rating, date visited and "would go back" only appear
once you've been somewhere; "recommended by / source" only appears on the wishlist.

Plus search across names, addresses, notes and tags, filters by type, and sorting.

Ratings run 1-10 rather than five stars, because in practice nobody logs a place
below three and a five-point scale collapses to three usable levels. The anchors
show under the control as you pick — 10 is "I'd take the president here", 5 is
"fine, forgettable", 1 is "absolutely avoid" — so a 7 means the same thing in March
as it did in January. Whether you'd actually return is the separate checkbox: a
place can be an 8 and still not worth the drive.

### Keeping the data clean

Anything you might later filter on is picked, not typed freely:

- **Place name** comes from a place-search provider (see below). One tap fills in
  the name, address, coordinates, and usually the neighborhood, price and type.
  Coordinates are what make a map or a "near me" view possible later, and the
  provider's place id means the same restaurant cannot land on your list twice —
  tapping a place you already have opens the existing entry instead. Two people can
  each have their own entry for the same restaurant, with their own ratings.
- **Neighborhood** is a picker with ~90 Nashville neighborhoods, grouped by area,
  plus "Somewhere else…" for anything missing. Common shorthand is folded onto the
  canonical name on save, so "east nash", "East Side" and "East Nashville" all end
  up as one value rather than three. The list lives in `public/data/nashville.js`.
- **Tags** are chips that autocomplete from tags you've already used, lower-cased
  and de-duplicated, so "Date Night" and "date night" stay one tag.

## Stack

| Piece    | Choice                            | Why                                                     |
| -------- | --------------------------------- | ------------------------------------------------------- |
| Backend  | Node + Express                    | Railway builds it with zero config                      |
| Database | PostgreSQL                        | Persistent, managed by Railway                          |
| Frontend | Plain HTML/CSS/JS served by Express | No build step to break, nothing to keep upgrading      |
| Auth     | Username + password per account   | A small group of friends, each with their own list      |

Two runtime dependencies (`express`, `pg`). That's deliberate — less to patch.

---

## Deployment

Railway, straight from `main` — every merge redeploys. The service runs `npm start`,
Railway health-checks `/api/health`, and the schema applies itself on boot from
`SCHEMA` in `db.js`, so there is no migration step: a new column ships as part of a
normal deploy.

The variables the app needs are documented in `.env.example` — what each one does
and what breaks when it is missing. They live on the app service under
**Variables**, where `DATABASE_URL` is the Railway reference `${{Postgres.DATABASE_URL}}`
rather than a pasted connection string.

---

## Place search

The Name field is a search box backed by a places provider. Picking a result fills
in the address, latitude/longitude, and usually the neighborhood, price and type.
Set **one** of these variables on the app service:

| Variable                 | Provider                  | Trade-off                                                                 |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------- |
| `GOOGLE_PLACES_API_KEY`  | Google Places API (New)   | Best coverage and price levels. The key needs a Google Cloud billing account. |
| `FOURSQUARE_API_KEY`     | Foursquare Places API     | Free tier, no billing setup, and it returns a neighborhood directly.        |

If both are set, Google wins. If neither is set the app still works — the field is
a plain text box and you type the name, with no address or coordinates saved.

Apple MapKit JS is the obvious fourth option and is deliberately not implemented:
it needs an Apple Developer membership plus ES256-signed JWTs minted from a `.p8`
key, which is a lot of moving parts for one search box. Adding it later means one
more function in `place-search.js`.

Two things worth knowing:

- **The key never reaches the browser.** Searches go to `/api/place-search`, which
  is behind the same login as everything else, and the server calls the provider.
  A key embedded in the page would be trivially scrapeable and spendable.
- **Results are cached for five minutes** per query, because the field searches on
  every pause in typing and providers bill per request.

If the provider is down, search fails softly: you get a toast and can still type a
name and save.

---

## Local development

Requires Node 20+ (for `--env-file`) and a local Postgres.

```bash
npm install
cp .env.example .env     # then edit DATABASE_URL and INVITE_CODE
createdb nashville
node --env-file=.env server.js
```

Open http://localhost:3000.

## Backups

Railway keeps the volume alive, but a volume is not a backup — a bad `DELETE` or a
deleted service takes the data with it. To pull a snapshot down, grab the **public**
`DATABASE_URL` from the Postgres service's Variables tab (the one with a
`*.proxy.rlwy.net` host) and:

```bash
pg_dump "<public DATABASE_URL>" > nashville-backup-$(date +%F).sql
```

Worth doing every few months once you have real notes in there.

## API

All endpoints require the login cookie except `/api/health`, `/api/login` and
`/api/signup`. Everything under `/api` is scoped to the account in that cookie.

| Method   | Path               | Notes                                            |
| -------- | ------------------ | ------------------------------------------------ |
| `GET`    | `/api/health`      | Liveness + DB check (Railway's healthcheck)      |
| `POST`   | `/api/login`       | `{ "username": "...", "password": "..." }`       |
| `POST`   | `/api/signup`      | Adds `{ "invite": "..." }` — the invite code     |
| `POST`   | `/api/logout`      |                                                  |
| `GET`    | `/api/meta`        | Whether place search is configured               |
| `GET`    | `/api/places`      | Filters: `status`, `category`, `q`, `sort`       |
| `GET`    | `/api/tags`        | Tags in use with counts, for autocomplete        |
| `GET`    | `/api/place-search`| Proxied provider lookup: `q`                     |
| `POST`   | `/api/places`      | Create — `409` if that place id is already saved |
| `PUT`    | `/api/places/:id`  | Update                                           |
| `DELETE` | `/api/places/:id`  | Delete                                           |
| `GET`    | `/api/stats`       | Counts and average rating                        |

## Accounts

Everyone on the list has their own username and password, and their own places.
Signing up needs the `INVITE_CODE`, so the gate is a code you text a friend rather
than an open form on a public URL. Nothing else is gated: once someone has an
account they can read every other account's list.

Passwords are hashed with `scrypt` from Node's standard library — no native module,
no third dependency. The session is still a signed cookie with no session table
behind it, now carrying the user id and a `token_version`. Bumping a row's
`token_version` invalidates every cookie that account holds, which is how you sign
out a lost phone without logging everyone else out; changing `SESSION_SECRET` is
still the blunt instrument that logs out everybody.

Wrong passwords are rate limited to ten per username per fifteen minutes, in memory,
and a username that does not exist costs the same wall-clock time as one that does,
so the form cannot be used to find out who has an account.

## A note on the security model

This is a shared list among people who know each other. Every account holder can
read every other account's places, notes included — there is no private entry and no
per-field hiding. Notes are not encrypted at rest beyond what Railway provides, and
the invite code is shared rather than per-person, so anyone who has it can pass it
on. That is the right shape for restaurant notes among friends and the wrong shape
for anything you would mind a friend-of-a-friend reading.
