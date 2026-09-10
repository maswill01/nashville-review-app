# Nashville List

A personal tracker for the restaurants, bars, coffee shops, music venues, and other
places you hit around Nashville. Built to be used on a phone: one screen, big tap
targets, and installable to your home screen.

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
  provider's place id means the same restaurant cannot be added twice — tapping a
  place you already have opens the existing entry instead.
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
| Auth     | One shared password               | It's a single-user app on a public URL                  |

Two runtime dependencies (`express`, `pg`). That's deliberate — less to patch.

---

## Deploying on Railway

### 1. Push this repo to GitHub

Already done if you're reading this on GitHub.

### 2. Create the Railway project

1. Go to [railway.com](https://railway.com) and sign in with GitHub.
2. **New Project → Deploy from GitHub repo → `nashville-review-app`**.
3. Railway detects Node, runs `npm install`, and starts it with `npm start`.

The first deploy **will fail** — there's no database yet. That's expected.

### 3. Add the database

1. In the project canvas, click **+ New → Database → Add PostgreSQL**.
2. Railway provisions Postgres with a persistent volume attached. Your data
   survives redeploys and restarts; it is only lost if you delete that service.

### 4. Set the environment variables

Click your **app service** (not the Postgres one) → **Variables** → add these three:

| Variable         | Value                                                            |
| ---------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`   | `${{Postgres.DATABASE_URL}}`                                     |
| `APP_PASSWORD`   | whatever password you want to type on your phone                 |
| `SESSION_SECRET` | a long random string                                             |

Optionally add a place-search key here too — see [Place search](#place-search).

`${{Postgres.DATABASE_URL}}` is a Railway *reference variable* — type it exactly
like that, braces included. Railway resolves it to the real connection string and
keeps it correct if the database is ever recreated. Don't paste the raw URL.

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If `APP_PASSWORD` is missing, the app runs with **no login at all** and anyone with
the URL can read and edit your data. If `SESSION_SECRET` is missing, the app works
but logs you out on every redeploy.

### 5. Give it a URL

App service → **Settings → Networking → Generate Domain**. You get something like
`nashville-review-app-production.up.railway.app`.

### 6. Redeploy

**Deployments → Redeploy** on the latest one. It should go green. The app creates
its own table on first boot — no migration step to run. Schema changes ship the
same way: the columns added for coordinates, place ids and "recommended by" use
`ADD COLUMN IF NOT EXISTS`, so an existing database picks them up on the next boot
without touching the rows already in it.

Check `https://your-url/api/health` — it should return `{"ok":true,"db":"up","auth":true}`.

### 7. Put it on your home screen

- **iPhone**: open the URL in Safari (not Chrome) → Share → **Add to Home Screen**.
- **Android**: open in Chrome → menu → **Install app** / **Add to Home screen**.

It opens full-screen without browser chrome, and the login cookie lasts 60 days.

### What this costs

Railway's free trial credit runs out, and a Postgres running 24/7 needs a paid
plan — the Hobby plan was $5/month when this was written. Check their current
pricing; that number moves.

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

Foursquare is the lower-friction start: create a project at
`foursquare.com/developers` and use its Service Key. Google is worth it if you
already have a Cloud project — enable **Places API (New)** and restrict the key to
that one API.

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
cp .env.example .env     # then edit DATABASE_URL and APP_PASSWORD
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

All endpoints require the login cookie except `/api/health` and `/api/login`.

| Method   | Path               | Notes                                            |
| -------- | ------------------ | ------------------------------------------------ |
| `GET`    | `/api/health`      | Liveness + DB check (Railway's healthcheck)      |
| `POST`   | `/api/login`       | `{ "password": "..." }`                          |
| `POST`   | `/api/logout`      |                                                  |
| `GET`    | `/api/meta`        | Whether place search is configured               |
| `GET`    | `/api/places`      | Filters: `status`, `category`, `q`, `sort`       |
| `GET`    | `/api/tags`        | Tags in use with counts, for autocomplete        |
| `GET`    | `/api/place-search`| Proxied provider lookup: `q`                     |
| `POST`   | `/api/places`      | Create — `409` if that place id is already saved |
| `PUT`    | `/api/places/:id`  | Update                                           |
| `DELETE` | `/api/places/:id`  | Delete                                           |
| `GET`    | `/api/stats`       | Counts and average rating                        |

## A note on the security model

One shared password, checked in constant time, backed by an HMAC-signed HTTP-only
cookie. That is appropriate for a personal list of restaurants on a URL nobody else
knows. It is not appropriate for anything sensitive: there are no user accounts, no
rate limiting on login attempts, and no encryption of the notes at rest beyond what
Railway provides. If this ever holds something you'd actually mind leaking, that
model needs to change.
