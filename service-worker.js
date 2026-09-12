const CACHE_NAME = "esp-wake-shell-v5";
const APP_SHELL = [
    "./",
    "./index.html",
    "./css/styles.css?v=20260912-8",
    "./js/script.js?v=20260912-3",
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
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (event) => {
    const requestUrl = new URL(event.request.url);
    if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

    event.respondWith(
        fetch(event.request)
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
