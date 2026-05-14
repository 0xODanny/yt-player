/**
 * Browser origins allowed to call the worker API (CORS).
 *
 * `www` and bare host are different origins. iOS PWAs keep whatever
 * start_url they were installed from — if ALLOWED_ORIGIN only listed
 * `https://pepinho.lol` but the user installed from `https://www.pepinho.lol`,
 * every /stream and /jobs preflight would fail while youtube.com in
 * Brave still works (different site entirely).
 */
export function buildAllowedOrigins(): string[] {
  const fromEnv = (process.env.ALLOWED_ORIGIN?.trim() || "http://localhost:3002")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const canonicalPepinho = ["https://pepinho.lol", "https://www.pepinho.lol"];

  return [...new Set([...fromEnv, ...canonicalPepinho])];
}
