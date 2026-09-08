const $ = (sel) => document.querySelector(sel);

const state = {
  status: 'visited',
  category: '',
  q: '',
  sort: 'recent',
  rating: null,
  price: null,
  editingId: null
};

const CATEGORY_LABELS = {
  restaurant: 'Restaurant',
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
  if (!res.ok) throw new Error(body?.error || 'Request failed');
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

  const meta = bits.join('<span class="dot">·</span>');
  const stars = place.rating ? '★'.repeat(place.rating) + '☆'.repeat(5 - place.rating) : '';
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
        ${stars ? `<span class="card-rating">${stars}</span>` : ''}
      </div>
      <div class="card-meta">${meta}</div>
      ${place.notes ? `<p class="card-notes">${escapeHtml(place.notes)}</p>` : ''}
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    </article>`;
}

let places = [];

async function load() {
  const params = new URLSearchParams();
  if (state.status) params.set('status', state.status);
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
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
    empty.textContent = state.q
      ? 'Nothing matches that search.'
      : 'Nothing here yet. Tap + to add your first spot.';
  } else {
    empty.hidden = true;
  }
  loadStats();
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    const parts = [`${s.visited || 0} visited`, `${s.wishlist || 0} to try`];
    if (s.avg_rating) parts.push(`avg ${s.avg_rating}★`);
    $('#stat-line').textContent = parts.join(' · ');
  } catch {
    $('#stat-line').textContent = '';
  }
}

/* --------------------------------- sheet ---------------------------------- */

function setStars(value) {
  state.rating = value;
  document.querySelectorAll('#f-rating button[data-value]').forEach((btn) => {
    const v = btn.dataset.value;
    btn.classList.toggle('on', Boolean(v) && value !== null && Number(v) <= value);
  });
}

function setPrice(value) {
  state.price = value;
  document.querySelectorAll('#f-price button').forEach((btn) => {
    const v = btn.dataset.value === '' ? null : Number(btn.dataset.value);
    btn.classList.toggle('on', v === value);
  });
}

function syncStatusFields() {
  $('#visited-only').hidden = $('#f-status').value === 'wishlist';
}

function openSheet(place = null) {
  state.editingId = place?.id ?? null;
  $('#sheet-title').textContent = place ? 'Edit place' : 'New place';
  $('#f-id').value = place?.id ?? '';
  $('#f-name').value = place?.name ?? '';
  $('#f-category').value = place?.category ?? 'restaurant';
  $('#f-status').value = place?.status ?? (state.status === 'wishlist' ? 'wishlist' : 'visited');
  $('#f-neighborhood').value = place?.neighborhood ?? '';
  $('#f-visit-date').value = place?.visit_date ? place.visit_date.slice(0, 10) : '';
  $('#f-would-return').checked = Boolean(place?.would_return);
  $('#f-notes').value = place?.notes ?? '';
  $('#f-tags').value = place?.tags ?? '';
  setStars(place?.rating ?? null);
  setPrice(place?.price ?? null);
  syncStatusFields();
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
    neighborhood: $('#f-neighborhood').value,
    rating: state.rating,
    price: state.price,
    would_return: $('#f-would-return').checked,
    visit_date: $('#f-visit-date').value,
    notes: $('#f-notes').value,
    tags: $('#f-tags').value
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
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function remove() {
  if (!state.editingId) return;
  if (!confirm('Delete this place for good?')) return;
  try {
    await api(`/api/places/${state.editingId}`, { method: 'DELETE' });
    closeSheet();
    toast('Deleted');
    await load();
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
  const card = e.target.closest('.card');
  if (!card) return;
  const place = places.find((p) => String(p.id) === card.dataset.id);
  if (place) openSheet(place);
});

$('#add-btn').addEventListener('click', () => openSheet());
$('#cancel-btn').addEventListener('click', closeSheet);
$('#delete-btn').addEventListener('click', remove);
$('#place-form').addEventListener('submit', save);
$('#f-status').addEventListener('change', syncStatusFields);

$('#f-rating').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const raw = btn.dataset.value;
  setStars(raw === '' ? null : Number(raw));
});

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
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
});

load();
