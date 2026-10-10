// Google reviews: each site is linked to its place on Google Maps (Setup → Locations), and every few hours Atlas
// fetches its star rating, number of reviews and the latest reviews through the Google Places API. Google only
// gives out the five most relevant recent reviews at a time, so Atlas keeps the ones it has seen (for up to 30
// days after they stop being shown, which is as long as Google allows copies to be kept) and a daily rating.
// Switched on by GOOGLE_PLACES_API_KEY (GOOGLE_REVIEWS_HOURS changes how often it checks; the default is 12).
import { requireAdmin, requirePerm, resolveLocation, reportLocations } from './auth.js';
import { getSetting, setSetting } from './invoice-inbox.js';
import { cleanEnv } from './seed.js';
import { addDays, badRequest, HttpError, id, notFound, str, today } from './util.js';

const PLACES = 'https://places.googleapis.com/v1';
const KEY = { lastSync: 'google_reviews_last_sync', lastError: 'google_reviews_last_error' };
const KEEP_DAYS = 30;
// A manual "Check now" within this long of the last check just shows what's there (each check costs a little).
const MIN_MANUAL_GAP_MS = 5 * 60 * 1000;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

export class PlacesError extends HttpError {}

export function placesConfig(env = process.env) {
  const key = cleanEnv(env.GOOGLE_PLACES_API_KEY) || cleanEnv(env.GOOGLE_MAPS_API_KEY);
  if (!key) return null;
  return { key, hours: Math.max(3, Number(cleanEnv(env.GOOGLE_REVIEWS_HOURS)) || 12) };
}

export const mapsUrl = (placeId) => `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
export const writeReviewUrl = (placeId) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;

const toReview = (r) => ({
  id: String(r.name ?? ''),
  author: r.authorAttribution?.displayName ?? 'A Google user',
  author_url: r.authorAttribution?.uri ?? null,
  author_photo: r.authorAttribution?.photoUri ?? null,
  rating: Number(r.rating) || null,
  text: r.text?.text ?? r.originalText?.text ?? '',
  published_at: r.publishTime ?? null,
  review_url: r.googleMapsUri ?? null,
});

/** The Google Places API (New): search(text) → matching places; place(id) → its rating and latest reviews. */
export function googlePlaces(apiKey, { fetchFn = fetch } = {}) {
  const call = async (url, fields, init = {}) => {
    const res = await fetchFn(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fields, ...init.headers } });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const message = body.error?.message ?? `error ${res.status}`;
    if (/api key/i.test(message)) throw new PlacesError(502, `Google didn't accept the API key – check GOOGLE_PLACES_API_KEY. (${message})`);
    if (res.status === 403 || body.error?.status === 'PERMISSION_DENIED') {
      throw new PlacesError(502, `Google refused: turn on “Places API (New)” for the key’s Google Cloud project and check billing is set up. (${message})`);
    }
    if (res.status === 404 || /not found|invalid.*place/i.test(message)) throw new PlacesError(404, 'That place wasn’t found on Google Maps – link the site again.');
    if (res.status === 429) throw new PlacesError(503, 'Google is limiting requests right now – try again later.');
    throw new PlacesError(502, `Google Maps: ${message}`);
  };
  return {
    async search(text) {
      const body = await call(`${PLACES}/places:searchText`, 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount', {
        method: 'POST', body: JSON.stringify({ textQuery: text, regionCode: 'GB', languageCode: 'en-GB', pageSize: 8 }),
      });
      return (body.places ?? []).map((p) => ({ place_id: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '', rating: p.rating ?? null, count: p.userRatingCount ?? 0 }));
    },
    async place(placeId) {
      const p = await call(`${PLACES}/places/${encodeURIComponent(placeId)}?languageCode=en-GB&regionCode=GB`, 'id,displayName,formattedAddress,rating,userRatingCount,googleMapsUri,reviews');
      return { place_id: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '', rating: p.rating ?? null, count: p.userRatingCount ?? 0, maps_url: p.googleMapsUri ?? null, reviews: (p.reviews ?? []).map(toReview).filter((r) => r.id) };
    },
  };
}

/** Pretend places, for tests and the demo: [{ place_id, name, address, rating, count, reviews }]. */
export function memoryPlaces(places = []) {
  return {
    places,
    async search(text) {
      const words = String(text).toLowerCase().split(/\W+/).filter(Boolean);
      return places.filter((p) => words.some((w) => `${p.name} ${p.address}`.toLowerCase().includes(w)))
        .map(({ place_id, name, address, rating, count }) => ({ place_id, name, address, rating, count }));
    },
    async place(placeId) {
      const p = places.find((x) => x.place_id === placeId);
      if (!p) throw new PlacesError(404, 'That place wasn’t found on Google Maps – link the site again.');
      return { maps_url: null, ...p, reviews: [...(p.reviews ?? [])] };
    },
  };
}

/** Saves one site's rating and reviews from Google. Returns how many reviews were new. */
function saveSite(db, locationId, place, now) {
  const stamp = now.toISOString();
  const known = new Set(db.prepare('SELECT id FROM google_reviews WHERE location_id = ?').all(locationId).map((r) => r.id));
  const upsert = db.prepare(`INSERT INTO google_reviews (id, location_id, author, author_url, author_photo, rating, text, published_at, review_url, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET location_id = excluded.location_id, author = excluded.author, author_url = excluded.author_url,
      author_photo = excluded.author_photo, rating = excluded.rating, text = excluded.text, published_at = excluded.published_at,
      review_url = excluded.review_url, last_seen_at = excluded.last_seen_at`);
  for (const r of place.reviews) {
    upsert.run(r.id, locationId, r.author, r.author_url, r.author_photo, r.rating, r.text, r.published_at, r.review_url, stamp, stamp);
  }
  db.prepare(`INSERT INTO google_ratings (location_id, date, rating, review_count) VALUES (?, ?, ?, ?)
    ON CONFLICT(location_id, date) DO UPDATE SET rating = excluded.rating, review_count = excluded.review_count`)
    .run(locationId, today(), place.rating, place.count);
  return place.reviews.filter((r) => !known.has(r.id)).length;
}

function prune(db, now) {
  db.prepare('DELETE FROM google_reviews WHERE last_seen_at < ?').run(new Date(now.getTime() - KEEP_DAYS * 86400000).toISOString());
  db.prepare('DELETE FROM google_ratings WHERE date < ?').run(addDays(today(), -(KEEP_DAYS + 1)));
}

let syncing = null;

/** Fetches every linked site (or just the ones given). Returns { sites, new_reviews, errors }. */
export async function syncReviews(db, places, { locationIds = null, now = new Date() } = {}) {
  if (syncing && !locationIds) return syncing;
  const run = (async () => {
    const sites = db.prepare(`SELECT id, name, google_place_id FROM locations WHERE active = 1 AND google_place_id IS NOT NULL ORDER BY name`).all()
      .filter((s) => !locationIds || locationIds.includes(s.id));
    const result = { sites: 0, new_reviews: 0, errors: [] };
    for (const s of sites) {
      try {
        result.new_reviews += saveSite(db, s.id, await places.place(s.google_place_id), now);
        result.sites++;
      } catch (err) {
        result.errors.push(`${s.name}: ${err.message}`);
      }
    }
    prune(db, now);
    if (!locationIds) {
      setSetting(db, KEY.lastSync, now.toISOString());
      setSetting(db, KEY.lastError, result.errors.length ? result.errors.join(' ') : null);
    }
    return result;
  })();
  if (!locationIds) syncing = run.finally(() => { syncing = null; });
  return run;
}

export function startReviewSync(db, places, { hours = 12 } = {}) {
  const tick = () => syncReviews(db, places).catch((err) => console.error('Google reviews:', err.message));
  setTimeout(tick, 30 * 1000).unref?.();
  setInterval(tick, hours * 3600 * 1000).unref?.();
}

/** Each site's Google rating now and about a month ago, and the reviews Atlas has. */
export function reviewSummary(db, locations, { reviewsPerSite = 50, now = new Date() } = {}) {
  const latest = db.prepare('SELECT rating, review_count, date FROM google_ratings WHERE location_id = ? ORDER BY date DESC LIMIT 1');
  const earliest = db.prepare('SELECT rating, review_count, date FROM google_ratings WHERE location_id = ? AND date >= ? ORDER BY date LIMIT 1');
  const reviews = db.prepare(`SELECT id, author, author_url, author_photo, rating, text, published_at, review_url, first_seen_at
    FROM google_reviews WHERE location_id = ? ORDER BY published_at DESC LIMIT ?`);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  return locations.map((l) => {
    const place = db.prepare('SELECT google_place_id FROM locations WHERE id = ?').get(l.id)?.google_place_id ?? null;
    const now_ = latest.get(l.id) ?? null;
    const then = earliest.get(l.id, addDays(today(), -KEEP_DAYS)) ?? null;
    const list = place ? reviews.all(l.id, reviewsPerSite).map((r) => ({ ...r })) : [];
    return {
      id: l.id,
      name: l.name,
      place_id: place,
      maps_url: place ? mapsUrl(place) : null,
      write_review_url: place ? writeReviewUrl(place) : null,
      rating: now_?.rating ?? null,
      review_count: now_?.review_count ?? null,
      since: then && now_ && then.date !== now_.date ? { date: then.date, rating: then.rating, review_count: then.review_count } : null,
      new_this_week: list.filter((r) => (r.published_at ?? '') >= weekAgo).length,
      reviews: list,
    };
  });
}

export function registerReviewRoutes(router, db, places) {
  router.get('/reviews', requirePerm('reviews.view'), (req, res) => {
    const locations = reportLocations(req, req.query.location_id);
    res.json({
      configured: !!places,
      last_sync: getSetting(db, KEY.lastSync),
      last_error: getSetting(db, KEY.lastError),
      sites: reviewSummary(db, locations),
    });
  });

  router.post('/reviews/sync', requirePerm('reviews.view'), async (req, res) => {
    if (!places) throw badRequest('Google reviews aren’t switched on yet – add GOOGLE_PLACES_API_KEY in your hosting settings.');
    const last = Date.parse(getSetting(db, KEY.lastSync) ?? '') || 0;
    if (Date.now() - last < MIN_MANUAL_GAP_MS) return res.json({ sites: 0, new_reviews: 0, errors: [], recent: true });
    res.json(await syncReviews(db, places));
  });

  // Setup → Locations: find a site on Google Maps and link it.
  router.get('/reviews/places', requireAdmin, async (req, res) => {
    if (!places) throw badRequest('Add GOOGLE_PLACES_API_KEY in your hosting settings first.');
    const q = str(req.query.q, 'Search', { required: true, max: 200 });
    res.json(await places.search(q));
  });

  router.put('/locations/:id/google-place', requireAdmin, async (req, res) => {
    const locationId = resolveLocation(req, id(req.params.id, 'Location', { required: true }));
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locationId)) throw notFound('Location');
    const placeId = req.body?.place_id ? str(req.body.place_id, 'Place', { max: 300 }) : null;
    if (placeId && !PLACE_ID.test(placeId)) throw badRequest('That doesn’t look like a Google place');
    // Check the place with Google before saving the link, so a wrong place isn't kept.
    const place = placeId && places ? await places.place(placeId) : null;
    if (placeId !== db.prepare('SELECT google_place_id FROM locations WHERE id = ?').get(locationId).google_place_id) {
      db.prepare('DELETE FROM google_reviews WHERE location_id = ?').run(locationId);
      db.prepare('DELETE FROM google_ratings WHERE location_id = ?').run(locationId);
    }
    db.prepare('UPDATE locations SET google_place_id = ? WHERE id = ?').run(placeId, locationId);
    if (place) saveSite(db, locationId, place, new Date());
    res.json({ ok: true, place_id: placeId });
  });
}
