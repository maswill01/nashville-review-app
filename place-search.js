// Server-side proxy for place lookup. The provider key stays on the server — it is
// never shipped to the browser, so it cannot be scraped off the page or a devtools
// network tab and spent by someone else.
//
// Two providers are supported; whichever key you set is the one that runs.
//
//   GOOGLE_PLACES_API_KEY  Places API (New) Text Search. Best coverage and the most
//                          reliable price levels, but the key needs a billing account.
//   FOURSQUARE_API_KEY     Foursquare Places API. Free tier, no billing setup, decent
//                          Nashville coverage, and it returns a neighborhood directly.
//
// With neither key set, /api/place-search returns `configured: false` and the form
// falls back to a plain typed name.

import { normalizeNeighborhood } from './public/data/nashville.js';

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const FOURSQUARE_KEY = process.env.FOURSQUARE_API_KEY || '';
const FOURSQUARE_API_VERSION = process.env.FOURSQUARE_API_VERSION || '2025-06-17';

// Bias results to Nashville so "Pearl Diver" does not return the one in Portland.
const NASHVILLE = { lat: 36.1627, lng: -86.7816 };
const BIAS_RADIUS_M = 40_000;

export const PROVIDER = GOOGLE_KEY ? 'google' : FOURSQUARE_KEY ? 'foursquare' : null;

const REQUEST_TIMEOUT_MS = 6000;

/* ----------------------------- category mapping ---------------------------- */

// Provider taxonomies are huge; we only care about the seven buckets the app has.
// First match wins, so order matters — 'bar' before 'restaurant', for instance.
const CATEGORY_RULES = [
  // Ahead of coffee and restaurant on purpose: a place tagged both "Café" and
  // "Breakfast Spot" is somewhere you eat breakfast, and a diner is a breakfast
  // place before it is a generic restaurant. Plain "Café" still lands on coffee.
  [/breakfast|brunch|diner|pancake|waffle|bagel|creperie|crêpe|biscuit/i, 'breakfast'],
  [/coffee|cafe|café|tea|bakery|patisserie|donut|juice/i, 'coffee'],
  [/\bbar\b|brewery|brewpub|pub|taproom|cocktail|wine|distiller|speakeasy|nightclub|night_club/i, 'bar'],
  [/music|concert|venue|honky|theater|theatre|amphitheat|jazz|opera/i, 'music'],
  [/restaurant|food|steak|pizza|taco|sushi|barbecue|bbq|meal_takeaway|meal_delivery/i, 'restaurant'],
  [/park|museum|gallery|zoo|golf|gym|bowling|spa|hik|tour|attraction|stadium|aquarium|library/i, 'activity'],
  [/shop|store|market|boutique|retail|book|clothing/i, 'shop']
];

function guessCategory(labels) {
  const haystack = labels.filter(Boolean).join(' ');
  for (const [pattern, category] of CATEGORY_RULES) {
    if (pattern.test(haystack)) return category;
  }
  return 'other';
}

/* -------------------------------- transport -------------------------------- */

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------- google ---------------------------------- */

const GOOGLE_PRICE = {
  PRICE_LEVEL_FREE: null,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4
};

const GOOGLE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.priceLevel',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.addressComponents'
].join(',');

async function searchGoogle(queryText) {
  const body = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': GOOGLE_FIELDS
    },
    body: JSON.stringify({
      textQuery: queryText,
      maxResultCount: 8,
      regionCode: 'US',
      locationBias: {
        circle: { center: { latitude: NASHVILLE.lat, longitude: NASHVILLE.lng }, radius: BIAS_RADIUS_M }
      }
    })
  });

  return (body?.places || []).map((place) => {
    const components = place.addressComponents || [];
    const pick = (type) => components.find((c) => (c.types || []).includes(type))?.longText;
    const hood = pick('neighborhood') || pick('sublocality_level_1') || pick('sublocality');

    return {
      provider: 'google',
      providerId: place.id || null,
      name: place.displayName?.text || '',
      address: place.shortFormattedAddress || place.formattedAddress || null,
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
      neighborhood: hood ? normalizeNeighborhood(hood) : null,
      city: pick('locality') || null,
      price: GOOGLE_PRICE[place.priceLevel] ?? null,
      category: guessCategory([place.primaryTypeDisplayName?.text, ...(place.types || [])])
    };
  });
}

/* ------------------------------- foursquare -------------------------------- */

async function searchFoursquare(queryText) {
  const params = new URLSearchParams({
    query: queryText,
    ll: `${NASHVILLE.lat},${NASHVILLE.lng}`,
    radius: String(BIAS_RADIUS_M),
    limit: '8'
  });

  const body = await fetchJson(`https://places-api.foursquare.com/places/search?${params}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${FOURSQUARE_KEY}`,
      'X-Places-Api-Version': FOURSQUARE_API_VERSION
    }
  });

  return (body?.results || []).map((place) => {
    const loc = place.location || {};
    const geo = place.latitude != null ? place : place.geocodes?.main || {};
    const hood = Array.isArray(loc.neighborhood) ? loc.neighborhood[0] : loc.neighborhood;
    const street = loc.address || loc.formatted_address || null;

    return {
      provider: 'foursquare',
      // The v3 API called this fsq_id; the current one calls it fsq_place_id.
      providerId: place.fsq_place_id || place.fsq_id || null,
      name: place.name || '',
      address: street,
      lat: geo.latitude ?? null,
      lng: geo.longitude ?? null,
      neighborhood: hood ? normalizeNeighborhood(hood) : null,
      city: loc.locality || null,
      price: Number.isInteger(place.price) ? place.price : null,
      category: guessCategory((place.categories || []).map((c) => c.name || c.short_name))
    };
  });
}

/* --------------------------------- public ---------------------------------- */

export async function searchPlaces(queryText) {
  const q = String(queryText || '').trim();
  if (q.length < 2) return [];
  const results = PROVIDER === 'google' ? await searchGoogle(q) : await searchFoursquare(q);
  return results.filter((r) => r.name);
}
