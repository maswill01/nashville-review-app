// Shared between the server and the browser: canonical Nashville neighborhoods,
// the aliases people actually type, and the normalizer that collapses them.
//
// This file is plain ESM with no Node or DOM references, so `server.js` imports it
// directly and the browser loads it as a module from /data/nashville.js.

export const NEIGHBORHOOD_GROUPS = [
  {
    label: 'Downtown & core',
    items: [
      'Downtown', 'SoBro', 'The Gulch', 'Rutledge Hill', 'Rolling Mill Hill',
      'Music Row', 'Midtown', 'Edgehill', 'Germantown', 'Salemtown',
      'Hope Gardens', 'Buena Vista', 'Marathon Village', 'Pie Town'
    ]
  },
  {
    label: 'East Nashville',
    items: [
      'East Nashville', 'Five Points', 'Edgefield', 'Lockeland Springs', 'Eastwood',
      'Greenwood', 'Rosebank', 'Riverside Village', 'Inglewood', 'Cleveland Park',
      'McFerrin Park', 'Shelby Hills', 'Dickerson Pike', 'Porter Heights', 'Maxwell'
    ]
  },
  {
    label: 'South & southeast',
    items: [
      '12 South', 'Belmont', 'Belmont-Hillsboro', 'Hillsboro Village', 'Melrose',
      'Berry Hill', 'Wedgewood-Houston', 'Chestnut Hill', 'Napier', 'Woodbine',
      'Glencliff', 'Crieve Hall', 'Radnor', 'Green Hills', 'Forest Hills',
      'Oak Hill', 'Antioch', 'Cane Ridge', 'Priest Lake'
    ]
  },
  {
    label: 'West & southwest',
    items: [
      'West End', 'Elliston Place', 'Vanderbilt', 'Sylvan Park', 'Sylvan Heights',
      'The Nations', 'Charlotte Park', 'Richland', 'Belle Meade', 'Hillwood',
      'West Meade', 'White Bridge', 'Bellevue'
    ]
  },
  {
    label: 'North & northwest',
    items: [
      'North Nashville', 'Jefferson Street', 'Bordeaux', 'Whites Creek',
      'Joelton', 'Madison', 'Goodlettsville'
    ]
  },
  {
    label: 'East county',
    items: ['Donelson', 'Hermitage', 'Old Hickory', 'Opryland', 'Airport / Briley']
  },
  {
    label: 'Outside Davidson County',
    items: [
      'Franklin', 'Brentwood', 'Nolensville', 'Leiper’s Fork', 'Spring Hill',
      'Mount Juliet', 'Hendersonville', 'Gallatin', 'Smyrna', 'La Vergne',
      'Murfreesboro', 'Columbia', 'Ashland City', 'Springfield'
    ]
  }
];

export const NEIGHBORHOODS = NEIGHBORHOOD_GROUPS.flatMap((group) => group.items);

// Shorthand and misspellings mapped onto the canonical name above. Keys are slugs,
// so casing, spaces, periods and hyphens in the typed text do not matter.
const ALIAS_SOURCE = {
  'East Nashville': ['east nash', 'east side', 'eastside', 'east nashvile', 'e nashville'],
  'The Gulch': ['gulch'],
  'The Nations': ['nations'],
  'SoBro': ['so bro', 'south of broadway'],
  '12 South': ['12south', '12 s', 'twelve south'],
  'Five Points': ['5 points', '5points'],
  'Wedgewood-Houston': ['wedgewood houston', 'weho', 'woho', 'wehoo'],
  'Hillsboro Village': ['hillsboro', 'the village'],
  'Belmont-Hillsboro': ['belmont hillsboro'],
  'Green Hills': ['greenhills'],
  'Berry Hill': ['berryhill'],
  'Mount Juliet': ['mt juliet', 'mt. juliet'],
  'Music Row': ['musicrow'],
  'North Nashville': ['n nashville', 'north nash'],
  'Marathon Village': ['marathon'],
  'Elliston Place': ['elliston'],
  'Jefferson Street': ['jefferson st'],
  'Downtown': ['broadway', 'lower broad', 'downtown nashville'],
  'Opryland': ['gaylord', 'opry mills'],
  'Leiper’s Fork': ['leipers fork', "leiper's fork"]
};

export function slugify(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const LOOKUP = new Map();
for (const name of NEIGHBORHOODS) LOOKUP.set(slugify(name), name);
for (const [canonical, aliases] of Object.entries(ALIAS_SOURCE)) {
  for (const alias of aliases) LOOKUP.set(slugify(alias), canonical);
}

/**
 * Collapse a typed neighborhood onto its canonical spelling. Anything we do not
 * recognize is kept as the user typed it — custom places are allowed on purpose.
 */
export function normalizeNeighborhood(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return LOOKUP.get(slugify(raw)) || raw;
}

export function isKnownNeighborhood(value) {
  return LOOKUP.has(slugify(value));
}

/** Split, trim, lowercase and de-duplicate a comma-separated tag string. */
export function normalizeTags(value) {
  const seen = new Set();
  const out = [];
  for (const part of String(value ?? '').split(',')) {
    const tag = part.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag.slice(0, 40));
  }
  return out.slice(0, 20);
}
