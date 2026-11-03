// Google Routes API adapter (browser). Called directly from the page with the key from Settings;
// routes.googleapis.com allows cross-origin calls (checked 3 Nov 2026). Field mask keeps billing to duration only.

const URL_ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
export const BUCKET_MIN = 30; // departure times are rounded to this, so nearby options share a request

/** Local minutes (UK/IE wall clock) -> RFC3339 UTC, using the Europe/London offset at that moment. */
export function localToUtcIso(localMin) {
  const guess = new Date(localMin * 60000);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
  const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asLocal = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute) / 60000;
  const offset = asLocal - localMin; // minutes local is ahead of UTC
  return new Date((localMin - offset) * 60000).toISOString();
}

export function bucket(min) { return Math.round(min / BUCKET_MIN) * BUCKET_MIN; }

export async function driveMinutes({ key, origin, destination, departLocalMin, nowMs, fetchFn = fetch }) {
  const body = {
    origin: { address: origin }, destination: { address: destination },
    travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE",
  };
  // Google rejects past departure times; for those, ask without one (current/typical conditions).
  const iso = localToUtcIso(departLocalMin);
  if (Date.parse(iso) > nowMs + 60000) body.departureTime = iso;
  const res = await fetchFn(URL_ROUTES, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Routes ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const d = j.routes?.[0]?.duration;
  if (!d) throw new Error("Google Routes: no route");
  return Math.round(parseInt(d, 10) / 60);
}
