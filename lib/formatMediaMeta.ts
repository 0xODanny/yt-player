/**
 * Short labels for “how old is this upload?” (search) or “when was it
 * saved?” (library) on thumbnail overlays — compact for small tiles.
 */

function startOfTodayUtc(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * YouTube-ish relative / compact date for search result upload time.
 */
export function formatPublishedAgeShort(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const dayMs = 86400_000;
  const now = Date.now();
  const startToday = startOfTodayUtc();
  const dayStart = Date.UTC(
    new Date(ms).getUTCFullYear(),
    new Date(ms).getUTCMonth(),
    new Date(ms).getUTCDate(),
  );
  const diffDays = Math.floor((startToday - dayStart) / dayMs);
  if (diffDays <= 0) {
    return "New";
  }
  if (diffDays === 1) {
    return "1d";
  }
  if (diffDays < 7) {
    return `${diffDays}d`;
  }
  if (diffDays < 56) {
    return `${Math.floor(diffDays / 7)}w`;
  }
  if (diffDays < 365) {
    return `${Math.floor(diffDays / 30)}mo`;
  }
  if (diffDays < 365 * 2) {
    return "1y+";
  }
  return `${Math.floor(diffDays / 365)}y`;
}

/** When the item was saved to the library (device clock). */
export function formatLibraryAddedShort(createdAtMs: number): string | null {
  if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    return null;
  }
  const diffMs = Date.now() - createdAtMs;
  if (diffMs < 0) {
    return "New";
  }
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 90) {
    return mins < 1 ? "Now" : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 14) {
    return `${days}d`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)}w`;
  }
  const d = new Date(createdAtMs);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
