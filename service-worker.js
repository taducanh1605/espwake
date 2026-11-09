const CACHE_NAME = "esp-wake-shell-v28-vault";
const APP_SHELL = [
    "./",
    "./index.html",
    "./css/styles.css?v=20261109-vault2",
    "./js/encrypted-config.js?v=20261109-vault3",
    "./js/script.js?v=20261109-vault3",
    "./manifest.webmanifest?v=3",
    "./icons/esp-wake-192.png?v=3",
    "./icons/esp-wake-512.png?v=3",
    "./icons/power-button.png?v=3",
];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key.startsWith("esp-wake-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (event) => {
    const requestUrl = new URL(event.request.url);
    if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin ||
        !requestUrl.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

    event.respondWith(
        fetch(event.request, { cache: "no-cache" })
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                if (cached) return cached;
                if (event.request.mode === "navigate") return caches.match("./index.html");
                return Response.error();
            }),
    );
});
