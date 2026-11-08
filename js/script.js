const DB_NAME = "ESPWakeDB";
const STORE_NAME = "settings";
const POLL_INTERVAL_MS = 7000;
const REQUEST_TIMEOUT_MS = 12000;
const STATUS_REQUEST_TIMEOUT_MS = 5500;
const STATUS_REQUEST_ATTEMPTS = 1;
const IDENTITY_PROBE_TIMEOUT_MS = 5500;
const ENDPOINT_REFRESH_MS = 300000;
const DEFAULT_PASSWORD = "12345678";

const computersList = document.getElementById("computers-list");
const emptyState = document.getElementById("empty-state");
const computerTemplate = document.getElementById("computer-template");
const addComputerButton = document.getElementById("add-computer");

let database;
let profiles = [];
let pollTimer;
let openSettingsProfileId = null;
const requestsInFlight = new Set();

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function readSetting(id) {
    return new Promise((resolve, reject) => {
        const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
    });
}

function writeSetting(id, value) {
    return new Promise((resolve, reject) => {
        const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put({ id, value });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function createProfile(overrides = {}) {
    return {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        name: "Computer",
        baseUrl: "",
        password: "",
        deviceHostname: "",
        endpointCandidates: [],
        endpointsUpdatedAt: 0,
        identityUnsupported: false,
        ...overrides,
    };
}

async function loadProfiles() {
    const storedProfiles = await readSetting("profiles");
    if (Array.isArray(storedProfiles)) {
        return storedProfiles.map(profile => ({
            ...profile,
            deviceHostname: (() => {
                try { return profile.deviceHostname ? normalizeDeviceHostname(profile.deviceHostname) : ""; }
                catch { return ""; }
            })(),
            endpointCandidates: Array.isArray(profile.endpointCandidates) ? profile.endpointCandidates : [],
            endpointsUpdatedAt: Number.isFinite(profile.endpointsUpdatedAt) ? profile.endpointsUpdatedAt : 0,
        }));
    }

    const oldBaseUrl = await readSetting("baseUrl");
    const oldPassword = await readSetting("password");
    const migrated = [createProfile({
        name: "Computer 1",
        baseUrl: oldBaseUrl || "",
        password: oldPassword || "",
    })];
    await writeSetting("profiles", migrated);
    return migrated;
}

function saveProfiles() {
    return writeSetting("profiles", profiles);
}

function normalizeBaseUrl(value) {
    let candidate = value.trim();
    if (!candidate) throw new Error("Enter an ESP32 address.");
    if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`;

    const parsed = new URL(candidate);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href.replace(/\/+$/, "");
}

function endpoint(profile, path) {
    return `${profile.baseUrl}/${path.replace(/^\/+/, "")}`;
}

function normalizeDeviceHostname(value) {
    const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
    const labels = hostname.split(".");
    const valid = hostname.length <= 253 && labels.length > 0 && labels.every(label =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
    if (!valid || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
        throw new Error("ESP32 returned an invalid device hostname identity.");
    }
    return hostname;
}

function identityMismatchError() {
    const error = new Error("This address belongs to a different ESP32. No password was sent.");
    error.code = "DEVICE_IDENTITY_MISMATCH";
    return error;
}

function bindDeviceIdentity(profile, identity) {
    const hostname = normalizeDeviceHostname(identity?.device_hostname);
    profile.identityUnsupported = false;
    if (profile.deviceHostname && profile.deviceHostname !== hostname) throw identityMismatchError();
    if (!profile.deviceHostname) profile.deviceHostname = hostname;
    return profile.deviceHostname;
}

function normalizeEndpointCandidates(response, expectedHostname) {
    if (normalizeDeviceHostname(response?.device_hostname) !== expectedHostname) throw identityMismatchError();
    if (!Array.isArray(response.https_endpoints)) throw new Error("ESP32 returned an invalid HTTPS endpoint list.");
    const candidates = [];
    const seen = new Set();
    response.https_endpoints.forEach(entry => {
        try {
            const url = new URL(entry.url);
            const address = String(entry.address || "").toLowerCase();
            const candidateHost = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
            if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
                candidateHost !== address || !url.port || !["ipv4", "ipv6", "hostname"].includes(entry.family) || seen.has(url.origin)) return;
            if ((entry.family === "ipv4" && (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) || address.split(".").some(part => Number(part) > 255))) ||
                (entry.family === "ipv6" && (!address.includes(":") || address.includes("%"))) ||
                (entry.family === "hostname" && (normalizeDeviceHostname(address) !== address || entry.source !== "duckdns"))) return;
            seen.add(url.origin);
            candidates.push({
                url: url.origin,
                address,
                family: entry.family,
                scope: String(entry.scope || "unknown"),
                source: String(entry.source || "unknown"),
            });
        } catch { /* Ignore malformed candidates from the device. */ }
    });
    return candidates;
}

async function fetchDeviceIdentity(baseUrl, { signal, timeoutMs = IDENTITY_PROBE_TIMEOUT_MS } = {}) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (new URL(normalized).protocol !== "https:") {
        const error = new Error("HTTPS is required for ESP32 identity discovery.");
        error.code = "IDENTITY_HTTPS_REQUIRED";
        throw error;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
        if (signal?.aborted) throw signal.reason;
        const response = await fetch(endpoint({ baseUrl: normalized }, "api/identity"), {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            signal: controller.signal,
        });
        if (!response.ok) {
            const error = new Error(`Identity HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return await response.json();
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

async function raceVerifiedCandidates(candidateUrls, expectedHostname, { signal, onProbeFailure } = {}) {
    expectedHostname = normalizeDeviceHostname(expectedHostname);
    const normalizedUrls = candidateUrls.flatMap(candidate => {
        try {
            const baseUrl = normalizeBaseUrl(candidate);
            return new URL(baseUrl).protocol === "https:" ? [baseUrl] : [];
        } catch { return []; }
    });
    const uniqueUrls = [...new Set(normalizedUrls)];
    if (!uniqueUrls.length) throw new Error("No HTTPS endpoint candidates are available.");
    let identityMismatches = 0;
    const failures = [];
    for (const baseUrl of uniqueUrls) {
        try {
            const identity = await fetchDeviceIdentity(baseUrl, { signal });
            if (normalizeDeviceHostname(identity.device_hostname) !== expectedHostname) {
                identityMismatches++;
                continue;
            }
            return baseUrl;
        } catch (error) {
            onProbeFailure?.(baseUrl);
            if (signal?.aborted) throw signal.reason;
            failures.push(error);
        }
    }
    if (identityMismatches && identityMismatches === uniqueUrls.length) throw identityMismatchError();
    const error = new Error("No reachable endpoint belongs to this ESP32. Check its hostname identity and network.");
    error.cause = failures;
    throw error;
}

async function refreshEndpointCandidates(profile, verifiedBaseUrl, { signal } = {}) {
    const response = await request(profile, "api/endpoints", authenticatedRequestOptions(profile), verifiedBaseUrl, { signal });
    const data = await response.json();
    const candidates = normalizeEndpointCandidates(data, profile.deviceHostname);
    profile.endpointCandidates = candidates;
    profile.endpointsUpdatedAt = Date.now();
    await saveProfiles();
    return candidates;
}

async function updateEndpointInventory(profile, verifiedBaseUrl, { forceProbe = false, signal } = {}) {
    const isStale = !profile.endpointsUpdatedAt || Date.now() - profile.endpointsUpdatedAt >= ENDPOINT_REFRESH_MS;
    const canRefresh = !profile.endpointsAttemptedAt || Date.now() - profile.endpointsAttemptedAt >= ENDPOINT_REFRESH_MS;
    if (profile.deviceHostname && isStale && (forceProbe || canRefresh)) {
        profile.endpointsAttemptedAt = Date.now();
        try {
            await refreshEndpointCandidates(profile, verifiedBaseUrl, { signal });
        } catch (error) {
            if (error.code === "DEVICE_IDENTITY_MISMATCH") throw error;
            console.warn("Endpoint inventory unavailable; retaining the verified connection.", error);
        }
    }
}

async function resolveFastestEndpoint(profile, {
    forceProbe = false, signal, skipInventory = false, failedUrls = new Set(),
} = {}) {
    const configuredBaseUrl = normalizeBaseUrl(profile.baseUrl);
    let verifiedBaseUrl = "";
    if (!profile.deviceHostname) {
        if (profile.identityUnsupported && !forceProbe && profile.identityProbeAt &&
            Date.now() - profile.identityProbeAt < ENDPOINT_REFRESH_MS) return configuredBaseUrl;
        profile.identityProbeAt = Date.now();
        try {
            const identity = await fetchDeviceIdentity(configuredBaseUrl, { signal });
            bindDeviceIdentity(profile, identity);
            verifiedBaseUrl = configuredBaseUrl;
            await saveProfiles();
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            // Old firmware's 404 lacks CORS headers, so browsers report a TypeError.
            // Compatibility is restricted to the URL explicitly saved by the user.
            if (error.status === 404 || error.status === 405 || error.name === "TypeError" ||
                error.code === "IDENTITY_HTTPS_REQUIRED") {
                profile.identityUnsupported = true;
                profile.selectedEndpoint = "";
                profile.endpointCandidates = [];
                console.warn("Identity unavailable; using only the configured URL for legacy compatibility.", error);
                await saveProfiles();
                return configuredBaseUrl;
            }
            throw error;
        }
    }

    if (!verifiedBaseUrl) {
        const cachedUrls = profile.endpointCandidates
            .filter(candidate => candidate && typeof candidate.url === "string")
            .map(candidate => candidate.url);
        const alternatives = [profile.selectedEndpoint, configuredBaseUrl, ...cachedUrls].filter(Boolean)
            .sort((left, right) => Number(failedUrls.has(normalizeBaseUrl(left))) - Number(failedUrls.has(normalizeBaseUrl(right))));
        verifiedBaseUrl = await raceVerifiedCandidates(alternatives, profile.deviceHostname, {
            signal, onProbeFailure: baseUrl => failedUrls.add(baseUrl),
        });
    }

    if (!skipInventory) await updateEndpointInventory(profile, verifiedBaseUrl, { forceProbe, signal });

    const changed = profile.selectedEndpoint !== verifiedBaseUrl;
    profile.selectedEndpoint = verifiedBaseUrl;
    profile.identityVerifiedAt = Date.now();
    if (changed) await saveProfiles();
    return verifiedBaseUrl;
}

const deviceOperations = new Map();
const remoteLaunches = new Set();

function withDeviceOperation(profile, operation) {
    const key = normalizeBaseUrl(profile.baseUrl);
    const previous = deviceOperations.get(key) || Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    deviceOperations.set(key, settled);
    settled.then(() => {
        if (deviceOperations.get(key) === settled) deviceOperations.delete(key);
    });
    return result;
}

async function requestDevice(profile, path, { forceProbe = false, retryStatus = false } = {}) {
    return withDeviceOperation(profile, async () => {
        if (path !== "stt" || !retryStatus) {
            const baseUrl = await resolveFastestEndpoint(profile, { forceProbe });
            return await request(profile, path, authenticatedRequestOptions(profile), baseUrl);
        }
        const failedUrls = new Set();
        for (let attempt = 1; attempt <= STATUS_REQUEST_ATTEMPTS; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS * attempt);
            let baseUrl;
            try {
                baseUrl = await resolveFastestEndpoint(profile, {
                    forceProbe: forceProbe && attempt === 1, signal: controller.signal, skipInventory: true, failedUrls,
                });
                const response = await request(profile, path, authenticatedRequestOptions(profile), baseUrl, { signal: controller.signal });
                await updateEndpointInventory(profile, baseUrl, { signal: controller.signal });
                return response;
            } catch (error) {
                if (baseUrl) failedUrls.add(normalizeBaseUrl(baseUrl));
                const transportFailure = controller.signal.aborted || error.name === "AbortError" ||
                    error.name === "TimeoutError" || error.name === "TypeError" ||
                    (Array.isArray(error.cause) && error.cause.length > 0 &&
                        error.cause.every(cause => ["AbortError", "TimeoutError", "TypeError"].includes(cause.name)));
                if (!transportFailure || attempt === STATUS_REQUEST_ATTEMPTS) throw error;
                console.warn(`Status transport attempt ${attempt}/${STATUS_REQUEST_ATTEMPTS} failed; retrying.`, error);
            } finally {
                clearTimeout(timeout);
            }
        }
    });
}

function findProfile(id) {
    return profiles.find((profile) => profile.id === id);
}

function findCard(id) {
    return computersList.querySelector(`[data-profile-id="${CSS.escape(id)}"]`);
}

function cardPart(card, role) {
    return card.querySelector(`[data-role="${role}"]`);
}

function setSettingsVisible(card, visible) {
    const form = cardPart(card, "settings-form");
    const configureButton = card.querySelector('[data-action="configure"]');
    form.hidden = !visible;
    form.classList.remove(!visible ? "show" : "hide")
    form.classList.add(!visible ? "hide" : "show")
    configureButton.setAttribute("aria-expanded", String(visible));
    configureButton.textContent = visible ? "×" : "⚙";
    configureButton.setAttribute("aria-label", visible ? "Close computer settings" : "Configure computer");
    configureButton.title = visible ? "Close computer settings" : "Configure computer";
    configureButton.classList.toggle("danger-button", visible);
}

async function request(profile, path, options = {}, baseUrl = profile.baseUrl, { signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = path === "stt" || path === "api/endpoints" ? STATUS_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        if (signal?.aborted) throw signal.reason;
        const response = await fetch(endpoint({ baseUrl }, path), {
            cache: "no-store",
            ...options,
            signal: controller.signal,
        });
        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        const body = await response.arrayBuffer();
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

function authenticatedRequestOptions(profile) {
    return profile.password
        ? {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: new URLSearchParams({ password: profile.password }),
        }
        : { method: "GET" };
}

function setConnection(card, state, label) {
    cardPart(card, "connection-pill").dataset.state = state;
    cardPart(card, "connection-label").textContent = label;
}

function hideConnectionHelp(card) {
    cardPart(card, "connection-help").hidden = true;
}

function showConnectionHelp(card, profile) {
    const help = cardPart(card, "connection-help");
    const helpText = cardPart(card, "connection-help-text");
    const certificateButton = card.querySelector('[data-action="trust-certificate"]');
    const deviceUrl = new URL(profile.baseUrl);
    const mixedContent = window.location.protocol === "https:" && deviceUrl.protocol === "http:";

    if (mixedContent) {
        helpText.textContent = "This HTTPS dashboard cannot contact an HTTP device. Use an HTTPS proxy or tunnel for this ESP32.";
        certificateButton.hidden = true;
    } else if (deviceUrl.protocol === "https:") {
        helpText.textContent = "If your browser allows self-signed certificates, open the security page and approve its warning. Status will retry when you return here.";
        certificateButton.hidden = false;
    } else {
        helpText.textContent = "Check that this address and port are reachable from your current network.";
        certificateButton.hidden = true;
    }
    help.hidden = false;
}

function renderPowerState(card, state) {
    card.querySelector('[data-action="remote"]').disabled = true;
    card.dataset.deviceState = state;
    const status = cardPart(card, "device-status");
    const signal = cardPart(card, "device-signal");
    const signalLabel = cardPart(card, "signal-label");
    const action = card.querySelector('[data-action="power"]');
    const label = cardPart(card, "power-label");
    action.disabled = false;

    if (state === "connected" || state === "up") {
        signal.dataset.state = "connected";
        signalLabel.textContent = "Connected";
        status.textContent = "Online and connected";
        action.dataset.powerMode = "shutdown";
        label.textContent = "Shut down";
    } else if (state === "powered") {
        signal.dataset.state = "powered";
        signalLabel.textContent = "Powered on";
        status.textContent = "Powered on, not responding on the network";
        action.dataset.powerMode = "force-shutdown";
        label.textContent = "Force off";
    } else if (state === "off" || state === "down") {
        signal.dataset.state = "off";
        signalLabel.textContent = "Off";
        status.textContent = "Powered off";
        action.dataset.powerMode = "wake";
        label.textContent = "Power on";
    } else {
        signal.dataset.state = "unknown";
        signalLabel.textContent = "Unknown";
        status.textContent = "Status unavailable";
        action.dataset.powerMode = "unknown";
        label.textContent = "Waiting";
        action.disabled = true;
    }
}

function renderProfiles() {
    computersList.replaceChildren();
    emptyState.hidden = profiles.length > 0;

    profiles.forEach((profile, index) => {
        const card = computerTemplate.content.firstElementChild.cloneNode(true);
        card.dataset.profileId = profile.id;
        cardPart(card, "display-name").textContent = profile.name;
        card.querySelector('[data-field="name"]').value = profile.name;
        card.querySelector('[data-field="base-url"]').value = profile.baseUrl;
        const passwordInput = card.querySelector('[data-field="password"]');
        const passwordTooltip = cardPart(card, "password-tooltip");
        passwordTooltip.id = `password-help-${profile.id}`;
        passwordInput.setAttribute("aria-describedby", passwordTooltip.id);
        card.querySelector('[data-action="clear-password"]').disabled = !profile.password;
        card.querySelector('[data-action="forget-device-identity"]').disabled = !profile.deviceHostname;
        const identity = cardPart(card, "device-identity");
        identity.textContent = profile.deviceHostname ? `Device: ${profile.deviceHostname}` : "Device identity not established";
        identity.hidden = !profile.deviceHostname;
        card.querySelector('[data-action="move-up"]').disabled = index === 0;
        card.querySelector('[data-action="move-down"]').disabled = index === profiles.length - 1;
        setSettingsVisible(card, profile.id === openSettingsProfileId);
        computersList.appendChild(card);
    });
}

function updateOrderControls() {
    profiles.forEach((profile, index) => {
        const card = findCard(profile.id);
        card.querySelector('[data-action="move-up"]').disabled = index === 0;
        card.querySelector('[data-action="move-down"]').disabled = index === profiles.length - 1;
    });
}

async function moveProfile(profile, offset) {
    const currentIndex = profiles.indexOf(profile);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= profiles.length) return;

    const card = findCard(profile.id);
    const targetCard = findCard(profiles[targetIndex].id);
    [profiles[currentIndex], profiles[targetIndex]] = [profiles[targetIndex], profiles[currentIndex]];
    try {
        await saveProfiles();
    } catch (error) {
        [profiles[currentIndex], profiles[targetIndex]] = [profiles[targetIndex], profiles[currentIndex]];
        const message = cardPart(card, "message");
        message.textContent = "The new order could not be saved.";
        message.classList.add("is-error");
        return;
    }

    if (offset < 0) {
        computersList.insertBefore(card, targetCard);
    } else {
        computersList.insertBefore(targetCard, card);
    }
    updateOrderControls();

    const preferredAction = offset < 0 ? "move-up" : "move-down";
    const fallbackAction = offset < 0 ? "move-down" : "move-up";
    const preferredButton = card.querySelector(`[data-action="${preferredAction}"]`);
    card.querySelector(`[data-action="${preferredButton.disabled ? fallbackAction : preferredAction}"]`).focus();
}

async function refreshProfile(profile, { quiet = false, forceProbe = false } = {}) {
    const card = findCard(profile.id);
    if (!card || requestsInFlight.has(profile.id)) return;

    if (!profile.baseUrl) {
        setConnection(card, "idle", "ESP Not configured");
        renderPowerState(card, "unknown");
        hideConnectionHelp(card);
        return;
    }

    requestsInFlight.add(profile.id);
    const refreshButton = card.querySelector('[data-action="refresh"]');
    if (!quiet) refreshButton.classList.add("is-loading");

    try {
        const response = await requestDevice(profile, "stt", { forceProbe, retryStatus: true });
        const identity = cardPart(card, "device-identity");
        identity.textContent = profile.deviceHostname ? `Device: ${profile.deviceHostname}` : "Device identity: legacy firmware";
        identity.hidden = false;
        card.querySelector('[data-action="forget-device-identity"]').disabled = !profile.deviceHostname;
        const data = await response.json();
        const device = Object.values(data)[0];
        if (!device || typeof device.stat !== "string") throw new Error("Invalid status response");

        renderPowerState(card, device.stat.toLowerCase());
        const remote = card.querySelector('[data-action="remote"]');
        const pcOnline = ["connected", "up"].includes(device.stat.toLowerCase());
        const remoteEnabled = device.remote?.enabled === true;
        const unavailable = !pcOnline || !remoteEnabled || !device.remote?.host || !profile.password;
        remote.disabled = unavailable || remoteLaunches.has(profile.id);
        remote.classList.toggle("is-unavailable", unavailable);
        remote.title = !remoteEnabled ? "RemotePC is disabled. Enable it in the ESP32 configuration."
            : !pcOnline ? "PC is offline. Wake it before connecting."
            : !device.remote?.host || !profile.password ? "Waiting for Njk Host and an ESP32 control password"
            : device.remote.available ? "Connect to remote desktop" : "Connect when the helper refreshes access";
        setConnection(card, "online", "ESP Connected");
        hideConnectionHelp(card);
        cardPart(card, "last-updated").textContent = `Updated at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    } catch (error) {
        console.error(`Status request failed for ${profile.name}:`, error);
        renderPowerState(card, "unknown");
        if (error.code === "DEVICE_IDENTITY_MISMATCH") {
            setConnection(card, "error", "ESP32 identity mismatch");
            cardPart(card, "device-status").textContent = error.message;
            hideConnectionHelp(card);
        } else if (error.status === 401 || error.status === 403) {
            setConnection(card, "error", "Authentication failed");
            cardPart(card, "device-status").textContent = "Cannot authenticate with this ESP32";
            cardPart(card, "last-updated").textContent = "Check or clear the saved control password.";
            hideConnectionHelp(card);
        } else {
            setConnection(card, "error", "ESP Offline");
            cardPart(card, "device-status").textContent = "Cannot reach this ESP32";
            cardPart(card, "last-updated").textContent = "Check its address, proxy, or network connection.";
            showConnectionHelp(card, profile);
        }
    } finally {
        requestsInFlight.delete(profile.id);
        refreshButton.classList.remove("is-loading");
    }
}

function refreshAll({ quiet = false } = {}) {
    profiles.forEach((profile) => refreshProfile(profile, { quiet }));
}

function schedulePolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        if (!document.hidden) refreshAll({ quiet: true });
    }, POLL_INTERVAL_MS);
}

async function sendPowerCommand(profile, card, forceShutdown = false) {
    const state = card.dataset.deviceState;
    let path;
    let confirmation;

    if (forceShutdown) {
        path = "sd";
        confirmation = `Force shutdown ${profile.name}?`;
    } else if (state === "connected" || state === "up") {
        path = "pw";
        confirmation = `Send a shutdown command to ${profile.name}?`;
    } else if (state === "powered") {
        path = "sd";
        confirmation = `${profile.name} is not responding on the network. Force it off?`;
    } else if (state === "off" || state === "down") {
        path = "pw";
    } else {
        return;
    }

    if (confirmation && !window.confirm(confirmation)) return;

    const action = card.querySelector(forceShutdown ? '[data-action="force-shutdown"]' : '[data-action="power"]');
    const label = forceShutdown ? action : cardPart(card, "power-label");
    const originalLabel = label.textContent;
    const message = cardPart(card, "message");
    action.disabled = true;
    label.textContent = "Sending...";
    message.classList.remove("is-error");

    try {
        await requestDevice(profile, path);
        cardPart(card, "last-updated").textContent = "Command sent. Waiting for the next status update...";
        setTimeout(() => refreshProfile(profile), 1200);
    } catch (error) {
        console.error(`Power command failed for ${profile.name}:`, error);
        message.textContent = error.code === "DEVICE_IDENTITY_MISMATCH"
            ? error.message
            : profile.password ? "Command failed. Check the saved password and connection." : "The power command could not be sent.";
        message.classList.add("is-error");
        renderPowerState(card, state);
    } finally {
        if (forceShutdown) {
            action.disabled = false;
            label.textContent = originalLabel;
        }
    }
}

function openConfiguration(profile, button, verifiedBaseUrl = profile.baseUrl, reservedWindow = null, loadingStop = null) {
    if (!profile.baseUrl) throw new Error("Enter and save an ESP32 address first.");

    const baseUrl = normalizeBaseUrl(verifiedBaseUrl);

    const installedApp = window.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen)").matches
        || navigator.standalone === true;

    if (!profile.password && !button) {
        window.open(`${baseUrl}/`, "_blank", "noopener,noreferrer");
        return;
    }

    if (button?.disabled && !loadingStop) return;
    const configWindow = installedApp && profile.password ? window : reservedWindow || window.open("about:blank", "_blank");
    if (!configWindow) throw new Error("Allow pop-ups to open the configuration page.");

    const stopLoading = loadingStop || (button ? showConfigurationLoading(button, configWindow) : () => {});
    try {
        if (!profile.password) {
            configWindow.opener = null;
            configWindow.location.href = `${baseUrl}/`;
            return;
        }
        const formDocument = installedApp ? document : configWindow.document;
        const loginForm = formDocument.createElement("form");
        loginForm.method = "POST";
        loginForm.enctype = "application/x-www-form-urlencoded";
        loginForm.action = endpoint({ baseUrl }, "login");
        loginForm.target = "_self";
        loginForm.hidden = true;

        const passwordField = formDocument.createElement("input");
        passwordField.type = "hidden";
        passwordField.name = "password";
        passwordField.value = profile.password;
        loginForm.appendChild(passwordField);
        formDocument.body.appendChild(loginForm);
        if (!installedApp) configWindow.opener = null;
        loginForm.submit();
    } catch (error) {
        stopLoading();
        throw error;
    }
}

function openProfileConfiguration(profile, button) {
    let baseUrl = profile.deviceHostname ? profile.selectedEndpoint || profile.baseUrl : profile.baseUrl;

    if (!profile.deviceHostname) {
        openConfiguration({ ...profile, password: "" }, button, baseUrl);
        return Promise.resolve(false);
    }

    const installedApp = window.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen)").matches
        || navigator.standalone === true;
    const configWindow = installedApp && profile.password ? window : window.open("about:blank", "_blank");
    if (!configWindow) throw new Error("Allow pop-ups to open the configuration page.");
    const stopLoading = button ? showConfigurationLoading(button, configWindow) : () => {};

    return withDeviceOperation(profile, () => resolveFastestEndpoint(profile)).then((verifiedBaseUrl) => {
        openConfiguration(profile, button, verifiedBaseUrl, configWindow, stopLoading);
        return true;
    }, (error) => {
        if (error.code === "DEVICE_IDENTITY_MISMATCH") {
            stopLoading();
            if (configWindow !== window) configWindow.close();
            throw error;
        }
        openConfiguration({ ...profile, password: "" }, button, baseUrl, configWindow, stopLoading);
        return false;
    });
}

function showConfigurationLoading(button, configWindow) {
    const originalIcon = button.innerHTML;
    const originalDocument = configWindow.document;
    const spinner = document.createElement("span");
    spinner.className = "config-spinner";
    spinner.setAttribute("aria-hidden", "true");
    button.replaceChildren(spinner);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    let interval;
    let timeout;
    const stopLoading = () => {
        clearInterval(interval);
        clearTimeout(timeout);
        window.removeEventListener("pageshow", stopLoading);
        button.innerHTML = originalIcon;
        button.disabled = false;
        button.removeAttribute("aria-busy");
    };
    window.addEventListener("pageshow", stopLoading);
    if (configWindow !== window) {
        interval = setInterval(() => {
            try {
                if (configWindow.closed || configWindow.document !== originalDocument) stopLoading();
            } catch {
                stopLoading();
            }
        }, 200);
    }
    timeout = setTimeout(stopLoading, 30000);
    return stopLoading;
}

function openCertificateCheck(profile) {
    const baseUrl = normalizeBaseUrl(profile.baseUrl);
    window.open(endpoint({ baseUrl }, "certificate-check"), "_blank", "noopener,noreferrer");
}

async function openRemoteDesktop(profile, card, button) {
    if (remoteLaunches.has(profile.id)) return;
    if (!profile.password) throw new Error("Configure an ESP32 control password before launching remote desktop.");
    const remoteWindow = window.open("about:blank", "_blank");
    if (!remoteWindow) throw new Error("Allow pop-ups to open RemotePC.");
    remoteLaunches.add(profile.id);
    button.disabled = true;
    const origin = "https://taducanh1605.github.io";
    const nonce = crypto.randomUUID();
    const broker = typeof BroadcastChannel === "function" ? new BroadcastChannel(`njk-handoff-${nonce}`) : null;
    let cleanup, refreshing = false, disposed = false;
    async function freshTicket() {
        const deadline = Date.now() + 75000;
        for (;;) {
            try {
                const response = await requestDevice(profile, "api/remote", { forceProbe: true });
                const data = await response.json();
                const host = new URL(data.host);
                if (host.protocol !== "https:" || host.username || host.password || host.pathname !== "/" || host.search || host.hash ||
                    !/^[a-f0-9]{32}$/.test(data.ticket || "")) throw new Error("ESP32 returned an invalid Njk Host connection.");
                cardPart(card, "message").textContent = "";
                return { host: host.origin, ticket: data.ticket };
            } catch (error) {
                if (error.status !== 503 || Date.now() >= deadline || disposed) throw error;
                cardPart(card, "message").textContent = "Waiting for the Windows helper to refresh remote access…";
                await new Promise(resolve => setTimeout(resolve, 2500));
            }
        }
    }
    const refresh = async (message, reply) => {
        if (disposed || message?.nonce !== nonce) return;
        if (message.type === "njk-handoff-complete") { cleanup(); return; }
        if (message.type !== "njk-refresh-ticket" || refreshing) return;
        refreshing = true;
        try {
            const data = await freshTicket();
            if (!disposed) reply({ type: "njk-fresh-ticket", nonce, ...data });
        } catch (error) {
            if (!disposed) reply({ type: "njk-fresh-ticket", nonce, error: error.message });
        } finally { refreshing = false; }
    };
    const receive = event => {
        if (event.source !== remoteWindow || event.origin !== origin) return;
        return refresh(event.data, message => remoteWindow.postMessage(message, origin));
    };
    window.addEventListener("message", receive);
    if (broker) broker.onmessage = event => refresh(event.data, message => broker.postMessage(message));
    // A detached standalone window may report closed while still running.
    const closedTimer = setTimeout(() => cleanup(), 240000);
    cleanup = () => { disposed = true; clearTimeout(closedTimer); window.removeEventListener("message", receive); broker?.close(); };
    try {
        const data = await freshTicket();
        const fragment = new URLSearchParams({ ...data, fullscreen: "1", return: "espwake", nonce });
        remoteWindow.location.href = `https://taducanh1605.github.io/remotepc/?v=20261108-auth4#${fragment}`;
    } catch (error) {
        cleanup();
        remoteWindow.close();
        throw error;
    } finally {
        remoteLaunches.delete(profile.id);
        await refreshProfile(profile, { quiet: true });
    }
}

computersList.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target.closest('[data-role="settings-form"]');
    if (!form) return;
    const card = form.closest(".computer-card");
    const profile = findProfile(card.dataset.profileId);
    const message = cardPart(card, "message");
    message.classList.remove("is-error");

    try {
        profile.name = form.querySelector('[data-field="name"]').value.trim() || "Computer";
        const previousBaseUrl = profile.baseUrl;
        profile.baseUrl = normalizeBaseUrl(form.querySelector('[data-field="base-url"]').value);
        if (previousBaseUrl !== profile.baseUrl) {
            profile.identityUnsupported = false;
            profile.selectedEndpoint = "";
            profile.endpointsUpdatedAt = 0;
            profile.endpointsAttemptedAt = 0;
        }
        const newPassword = form.querySelector('[data-field="password"]').value;
        if (newPassword) profile.password = newPassword;
        else if (!profile.password) profile.password = DEFAULT_PASSWORD;

        await saveProfiles();
        cardPart(card, "display-name").textContent = profile.name;
        form.querySelector('[data-field="base-url"]').value = profile.baseUrl;
        form.querySelector('[data-field="password"]').value = "";
        card.querySelector('[data-action="clear-password"]').disabled = !profile.password;
        message.textContent = newPassword
            ? "Address and control password updated."
            : "Settings updated; the saved password was kept.";
        await refreshProfile(profile);
    } catch (error) {
        message.textContent = error.message || "Settings could not be saved.";
        message.classList.add("is-error");
    }
});

computersList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const card = button.closest(".computer-card");
    const profile = findProfile(card.dataset.profileId);
    const message = cardPart(card, "message");

    if (button.dataset.action === "power") {
        await sendPowerCommand(profile, card);
    } else if (button.dataset.action === "force-shutdown") {
        await sendPowerCommand(profile, card, true);
    } else if (button.dataset.action === "refresh") {
        await refreshProfile(profile, { forceProbe: true });
    } else if (button.dataset.action === "configure") {
        openSettingsProfileId = cardPart(card, "settings-form").hidden ? profile.id : null;
        setSettingsVisible(card, openSettingsProfileId === profile.id);
    } else if (button.dataset.action === "config") {
        try {
            const identityVerified = await openProfileConfiguration(profile, button);
            if (!identityVerified) {
                message.textContent = "Configuration opened without automatic sign-in because this device's identity could not be verified.";
                message.classList.remove("is-error");
            }
        } catch (error) {
            message.textContent = error.message;
            message.classList.add("is-error");
        }
    } else if (button.dataset.action === "remote") {
        try {
            await openRemoteDesktop(profile, card, button);
        } catch (error) {
            message.textContent = error.message;
            message.classList.add("is-error");
            cardPart(card, "device-status").textContent = error.message;
        }
    } else if (button.dataset.action === "trust-certificate") {
        openCertificateCheck(profile);
    } else if (button.dataset.action === "forget-device-identity") {
        if (!profile.deviceHostname || !window.confirm(`Forget the saved ESP32 identity for ${profile.name}? The next reachable device will be bound to this profile.`)) return;
        const previous = {
            deviceHostname: profile.deviceHostname,
            endpointCandidates: profile.endpointCandidates,
            endpointsUpdatedAt: profile.endpointsUpdatedAt,
            identityUnsupported: profile.identityUnsupported,
        };
        profile.deviceHostname = "";
        profile.endpointCandidates = [];
        profile.endpointsUpdatedAt = 0;
        profile.identityUnsupported = false;
        try {
            await saveProfiles();
            card.querySelector('[data-action="forget-device-identity"]').disabled = true;
            cardPart(card, "device-identity").hidden = true;
            message.textContent = "Saved device identity forgotten. Reconnecting will bind a hostname from the ESP32.";
            message.classList.remove("is-error");
            await refreshProfile(profile);
        } catch (error) {
            Object.assign(profile, previous);
            cardPart(card, "device-identity").textContent = `Device: ${profile.deviceHostname}`;
            cardPart(card, "device-identity").hidden = false;
            card.querySelector('[data-action="forget-device-identity"]').disabled = !profile.deviceHostname;
            message.textContent = "The saved device identity could not be cleared.";
            message.classList.add("is-error");
        }
    } else if (button.dataset.action === "clear-password") {
        if (!profile.password || !window.confirm(`Clear the saved control password for ${profile.name} from this browser? This does not change password protection on the ESP32.`)) return;
        const previousPassword = profile.password;
        profile.password = DEFAULT_PASSWORD;
        try {
            await saveProfiles();
            card.querySelector('[data-field="password"]').value = "";
            button.disabled = true;
            message.textContent = "Browser password cleared. Future commands will use GET without a password.";
            message.classList.remove("is-error");
        } catch (error) {
            profile.password = previousPassword;
            message.textContent = "The saved control password could not be cleared.";
            message.classList.add("is-error");
        }
    } else if (button.dataset.action === "move-up") {
        await moveProfile(profile, -1);
    } else if (button.dataset.action === "move-down") {
        await moveProfile(profile, 1);
    } else if (button.dataset.action === "delete") {
        if (!window.confirm(`Delete ${profile.name}?`)) return;
        profiles = profiles.filter((item) => item.id !== profile.id);
        if (openSettingsProfileId === profile.id) openSettingsProfileId = null;
        requestsInFlight.delete(profile.id);
        await saveProfiles();
        renderProfiles();
        refreshAll();
    }
});

addComputerButton.addEventListener("click", async () => {
    const profile = createProfile({ name: `Computer ${profiles.length + 1}` });
    profiles.push(profile);
    await saveProfiles();
    openSettingsProfileId = profile.id;
    renderProfiles();
    refreshAll();
    findCard(profile.id)?.querySelector('[data-field="name"]').focus();
});

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAll({ quiet: true });
});

(async function initialize() {
    try {
        database = await openDatabase();
        profiles = await loadProfiles();
        renderProfiles();
        refreshAll();
        schedulePolling();
    } catch (error) {
        console.error("Initialization failed:", error);
        emptyState.hidden = false;
        emptyState.querySelector("p").textContent = "Saved settings could not be loaded in this browser.";
    }
})();

if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js").catch((error) => {
            console.error("Service worker registration failed:", error);
        });
    });
}
