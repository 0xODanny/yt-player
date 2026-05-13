/* eslint-disable no-restricted-globals */

const CACHE_VERSION = "yt-local-tool-v1-1-15";
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL_URLS = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      try {
        await cache.addAll(APP_SHELL_URLS);
      } catch {
        // App shell pre-cache is best effort; runtime caching will pick things up.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/files/") || url.pathname.startsWith("/jobs");
}

function isHtmlRequest(request) {
  return request.mode === "navigate" || request.headers.get("accept")?.includes("text/html");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Never cache cross-origin requests (worker API, YouTube thumbnails, etc.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Let the browser handle media fetches directly (never cache through SW).
  if (request.destination === "audio" || request.destination === "video") {
    event.respondWith(fetch(request));
    return;
  }

  if (isApiRequest(url)) {
    return;
  }

  if (isHtmlRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone()).catch(() => undefined);
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    const shellCache = await caches.open(APP_SHELL_CACHE);
    const shellMatch = await shellCache.match("/");
    if (shellMatch) {
      return shellMatch;
    }

    return new Response(
      "<!doctype html><meta charset=\"utf-8\"><title>Offline</title><h1>Offline</h1><p>This page is not available without a network connection.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await cache.match(request);

  const networkPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        cache.put(request, networkResponse.clone()).catch(() => undefined);
      }
      return networkResponse;
    })
    .catch(() => undefined);

  return cachedResponse || (await networkPromise) || Response.error();
}
