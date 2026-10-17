import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { googlePlaces, memoryPlaces, reviewSummary, syncReviews } from '../src/google-reviews.js';
import { DEMO_PASSWORD, seedAdmin, seedDemo } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addDays, today } from '../src/util.js';

const review = (n, rating, daysAgo, text = `Review ${n}`) => ({
  id: `places/P/reviews/${n}`, author: `Person ${n}`, author_url: null, author_photo: null, rating, text,
  published_at: new Date(Date.now() - daysAgo * 86400000).toISOString(), review_url: null,
});
const PLACE = { place_id: 'ChIJ_harbour_cafe_123', name: 'Brew Harbour', address: '1 Quay, Brightwell', rating: 4.5, count: 200, reviews: [review(1, 5, 2), review(2, 2, 10)] };

let server;
let base;
let db;
const places = memoryPlaces([PLACE, { place_id: 'ChIJ_other_place_456', name: 'Other Cafe', address: '9 Hill', rating: 3.9, count: 12, reviews: [] }]);

before(async () => {
  db = openDb(':memory:');
  seedAdmin(db, { email: 'admin@cafe.local', password: DEMO_PASSWORD });
  seedDemo(db);
  server = createApp(db, { places }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  call.me = (await call('/auth/me')).data.user;
  return call;
}

test('admins link a site to Google Maps; its rating and reviews come in straight away', async () => {
  const admin = await login('admin@cafe.local');
  const manager = await login('manager1@cafe.local');
  const staff = await login('staff1@cafe.local');
  const site = manager.me.location_id;

  const found = await admin('/reviews/places?q=harbour');
  assert.deepEqual(found.data.map((p) => p.place_id), ['ChIJ_harbour_cafe_123']);
  assert.equal((await manager('/reviews/places?q=harbour')).status, 403, 'only admins link sites');
  assert.equal((await manager(`/locations/${site}/google-place`, { method: 'PUT', body: { place_id: PLACE.place_id } })).status, 403);
  assert.equal((await admin(`/locations/${site}/google-place`, { method: 'PUT', body: { place_id: 'bad id!' } })).status, 400);
  assert.equal((await admin(`/locations/${site}/google-place`, { method: 'PUT', body: { place_id: 'ChIJ_not_on_google' } })).status, 404);

  assert.equal((await admin(`/locations/${site}/google-place`, { method: 'PUT', body: { place_id: PLACE.place_id } })).status, 200);
  const mine = await manager('/reviews');
  assert.equal(mine.status, 200);
  const s = mine.data.sites.find((x) => x.id === site);
  assert.equal(s.rating, 4.5);
  assert.equal(s.review_count, 200);
  assert.equal(s.new_this_week, 1);
  assert.deepEqual(s.reviews.map((r) => r.rating), [5, 2], 'newest first');
  assert.match(s.write_review_url, /writereview\?placeid=ChIJ_harbour_cafe_123/);
  assert.ok(mine.data.sites.every((x) => manager.me.site_ids?.includes?.(x.id) ?? true));
  assert.equal((await staff('/reviews')).status, 403);

  // Unlinking clears what was kept.
  assert.equal((await admin(`/locations/${site}/google-place`, { method: 'PUT', body: { place_id: null } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM google_reviews WHERE location_id = ?').get(site).n, 0);
});

test('checks keep new reviews, show the change in rating and forget reviews Google stopped showing a month ago', async () => {
  const site = db.prepare('SELECT id FROM locations WHERE active = 1 ORDER BY id DESC LIMIT 1').get().id;
  db.prepare('UPDATE locations SET google_place_id = ? WHERE id = ?').run(PLACE.place_id, site);
  const first = await syncReviews(db, places, { locationIds: [site] });
  assert.equal(first.new_reviews, 2);
  db.prepare('INSERT OR REPLACE INTO google_ratings (location_id, date, rating, review_count) VALUES (?, ?, 4.3, 190)').run(site, addDays(today(), -20));

  PLACE.reviews = [review(3, 4, 0), review(1, 5, 2)];
  PLACE.rating = 4.6;
  const second = await syncReviews(db, places, { locationIds: [site] });
  assert.equal(second.new_reviews, 1);
  let [s] = reviewSummary(db, [{ id: site, name: 'X' }]);
  assert.equal(s.reviews.length, 3, 'review 2 is still kept although Google no longer shows it');
  assert.deepEqual(s.since, { date: addDays(today(), -20), rating: 4.3, review_count: 190 });
  assert.equal(s.rating, 4.6);

  await syncReviews(db, places, { locationIds: [site], now: new Date(Date.now() + 31 * 86400000) });
  [s] = reviewSummary(db, [{ id: site, name: 'X' }]);
  assert.deepEqual(s.reviews.map((r) => r.id).sort(), ['places/P/reviews/1', 'places/P/reviews/3']);
});

test('Google Places: sends the key, reads reviews and explains setup problems', async () => {
  const seen = [];
  let status = 200;
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    if (status !== 200) return { ok: false, status, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Places API (New) has not been used in project 123' } }) };
    if (url.endsWith(':searchText')) return { ok: true, status, json: async () => ({ places: [{ id: 'ChIJ1', displayName: { text: 'Cafe' }, formattedAddress: '1 Road', rating: 4.2, userRatingCount: 9 }] }) };
    return { ok: true, status, json: async () => ({ id: 'ChIJ1', displayName: { text: 'Cafe' }, rating: 4.2, userRatingCount: 9, reviews: [
      { name: 'places/ChIJ1/reviews/a', rating: 5, text: { text: 'Great' }, publishTime: '2026-01-01T10:00:00Z', authorAttribution: { displayName: 'Sam', uri: 'https://maps/sam', photoUri: 'https://photo' }, googleMapsUri: 'https://maps/r/a' },
    ] }) };
  };
  const g = googlePlaces('KEY123', { fetchFn });
  assert.deepEqual(await g.search('cafe brightwell'), [{ place_id: 'ChIJ1', name: 'Cafe', address: '1 Road', rating: 4.2, count: 9 }]);
  assert.equal(seen[0].init.headers['X-Goog-Api-Key'], 'KEY123');
  assert.equal(JSON.parse(seen[0].init.body).textQuery, 'cafe brightwell');
  const p = await g.place('ChIJ1');
  assert.match(seen[1].url, /places\/ChIJ1\?/);
  assert.match(seen[1].init.headers['X-Goog-FieldMask'], /reviews/);
  assert.deepEqual(p.reviews, [{ id: 'places/ChIJ1/reviews/a', author: 'Sam', author_url: 'https://maps/sam', author_photo: 'https://photo', rating: 5, text: 'Great', published_at: '2026-01-01T10:00:00Z', review_url: 'https://maps/r/a' }]);
  status = 403;
  await assert.rejects(g.place('ChIJ1'), /Places API \(New\)/);
});
