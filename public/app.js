import { NEIGHBORHOOD_GROUPS, normalizeTags, isKnownNeighborhood } from '/data/nashville.js';

const $ = (sel) => document.querySelector(sel);

const CUSTOM_HOOD = '__custom__';

const state = {
  status: 'visited',
  category: '',
  q: '',
  sort: 'recent',
  rating: null,
  price: null,
  tags: [],
  editingId: null,
  // null means your own list. A username here means you are reading someone
  // else's, which is read-only: the server ignores this on every write.
  viewing: null
};

// Filled from /api/meta on boot; until then the name field behaves as plain text.
const meta = { placeSearch: false, provider: null, user: null };

let places = [];
let tagVocab = [];

// Rating anchors. A ten-point scale is only worth having if 7 means the same
// thing in March as it did in January, so the wording shows under the control.
const RATING_MAX = 10;

const RATING_LABELS = {
  1: 'Absolutely avoid',
  2: 'Genuinely bad',
  3: 'Bad',
  4: 'Below average',
  5: 'Fine. Forgettable.',
  6: 'Good, happy to be there',
  7: 'Very good',
  8: 'Excellent, seek it out',
  9: 'Outstanding',
  10: "I'd take the president here"
};

const CATEGORY_LABELS = {
  restaurant: 'Restaurant',
  breakfast: 'Breakfast',
  bar: 'Bar',
  coffee: 'Coffee',
  music: 'Music',
  activity: 'Activity',
  shop: 'Shop',
  other: 'Other'
};

/* --------------------------------- api ----------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || 'Request failed');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* -------------------------------- helpers -------------------------------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

function formatVisitDate(value) {
  if (!value) return '';
  const d = new Date(`${value.slice(0, 10)}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Local calendar date. `toISOString()` would hand back yesterday for most of the
// evening in Central time.
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* -------------------------------- rendering ------------------------------- */

function cardHtml(place) {
  const bits = [];
  if (place.status === 'wishlist') bits.push('<span class="badge want">Want to go</span>');
  bits.push(escapeHtml(CATEGORY_LABELS[place.category] || 'Other'));
  if (place.neighborhood) bits.push(escapeHtml(place.neighborhood));
  if (place.price) bits.push('$'.repeat(place.price));
  if (place.visit_date) bits.push(escapeHtml(formatVisitDate(place.visit_date)));
  if (place.would_return) bits.push('↩ would go back');
  if (place.source) bits.push(`via ${escapeHtml(place.source)}`);

  const meta_ = bits.join('<span class="dot">·</span>');
  const score = place.rating ? `${place.rating}/${RATING_MAX}` : '';
  const tags = (place.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join('');

  return `
    <article class="card" data-id="${place.id}">
      <div class="card-top">
        <span class="card-name">${escapeHtml(place.name)}</span>
        ${score ? `<span class="card-rating">${score}</span>` : ''}
      </div>
      <div class="card-meta">${meta_}</div>
      ${place.notes ? `<p class="card-notes">${escapeHtml(place.notes)}</p>` : ''}
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    </article>`;
}

async function load() {
  const params = new URLSearchParams();
  if (state.status) params.set('status', state.status);
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  if (state.viewing) params.set('user', state.viewing);
  params.set('sort', state.sort);

  try {
    places = await api(`/api/places?${params.toString()}`);
  } catch (err) {
    toast(err.message);
    return;
  }

  $('#list').innerHTML = places.map(cardHtml).join('');
  const empty = $('#empty');
  if (places.length === 0) {
    empty.hidden = false;
    if (state.q) empty.textContent = 'Nothing matches that search.';
    else if (state.viewing) empty.textContent = `${state.viewing} has not added anything here yet.`;
    else empty.textContent = 'Nothing here yet. Tap + to add your first spot.';
  } else {
    empty.hidden = true;
  }
  loadStats();
}

async function loadStats() {
  try {
    const s = await api(`/api/stats${state.viewing ? `?user=${encodeURIComponent(state.viewing)}` : ''}`);
    const parts = [`${s.visited || 0} visited`, `${s.wishlist || 0} to try`];
    if (s.avg_rating) parts.push(`avg ${s.avg_rating}/${RATING_MAX}`);
    $('#stat-line').textContent = parts.join(' · ');
  } catch {
    $('#stat-line').textContent = '';
  }
}

/* -------------------------------- whose list ------------------------------ */

function syncViewing() {
  const other = Boolean(state.viewing);
  $('#list-owner').textContent = other ? `${state.viewing}'s list` : 'Nashville';
  document.body.classList.toggle('is-guest', other);
  // Nothing on this screen writes to someone else's list, so the control that
  // would is gone rather than disabled — there is no version of it that works.
  $('#add-btn').hidden = other;
}

function peopleRowHtml(person) {
  const mine = meta.user && person.username === meta.user.username;
  const bits = [`${person.visited} visited`, `${person.wishlist} to try`];
  if (person.avg_rating) bits.push(`avg ${person.avg_rating}/${RATING_MAX}`);
  const showing = mine ? !state.viewing : state.viewing === person.username;

  return `
    <li>
      <button type="button" class="person${showing ? ' is-active' : ''}"
              data-username="${escapeHtml(person.username)}" ${mine ? 'data-mine="1"' : ''}>
        <span class="person-name">${escapeHtml(person.username)}${mine ? ' <span class="person-you">you</span>' : ''}</span>
        <span class="person-meta">${escapeHtml(bits.join(' · '))}</span>
      </button>
    </li>`;
}

async function openPeople() {
  $('#people-list').innerHTML = '<li class="person-loading">Loading…</li>';
  $('#people-sheet').hidden = false;
  $('#list-switch').setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
  try {
    const people = await api('/api/users');
    $('#people-list').innerHTML = people.map(peopleRowHtml).join('');
  } catch (err) {
    $('#people-list').innerHTML = `<li class="person-loading">${escapeHtml(err.message)}</li>`;
  }
}

function closePeople() {
  $('#people-sheet').hidden = true;
  $('#list-switch').setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
  $('#password-form').reset();
  $('#account-box').open = false;
}

function showList(username) {
  state.viewing = username;
  // Filters are about what you are looking for, not whose list it is, so they
  // survive the switch — the server applies them to the new list just the same.
  closePeople();
  syncViewing();
  load();
}

async function changePassword(event) {
  event.preventDefault();
  const btn = $('#pw-submit');
  btn.disabled = true;
  try {
    await api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('#pw-current').value, password: $('#pw-next').value })
    });
    $('#password-form').reset();
    $('#account-box').open = false;
    toast('Password changed');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ neighborhood ------------------------------ */

function buildNeighborhoodPicker() {
  const select = $('#f-neighborhood');
  const parts = ['<option value="">—</option>'];
  for (const group of NEIGHBORHOOD_GROUPS) {
    parts.push(`<optgroup label="${escapeHtml(group.label)}">`);
    for (const name of group.items) {
      parts.push(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
    }
    parts.push('</optgroup>');
  }
  parts.push(`<option value="${CUSTOM_HOOD}">Somewhere else…</option>`);
  select.innerHTML = parts.join('');
}

function setNeighborhood(value) {
  const select = $('#f-neighborhood');
  const custom = $('#f-neighborhood-custom');
  const name = (value || '').trim();

  const known = name && Array.from(select.options).some((o) => o.value === name);
  if (known) {
    select.value = name;
    custom.value = '';
    custom.hidden = true;
  } else if (name) {
    // A place saved before this list existed, or one you added yourself.
    select.value = CUSTOM_HOOD;
    custom.value = name;
    custom.hidden = false;
  } else {
    select.value = '';
    custom.value = '';
    custom.hidden = true;
  }
}

function readNeighborhood() {
  const select = $('#f-neighborhood');
  return select.value === CUSTOM_HOOD ? $('#f-neighborhood-custom').value.trim() : select.value;
}

/* ---------------------------------- tags ---------------------------------- */

function renderTags() {
  $('#tag-chips').innerHTML = state.tags
    .map((tag, i) => `
      <span class="tag-chip">${escapeHtml(tag)}<button type="button" class="tag-x"
        data-index="${i}" aria-label="Remove ${escapeHtml(tag)}">×</button></span>`)
    .join('');
}

function addTag(raw) {
  const [tag] = normalizeTags(raw);
  if (!tag || state.tags.includes(tag)) return false;
  state.tags.push(tag);
  renderTags();
  return true;
}

function commitTagEntry() {
  const input = $('#f-tag-entry');
  // Paste of "date night, patio" should land as two chips, not one.
  for (const tag of normalizeTags(input.value)) addTag(tag);
  input.value = '';
  hideMenu('#tag-suggestions', '#f-tag-entry');
}

function showTagSuggestions() {
  const input = $('#f-tag-entry');
  const typed = input.value.trim().toLowerCase();
  const matches = tagVocab
    .filter(({ tag }) => !state.tags.includes(tag) && (!typed || tag.includes(typed)))
    .slice(0, 8);

  if (!matches.length) return hideMenu('#tag-suggestions', '#f-tag-entry');

  $('#tag-suggestions').innerHTML = matches
    .map(({ tag, count }) => `
      <li role="option" data-tag="${escapeHtml(tag)}">
        <span>${escapeHtml(tag)}</span><span class="lookup-count">${count}</span>
      </li>`)
    .join('');
  showMenu('#tag-suggestions', '#f-tag-entry');
}

async function loadTagVocab() {
  try {
    tagVocab = await api('/api/tags');
  } catch {
    tagVocab = [];
  }
}

/* ------------------------------ place search ------------------------------ */

let searchToken = 0;

function clearPlaceLink() {
  $('#f-lat').value = '';
  $('#f-lng').value = '';
  $('#f-place-id').value = '';
  $('#f-place-provider').value = '';
  updatePlaceHint();
}

function updatePlaceHint() {
  const hint = $('#place-hint');
  if ($('#f-lat').value) {
    hint.textContent = '📍 Location saved';
    hint.className = 'hint ok';
    hint.hidden = false;
  } else if (meta.placeSearch) {
    hint.textContent = 'Pick a result to save the address and coordinates.';
    hint.className = 'hint';
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

function choosePlace(result) {
  $('#f-name').value = result.name;
  $('#f-address').value = result.address || '';
  $('#f-lat').value = result.lat ?? '';
  $('#f-lng').value = result.lng ?? '';
  $('#f-place-id').value = result.providerId || '';
  $('#f-place-provider').value = result.provider || '';
  // Places outside Davidson County usually have a city and no neighborhood.
  // "Franklin" is a real entry in the picker so it fills the field; "Nashville"
  // is not, and would only become a junk custom value.
  const hood = result.neighborhood || (isKnownNeighborhood(result.city) ? result.city : null);
  if (hood) setNeighborhood(hood);
  if (result.price) setPrice(result.price);
  if (result.category) $('#f-category').value = result.category;

  hideMenu('#place-results', '#f-name');
  updatePlaceHint();
  syncSaveState();
}

const runPlaceSearch = debounce(async () => {
  const q = $('#f-name').value.trim();
  if (!meta.placeSearch || q.length < 2) return hideMenu('#place-results', '#f-name');

  const token = ++searchToken;
  $('#place-spinner').hidden = false;
  try {
    const body = await api(`/api/place-search?q=${encodeURIComponent(q)}`);
    if (token !== searchToken) return; // a newer keystroke already won
    renderPlaceResults(body.results || []);
  } catch (err) {
    if (token !== searchToken) return;
    hideMenu('#place-results', '#f-name');
    toast(err.message);
  } finally {
    if (token === searchToken) $('#place-spinner').hidden = true;
  }
}, 300);

let lastResults = [];

function resultSubtitle(result) {
  const parts = [result.neighborhood, result.address, result.city];
  return parts.filter(Boolean).filter((p, i, all) => all.indexOf(p) === i).join(' · ');
}

function renderPlaceResults(results) {
  lastResults = results;
  if (!results.length) return hideMenu('#place-results', '#f-name');

  $('#place-results').innerHTML = results
    .map((r, i) => `
      <li role="option" data-index="${i}">
        <span class="lookup-name">${escapeHtml(r.name)}</span>
        <span class="lookup-sub">${escapeHtml(resultSubtitle(r))}</span>
      </li>`)
    .join('');
  showMenu('#place-results', '#f-name');
}

/* ------------------------------- menu plumbing ---------------------------- */

function showMenu(menuSel, inputSel) {
  $(menuSel).hidden = false;
  $(inputSel).setAttribute('aria-expanded', 'true');
}

function hideMenu(menuSel, inputSel) {
  $(menuSel).hidden = true;
  $(inputSel).setAttribute('aria-expanded', 'false');
}

/* --------------------------------- sheet ---------------------------------- */

// `fromInput` means the exact-rating box is what changed, so leave it alone —
// rewriting its value mid-keystroke would move the caret out from under them.
function setRating(value, fromInput = false) {
  state.rating = value;
  document.querySelectorAll('#f-rating button[data-value]').forEach((btn) => {
    const on = value !== null && Number(btn.dataset.value) === value;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  });
  if (!fromInput) $('#f-rating-exact').value = value === null ? '' : String(value);

  const hint = $('#f-rating-hint');
  // A half point sits between two anchors; the lower one is the honest read of
  // 8.5 — at least this good, and reaching for the next.
  hint.textContent = value === null ? '' : RATING_LABELS[Math.floor(value)] || '';
  hint.hidden = !hint.textContent;
  $('#f-rating-clear').hidden = value === null;
}

function setPrice(value) {
  state.price = value;
  document.querySelectorAll('#f-price button').forEach((btn) => {
    const v = btn.dataset.value === '' ? null : Number(btn.dataset.value);
    btn.classList.toggle('on', v === value);
  });
}

function syncStatusFields() {
  const wishlist = $('#f-status').value === 'wishlist';
  $('#visited-only').hidden = wishlist;
  $('#wishlist-only').hidden = !wishlist;
  // A place you have been to was almost always visited today, so fill it in
  // rather than leaving an empty date control.
  if (!wishlist && !$('#f-visit-date').value) $('#f-visit-date').value = today();
}

function syncSaveState() {
  $('#save-btn').disabled = !$('#f-name').value.trim();
}

function openSheet(place = null) {
  state.editingId = place?.id ?? null;
  $('#sheet-title').textContent = place ? 'Edit place' : 'New place';
  $('#f-id').value = place?.id ?? '';
  $('#f-name').value = place?.name ?? '';
  $('#f-address').value = place?.address ?? '';
  $('#f-lat').value = place?.lat ?? '';
  $('#f-lng').value = place?.lng ?? '';
  $('#f-place-id').value = place?.place_id ?? '';
  $('#f-place-provider').value = place?.place_provider ?? '';
  $('#f-category').value = place?.category ?? 'restaurant';
  $('#f-status').value = place?.status ?? (state.status === 'wishlist' ? 'wishlist' : 'visited');
  setNeighborhood(place?.neighborhood ?? '');
  $('#f-visit-date').value = place?.visit_date ? place.visit_date.slice(0, 10) : '';
  $('#f-would-return').checked = Boolean(place?.would_return);
  $('#f-source').value = place?.source ?? '';
  $('#f-notes').value = place?.notes ?? '';
  state.tags = normalizeTags(place?.tags ?? '');
  $('#f-tag-entry').value = '';
  renderTags();
  setRating(place?.rating ?? null);
  setPrice(place?.price ?? null);
  syncStatusFields();
  updatePlaceHint();
  syncSaveState();
  hideMenu('#place-results', '#f-name');
  hideMenu('#tag-suggestions', '#f-tag-entry');

  $('#delete-btn').hidden = !place;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  if (!place) setTimeout(() => $('#f-name').focus(), 60);
}

function closeSheet() {
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}

async function save(event) {
  event.preventDefault();
  commitTagEntry();

  const name = $('#f-name').value.trim();
  if (!name) {
    toast('Give it a name first.');
    $('#f-name').focus();
    return;
  }

  const payload = {
    name,
    category: $('#f-category').value,
    status: $('#f-status').value,
    neighborhood: readNeighborhood(),
    address: $('#f-address').value,
    rating: state.rating,
    price: state.price,
    would_return: $('#f-would-return').checked,
    visit_date: $('#f-visit-date').value,
    source: $('#f-source').value,
    notes: $('#f-notes').value,
    tags: state.tags.join(', '),
    lat: $('#f-lat').value,
    lng: $('#f-lng').value,
    place_id: $('#f-place-id').value,
    place_provider: $('#f-place-provider').value
  };

  const btn = $('#save-btn');
  btn.disabled = true;
  try {
    if (state.editingId) {
      await api(`/api/places/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Updated');
    } else {
      await api('/api/places', { method: 'POST', body: JSON.stringify(payload) });
      toast('Added');
    }
    closeSheet();
    await Promise.all([load(), loadTagVocab()]);
  } catch (err) {
    // The same place picked twice: open the row that already exists instead of
    // stranding the user on an error they cannot act on.
    if (err.status === 409 && err.body?.place) {
      toast('Already on your list — opening it.');
      openSheet(err.body.place);
      return;
    }
    toast(err.message);
  } finally {
    syncSaveState();
  }
}

async function remove() {
  if (!state.editingId) return;
  if (!confirm('Delete this place for good?')) return;
  try {
    await api(`/api/places/${state.editingId}`, { method: 'DELETE' });
    closeSheet();
    toast('Deleted');
    await Promise.all([load(), loadTagVocab()]);
  } catch (err) {
    toast(err.message);
  }
}

/* -------------------------------- listeners ------------------------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    state.status = tab.dataset.status;
    load();
  });
});

$('#category-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
  chip.classList.add('is-active');
  state.category = chip.dataset.category;
  load();
});

$('#search').addEventListener('input', debounce((e) => {
  state.q = e.target.value.trim();
  load();
}, 250));

$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  load();
});

$('#list').addEventListener('click', (e) => {
  // Someone else's card already shows everything the form would, and the form
  // only knows how to save. Opening it would be a lie about what happens next.
  if (state.viewing) return;
  const card = e.target.closest('.card');
  if (!card) return;
  const place = places.find((p) => String(p.id) === card.dataset.id);
  if (place) openSheet(place);
});

$('#list-switch').addEventListener('click', openPeople);
$('#people-close').addEventListener('click', closePeople);
$('#password-form').addEventListener('submit', changePassword);

$('#people-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.person');
  if (!btn) return;
  showList(btn.dataset.mine ? null : btn.dataset.username);
});

$('#people-sheet').addEventListener('click', (e) => {
  if (e.target === $('#people-sheet')) closePeople();
});

$('#add-btn').addEventListener('click', () => openSheet());
$('#cancel-btn').addEventListener('click', closeSheet);
$('#delete-btn').addEventListener('click', remove);
$('#place-form').addEventListener('submit', save);
$('#f-status').addEventListener('change', syncStatusFields);

$('#f-name').addEventListener('input', () => {
  // Editing the name by hand breaks the tie to the picked result — the saved
  // coordinates would no longer describe what is in the box.
  if ($('#f-place-id').value || $('#f-lat').value) clearPlaceLink();
  syncSaveState();
  runPlaceSearch();
});

$('#f-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#place-results').hidden) {
    e.preventDefault();
    hideMenu('#place-results', '#f-name');
  }
});

$('#f-name').addEventListener('focus', () => {
  if (lastResults.length && $('#f-name').value.trim().length >= 2) showMenu('#place-results', '#f-name');
});

// mousedown fires before blur, so the pick is not lost to the input losing focus.
$('#place-results').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-index]');
  if (!li) return;
  e.preventDefault();
  choosePlace(lastResults[Number(li.dataset.index)]);
});

$('#f-name').addEventListener('blur', () => {
  setTimeout(() => hideMenu('#place-results', '#f-name'), 120);
});

$('#f-neighborhood').addEventListener('change', () => {
  const custom = $('#f-neighborhood-custom');
  const isCustom = $('#f-neighborhood').value === CUSTOM_HOOD;
  custom.hidden = !isCustom;
  if (isCustom) custom.focus();
  else custom.value = '';
});

$('#f-tag-entry').addEventListener('input', showTagSuggestions);
$('#f-tag-entry').addEventListener('focus', showTagSuggestions);
$('#f-tag-entry').addEventListener('blur', () => {
  setTimeout(() => {
    commitTagEntry();
  }, 120);
});

$('#f-tag-entry').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    commitTagEntry();
  } else if (e.key === 'Tab') {
    commitTagEntry(); // commit, but let focus move on as usual
  } else if (e.key === 'Backspace' && !$('#f-tag-entry').value) {
    state.tags.pop();
    renderTags();
    showTagSuggestions();
  } else if (e.key === 'Escape') {
    hideMenu('#tag-suggestions', '#f-tag-entry');
  }
});

$('#tag-suggestions').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-tag]');
  if (!li) return;
  e.preventDefault();
  addTag(li.dataset.tag);
  $('#f-tag-entry').value = '';
  showTagSuggestions();
});

$('#tag-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('.tag-x');
  if (!btn) return;
  state.tags.splice(Number(btn.dataset.index), 1);
  renderTags();
});

$('#tag-box').addEventListener('click', (e) => {
  if (e.target === $('#tag-box') || e.target === $('#tag-chips')) $('#f-tag-entry').focus();
});

$('#f-rating').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  // Tapping the current score again clears it, so a mis-tap is one tap to undo.
  const value = Number(btn.dataset.value);
  setRating(value === state.rating ? null : value);
});

$('#f-rating-clear').addEventListener('click', () => setRating(null));

// Typed live rather than on blur, so tapping Save straight after typing 8.5
// saves 8.5 and not the score that was there before.
$('#f-rating-exact').addEventListener('input', (e) => {
  const raw = e.target.value.trim();
  if (raw === '') {
    setRating(null, true);
    return;
  }
  const n = Number(raw);
  // Half-typed or out of range: keep the last good score and let the blur below
  // put the box back in step with it.
  if (!Number.isFinite(n) || n < 1 || n > RATING_MAX) return;
  setRating(Math.round(n * 10) / 10, true);
});

// Blur or Enter: redraw the box from state, which rounds 8.53 to 8.5 and undoes
// anything that never became a score.
$('#f-rating-exact').addEventListener('change', () => setRating(state.rating));

$('#f-price').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const raw = btn.dataset.value;
  setPrice(raw === '' ? null : Number(raw));
});

$('#sheet').addEventListener('click', (e) => {
  if (e.target === $('#sheet')) closeSheet();
});

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#people-sheet').hidden) return closePeople();
  if ($('#sheet').hidden) return;
  if (!$('#place-results').hidden) return hideMenu('#place-results', '#f-name');
  closeSheet();
});

/* --------------------------------- boot ----------------------------------- */

async function boot() {
  buildNeighborhoodPicker();
  try {
    Object.assign(meta, await api('/api/meta'));
  } catch {
    meta.placeSearch = false;
  }
  if (!meta.placeSearch) {
    // No provider key configured: the field is still the name, just typed.
    $('#f-name').placeholder = 'e.g. Rolf and Daughters';
    $('#f-name-label').textContent = 'Name';
  }
  syncViewing();
  await Promise.all([load(), loadTagVocab()]);
}

boot();
