/**
 * Canonical-origin detection for the PWA.
 *
 * Background: pepinho.lol and www.pepinho.lol are TWO origins as far as
 * the browser security model is concerned. OPFS, localStorage,
 * IndexedDB, the `navigator.storage.persist()` grant, the PWA install
 * record, and Service Worker registrations are each scoped to the
 * exact origin string. A user who installs the PWA from
 * `https://www.pepinho.lol` and later opens `https://pepinho.lol` will
 * see a completely empty library: their files still exist on disk, but
 * they're partitioned away on the other origin.
 *
 * The Vercel deploy now 308-redirects www → bare so future browser
 * visits land on a single canonical host (see next.config.ts). The
 * in-app banner powered by this helper covers two remaining cases:
 *
 *   1. Existing PWA installations at www.pepinho.lol. iOS opens the
 *      saved start_url and the 308 redirect kicks them out to Safari —
 *      from their perspective the PWA "broke." We want to tell them
 *      what happened and how to recover (export → reinstall → import).
 *
 *   2. Any future custom subdomain or alternate host that bypasses the
 *      Vercel redirect (e.g. an old shared link to a preview deploy or
 *      vercel.app subdomain). The banner reminds the user where the
 *      canonical install lives.
 *
 * Capacitor wrappers report origin as `https://localhost` (Android,
 * with androidScheme="https") — these are not the PWA, so the banner
 * stays hidden. Local dev (localhost:3002) and Vercel preview deploys
 * (*.vercel.app) are also hidden so we don't spam ourselves.
 */

import { isNative } from "./platform";

export const CANONICAL_HOST = "pepinho.lol";
export const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

export type OriginStatus =
  | { kind: "canonical" }
  | { kind: "native" }
  | { kind: "dev" }
  | { kind: "preview" }
  | { kind: "mismatch"; currentOrigin: string; currentHost: string };

/**
 * Classify the current runtime's origin. Designed to be called from a
 * client-side effect (returns "canonical" during SSR so nothing ever
 * renders the banner on the first paint).
 */
export function detectOriginStatus(): OriginStatus {
  if (typeof window === "undefined") {
    return { kind: "canonical" };
  }
  if (isNative()) {
    return { kind: "native" };
  }

  const host = window.location.hostname.toLowerCase();
  const origin = window.location.origin;

  if (host === CANONICAL_HOST) {
    return { kind: "canonical" };
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) {
    return { kind: "dev" };
  }
  if (host.endsWith(".vercel.app")) {
    return { kind: "preview" };
  }

  return { kind: "mismatch", currentOrigin: origin, currentHost: host };
}

/**
 * Build the canonical-origin equivalent of the current URL so the
 * banner can offer a one-click migration link. Preserves path + search
 * + hash so deep links keep working after the user re-installs.
 */
export function canonicalUrlForCurrentPage(): string {
  if (typeof window === "undefined") return CANONICAL_ORIGIN + "/";
  const { pathname, search, hash } = window.location;
  return `${CANONICAL_ORIGIN}${pathname}${search}${hash}`;
}
