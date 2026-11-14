const DB_NAME = "ESPWakeDB";
const STORE_NAME = "settings";
const POLL_INTERVAL_MS = 7000;
const REQUEST_TIMEOUT_MS = 12000;
const STATUS_REQUEST_TIMEOUT_MS = 45000;
const STATUS_REQUEST_ATTEMPTS = 1;
const IDENTITY_PROBE_TIMEOUT_MS = 15000;
const ENDPOINT_REFRESH_MS = 300000;
const HIDDEN_VAULT_GRACE_MS = 60000;
const DEFAULT_PASSWORD = "12345678";

const computersList = document.getElementById("computers-list");
const emptyState = document.getElementById("empty-state");
const computerTemplate = document.getElementById("computer-template");
const addComputerButton = document.getElementById("add-computer");

let database;
let profiles = [];
let pollTimer;
let openSettingsProfileId = null;
let vaultKey;
let vaultSalt;
let biometricMetadata = null;
let biometricSupported = false;
let biometricEnrollmentPending = false;
let vaultEpoch = 0;
let vaultHiddenAt = null;
let vaultHiddenTimer;
let saveQueue = Promise.resolve();
const requestsInFlight = new Set();
const vaultForm = document.getElementById("vault-form");
const vaultPanel = document.getElementById("vault-panel");
const vaultPassword = document.getElementById("vault-password");
const vaultConfirm = document.getElementById("vault-confirm");
const vaultMessage = document.getElementById("vault-message");
const dashboard = document.getElementById("dashboard");
const transferDialog = document.getElementById("transfer-dialog");
const transferForm = document.getElementById("transfer-form");
const transferPassword = document.getElementById("transfer-password");
const transferConfirm = document.getElementById("transfer-confirm");
const transferFile = document.getElementById("transfer-file");
const transferMessage = document.getElementById("transfer-message");
const lockSettingsButton = document.getElementById("lock-settings");
const biometricUnlockButton = document.getElementById("biometric-unlock");
const enableBiometricButton = document.getElementById("enable-biometric");
const removeBiometricButton = document.getElementById("remove-biometric");
const biometricSupportMessage = document.getElementById("biometric-support-message");
const biometricDialog = document.getElementById("biometric-dialog");
const biometricForm = document.getElementById("biometric-form");
const biometricPassword = document.getElementById("biometric-password");
const biometricMessage = document.getElementById("biometric-message");
let transferMode = "export";
let transferProfileId = null;
let transferTrigger;
let creatingVault = false;

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

function writeVault(value, { rekeyed = false } = {}) {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const previous = store.get("encryptedProfiles");
        let invalidatesUnlock = false;
        previous.onsuccess = () => {
            invalidatesUnlock = rekeyed || !previous.result?.value || previous.result.value.salt !== value.salt;
            if (invalidatesUnlock) {
                store.delete("biometricUnlock");
                store.delete("deviceUnlockKey");
            }
            store.put({ id: "encryptedProfiles", value });
            ["profiles", "baseUrl", "password"].forEach(id => store.delete(id));
        };
        previous.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            if (invalidatesUnlock) {
                biometricMetadata = null;
                biometricUnlockButton.hidden = true;
                removeBiometricButton.hidden = true;
                enableBiometricButton.hidden = !biometricSupported;
                if (!dashboard.hidden) {
                    clearActiveVault();
                    showVaultForm("Vault encryption changed. The previous authenticator was removed; unlock with the current settings passphrase.");
                }
            }
            resolve();
        };
        transaction.onabort = () => reject(transaction.error || new Error("Encrypted settings transaction was aborted."));
        transaction.onerror = () => reject(transaction.error);
    });
}

function writeDeviceUnlock(key) {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({ id: "deviceUnlockKey", value: key });
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error("Browser unlock could not be saved."));
        transaction.onerror = () => reject(transaction.error);
    });
}

function forgetDeviceUnlock() {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete("deviceUnlockKey");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error("Browser unlock could not be cleared."));
        transaction.onerror = () => reject(transaction.error);
    });
}

function writeBiometricMetadata(value) {
    EncryptedConfig.validateBiometricMetadata(value);
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.put({ id: "biometricUnlock", value });
        store.delete("deviceUnlockKey");
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("Device authenticator setup could not be saved."));
        transaction.onerror = () => reject(transaction.error);
    });
}

function forgetBiometricMetadata() {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.delete("biometricUnlock");
        store.delete("deviceUnlockKey");
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("Device authenticator could not be removed."));
        transaction.onerror = () => reject(transaction.error);
    });
}

function rememberRemoteHost(profileId, host) {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({ id: `remoteHost-${profileId}`, value: host });
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("Remote host binding could not be saved."));
        transaction.onerror = () => reject(transaction.error);
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

async function loadProfiles(password, expectedEpoch = vaultEpoch) {
    const encrypted = await readSetting("encryptedProfiles");
    if (encrypted !== null) {
        const unlocked = await EncryptedConfig.open(encrypted, password);
        if (expectedEpoch !== vaultEpoch) return null;
        const biometric = await readSetting("biometricUnlock");
        if (expectedEpoch !== vaultEpoch) return null;
        if (biometric) {
            await forgetDeviceUnlock();
            biometricMetadata = biometric;
        } else {
            await writeDeviceUnlock(unlocked.key);
        }
        return unlocked;
    }
    const storedProfiles = await readSetting("profiles");
    let migrated;
    if (Array.isArray(storedProfiles)) {
        migrated = storedProfiles.map(profile => ({
            ...profile,
            baseUrl: profile.baseUrl ? normalizeBaseUrl(profile.baseUrl) : "",
            deviceHostname: (() => {
                try { return profile.deviceHostname ? normalizeDeviceHostname(profile.deviceHostname) : ""; }
                catch { return ""; }
            })(),
            endpointCandidates: Array.isArray(profile.endpointCandidates) ? profile.endpointCandidates : [],
            endpointsUpdatedAt: Number.isFinite(profile.endpointsUpdatedAt) ? profile.endpointsUpdatedAt : 0,
        }));
    } else {
        if (storedProfiles !== null) throw new Error("Legacy settings are damaged; they have not been overwritten.");
        const oldBaseUrl = await readSetting("baseUrl");
        const oldPassword = await readSetting("password");
        migrated = oldBaseUrl || oldPassword ? [createProfile({
            name: "Computer 1",
            baseUrl: oldBaseUrl ? normalizeBaseUrl(oldBaseUrl) : "",
            password: oldPassword || "",
        })] : [];
    }
    const created = await EncryptedConfig.create(migrated, password);
    if (expectedEpoch !== vaultEpoch) return null;
    await writeVault(created.envelope);
    if (expectedEpoch !== vaultEpoch) return null;
    await writeDeviceUnlock(created.key);
    return { key: created.key, salt: created.salt, profiles: migrated };
}

async function loadRememberedProfiles(expectedEpoch = vaultEpoch) {
    const encrypted = await readSetting("encryptedProfiles");
    const biometric = await readSetting("biometricUnlock");
    const key = await readSetting("deviceUnlockKey");
    if (expectedEpoch !== vaultEpoch) return null;
    biometricMetadata = biometric;
    if (biometric !== null) {
        await forgetDeviceUnlock();
        return null;
    }
    if (encrypted === null || key === null) return null;
    try {
        const unlocked = await EncryptedConfig.openWithKey(encrypted, key);
        if (expectedEpoch !== vaultEpoch) return null;
        vaultKey = unlocked.key;
        vaultSalt = unlocked.salt;
        return unlocked.profiles;
    } catch (error) {
        await forgetDeviceUnlock();
        return null;
    }
}

function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
}

function encodeCredentialId(bytes) {
    let binary = "";
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCredentialId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,2048}$/.test(value)) {
        throw new Error("Saved device authenticator data is invalid.");
    }
    const standard = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (encodeCredentialId(bytes) !== value) throw new Error("Saved device authenticator data is invalid.");
    return bytes;
}

async function getBiometricCapability() {
    if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential ||
        !navigator.credentials?.create || !navigator.credentials?.get ||
        typeof PublicKeyCredential.getClientCapabilities !== "function" ||
        typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
        return { supported: false, reason: "This browser does not expose secure platform-authenticator PRF support." };
    }
    try {
        const [capabilities, platformAvailable] = await Promise.all([
            PublicKeyCredential.getClientCapabilities(),
            PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
        ]);
        if (!platformAvailable || capabilities?.["extension:prf"] !== true) {
            return { supported: false, reason: "This browser or device does not report a user-verifying platform authenticator with WebAuthn PRF support." };
        }
        return { supported: true, reason: "" };
    } catch {
        return { supported: false, reason: "Platform-authenticator PRF capability could not be verified in this browser." };
    }
}

function showVaultForm(message = "") {
    vaultPanel.hidden = false;
    vaultForm.hidden = false;
    dashboard.hidden = true;
    lockSettingsButton.hidden = true;
    biometricUnlockButton.hidden = !biometricMetadata || !biometricSupported;
    enableBiometricButton.hidden = true;
    removeBiometricButton.hidden = true;
    vaultMessage.textContent = message;
    vaultMessage.classList.remove("is-error");
}

function activateVault(unlocked, expectedEpoch) {
    expireHiddenVault();
    if (!unlocked || expectedEpoch !== vaultEpoch) return false;
    vaultKey = unlocked.key;
    vaultSalt = unlocked.salt;
    profiles = unlocked.profiles;
    vaultPanel.hidden = true;
    dashboard.hidden = false;
    lockSettingsButton.hidden = false;
    enableBiometricButton.hidden = !biometricSupported || Boolean(biometricMetadata);
    removeBiometricButton.hidden = !biometricMetadata;
    biometricSupportMessage.hidden = biometricSupported;
    biometricSupportMessage.textContent = biometricSupported
        ? ""
        : "Device-authenticator unlock is not supported by this browser/device. Your settings passphrase remains available.";
    biometricUnlockButton.hidden = true;
    renderProfiles();
    refreshAll();
    schedulePolling();
    return true;
}

function clearActiveVault() {
    cancelHiddenVaultLock();
    vaultEpoch += 1;
    biometricEnrollmentPending = false;
    clearInterval(pollTimer);
    vaultKey = undefined;
    vaultSalt = undefined;
    profiles = [];
    computersList.replaceChildren();
    vaultPassword.value = "";
    vaultConfirm.value = "";
    biometricPassword.value = "";
    transferPassword.value = "";
    transferConfirm.value = "";
    transferFile.value = "";
    if (transferDialog.open) transferDialog.close();
    if (biometricDialog.open) biometricDialog.close();
}

function lockVaultForLifecycle() {
    if (!biometricMetadata && !biometricEnrollmentPending) return;
    clearActiveVault();
    forgetDeviceUnlock().catch(() => {});
    showVaultForm("Settings were locked after the app was hidden for 60 seconds or the page was left. Unlock again to continue.");
}

function cancelHiddenVaultLock() {
    clearTimeout(vaultHiddenTimer);
    vaultHiddenTimer = undefined;
    vaultHiddenAt = null;
}

function expireHiddenVault() {
    if (vaultHiddenAt !== null && Date.now() - vaultHiddenAt >= HIDDEN_VAULT_GRACE_MS) {
        lockVaultForLifecycle();
    }
}

function scheduleHiddenVaultLock() {
    if (!biometricMetadata && !biometricEnrollmentPending) return;
    // Only an already-unlocked vault gets grace, not an in-flight authentication.
    if (!vaultKey || biometricEnrollmentPending) {
        lockVaultForLifecycle();
        return;
    }
    if (vaultHiddenAt !== null) return;
    vaultHiddenAt = Date.now();
    vaultHiddenTimer = setTimeout(expireHiddenVault, HIDDEN_VAULT_GRACE_MS);
}

function getPrfResult(credential) {
    const result = credential?.getClientExtensionResults?.()?.prf?.results?.first;
    if (!result || (result.byteLength ?? result.length) !== 32) {
        throw new Error("This authenticator did not provide secure device-unlock data (WebAuthn PRF). Your settings are unchanged; use your settings passphrase.");
    }
    return result;
}

async function createPlatformCredential(expectedEpoch) {
    const challenge = randomBytes(32);
    const userId = randomBytes(16);
    const credential = await navigator.credentials.create({
        publicKey: {
            challenge,
            rp: { name: "ESP Wake", id: location.hostname },
            user: { id: userId, name: "ESP Wake local settings", displayName: "ESP Wake local settings" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
            authenticatorSelection: {
                authenticatorAttachment: "platform",
                residentKey: "discouraged",
                userVerification: "required",
            },
            timeout: 60000,
            attestation: "none",
            extensions: { prf: {} },
        },
    });
    if (expectedEpoch !== vaultEpoch) return null;
    if (!credential || credential.type !== "public-key") throw new Error("Device authenticator setup was cancelled.");
    if (credential.getClientExtensionResults?.()?.prf?.enabled !== true) {
        throw new Error("This authenticator does not support secure device unlock (WebAuthn PRF). Your passphrase and settings are unchanged.");
    }
    return credential;
}

async function requestPrfAssertion(metadata, expectedEpoch) {
    const credential = await navigator.credentials.get({
        publicKey: {
            challenge: randomBytes(32),
            allowCredentials: [{ type: "public-key", id: decodeCredentialId(metadata.credentialId) }],
            userVerification: "required",
            timeout: 60000,
            extensions: { prf: { eval: { first: EncryptedConfig.decodeBase64(metadata.prfSalt, 32) } } },
        },
    });
    if (expectedEpoch !== vaultEpoch) return null;
    if (!credential || credential.type !== "public-key") throw new Error("Device authenticator unlock was cancelled.");
    return getPrfResult(credential);
}

function persistProfiles(value) {
    if (!vaultKey) return Promise.reject(new Error("Unlock encrypted settings before saving."));
    let snapshot;
    try {
        snapshot = EncryptedConfig.validateProfiles(value);
    } catch (error) {
        return Promise.reject(error);
    }
    const pending = saveQueue.then(async () => {
        const encrypted = await EncryptedConfig.seal(snapshot, vaultKey, vaultSalt);
        await writeVault(encrypted);
    });
    saveQueue = pending.then(() => {}, () => {});
    return pending;
}

function saveProfiles() {
    return persistProfiles(profiles);
}

function normalizeBaseUrl(value) {
    let candidate = value.trim();
    if (!candidate) throw new Error("Enter an ESP32 address.");
    if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`;

    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("Use an HTTP(S) address without embedded credentials.");
    }
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
const remoteStates = new Map();
const remoteStreams = new Map();
const STREAM_STATUS_TTL_MS = 15000;
const streamStatusChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("njk-stream-status") : null;

function remoteHostOrigin(host) {
    try {
        const url = new URL(host.includes("://") ? host : `https://${host}`);
        return url.protocol === "https:" && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
}

function renderRemoteState(profileId) {
    const card = findCard(profileId);
    const state = remoteStates.get(profileId);
    if (!card || !state) return;
    const remote = card.querySelector('[data-action="remote"]');
    const launching = remoteLaunches.has(profileId);
    const lastFrameAt = remoteStreams.get(state.host);
    const captureVerified = lastFrameAt !== undefined && Date.now() - lastFrameAt < STREAM_STATUS_TTL_MS;
    const verified = state.canRequest && state.hostReady && state.ticketAvailable && captureVerified;
    const unavailable = !state.canRequest || (state.readinessKnown && !state.hostReady);
    const ready = state.canRequest && state.hostReady && state.ticketAvailable;
    remote.disabled = !state.canRequest || launching;
    remote.classList.toggle("is-unavailable", unavailable && !launching);
    remote.classList.toggle("is-ready", ready && !verified && !launching);
    remote.classList.toggle("is-waiting", !unavailable && !ready && !launching);
    remote.classList.toggle("is-connecting", launching);
    remote.dataset.remoteState = launching ? "connecting" : unavailable ? "unavailable"
        : verified ? "streaming" : ready ? "ready" : "waiting";
    remote.title = launching ? "Preparing RemotePC access..."
        : !state.remoteEnabled ? "RemotePC is disabled. Enable it in the ESP32 configuration."
        : !state.pcOnline ? "PC is offline. Wake it before connecting."
        : !state.canRequest ? "Waiting for Njk Host and an ESP32 control password"
        : !state.readinessKnown ? "Try RemotePC. Host readiness is unknown (older helper/ESP32 firmware); availability will be checked when connecting."
        : !state.hostReady ? state.reason || "Host readiness is not confirmed. You can try RemotePC."
        : !state.ticketAvailable ? "Njk Host is reachable; waiting for a current connection ticket."
        : !captureVerified ? "Connect RemotePC. Host is reachable and a current ticket is available; desktop capture will be checked when connecting."
        : "RemotePC video is currently verified on this browser. A new connection will still validate capture.";
    remote.setAttribute("aria-label", remote.title);
}

if (streamStatusChannel) {
    streamStatusChannel.onmessage = ({ data }) => {
        if (data?.type !== "njk-stream-status" || typeof data.host !== "string" || typeof data.playing !== "boolean") return;
        const host = remoteHostOrigin(data.host);
        if (!host) return;
        if (data.playing) remoteStreams.set(host, Date.now());
        else remoteStreams.delete(host);
        remoteStates.forEach((state, id) => {
            if (state.host === host) renderRemoteState(id);
        });
    };
    setInterval(() => {
        remoteStreams.forEach((at, host) => {
            if (Date.now() - at >= STREAM_STATUS_TTL_MS) {
                remoteStreams.delete(host);
                remoteStates.forEach((state, id) => {
                    if (state.host === host) renderRemoteState(id);
                });
            }
        });
    }, 1000);
}

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
    document.getElementById("export-all").disabled = profiles.length === 0;

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
    let espResponded = false;

    try {
        const response = await requestDevice(profile, "stt", { forceProbe, retryStatus: true });
        espResponded = true;
        const identity = cardPart(card, "device-identity");
        identity.textContent = profile.deviceHostname ? `Device: ${profile.deviceHostname}` : "Device identity: legacy firmware";
        identity.hidden = false;
        card.querySelector('[data-action="forget-device-identity"]').disabled = !profile.deviceHostname;
        const data = await response.json();
        const device = Object.values(data)[0];
        if (!device || typeof device.stat !== "string") throw new Error("Invalid status response");

        const deviceState = device.stat.toLowerCase();
        renderPowerState(card, deviceState);
        delete card.dataset.statusStale;
        const pcOnline = ["connected", "up"].includes(deviceState);
        const remoteEnabled = device.remote?.enabled === true;
        const readinessKnown = typeof device.remote?.readiness_known === "boolean"
            ? device.remote.readiness_known
            : typeof device.remote?.ready === "boolean";
        const hostReady = readinessKnown && device.remote?.ready === true;
        const ticketAvailable = device.remote?.available === true;
        const readinessReason = typeof device.remote?.reason === "string"
            ? device.remote.reason.slice(0, 200) : "";
        const canRequestRemote = pcOnline && remoteEnabled && !!device.remote?.host && !!profile.password;
        remoteStates.set(profile.id, {
            pcOnline, remoteEnabled, readinessKnown, hostReady, ticketAvailable,
            canRequest: canRequestRemote, reason: readinessReason,
            host: typeof device.remote?.host === "string" ? remoteHostOrigin(device.remote.host) : "",
        });
        renderRemoteState(profile.id);
        const connectionPill = cardPart(card, "connection-pill");
        setConnection(card, "available", "ESP Online");
        connectionPill.title = "The ESP32 responded to the latest status request.";
        hideConnectionHelp(card);
        cardPart(card, "last-updated").textContent = `Updated at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    } catch (error) {
        console.error(`Status request failed for ${profile.name}:`, error);
        remoteStates.delete(profile.id);
        const remote = card.querySelector('[data-action="remote"]');
        remote.disabled = true;
        remote.classList.remove("is-ready", "is-waiting", "is-connecting");
        remote.classList.add("is-unavailable");
        remote.dataset.remoteState = "unavailable";
        remote.title = "ESP32 status is unavailable; RemotePC readiness cannot be verified.";
        remote.setAttribute("aria-label", remote.title);
        const lastState = card.dataset.deviceState;
        if (lastState && lastState !== "unknown") {
            card.dataset.statusStale = "true";
            cardPart(card, "device-status").textContent = "Status unavailable; showing last known PC state";
            cardPart(card, "signal-label").textContent = "Last known";
            card.querySelector('[data-action="power"]').disabled = true;
        } else {
            renderPowerState(card, "unknown");
        }
        const espOnline = espResponded || error.status !== undefined || error.code === "DEVICE_IDENTITY_MISMATCH";
        const connectionPill = cardPart(card, "connection-pill");
        setConnection(card, espOnline ? "available" : "error", espOnline ? "ESP Online" : "ESP Unreachable");
        connectionPill.title = espOnline
            ? "The ESP32 responded, but its status could not be read."
            : "The ESP32 did not respond to the latest status request.";
        if (error.code === "DEVICE_IDENTITY_MISMATCH") {
            cardPart(card, "device-status").textContent = error.message;
            hideConnectionHelp(card);
        } else if (error.status === 401 || error.status === 403) {
            cardPart(card, "device-status").textContent = "Cannot authenticate with this ESP32";
            cardPart(card, "last-updated").textContent = "Check or clear the saved control password.";
            hideConnectionHelp(card);
        } else if (espOnline) {
            cardPart(card, "device-status").textContent = "ESP32 responded, but its status could not be read.";
            cardPart(card, "last-updated").textContent = "Check the ESP32 response and firmware.";
            hideConnectionHelp(card);
        } else {
            cardPart(card, "last-updated").textContent = "ESP32 status timed out or its network is unavailable. The PC power state has not been changed.";
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

function remoteConnection(data) {
    const host = new URL(data.browser_host ?? data.host);
    if (host.protocol !== "https:" || host.username || host.password || host.pathname !== "/" || host.search || host.hash ||
        !/^[a-f0-9]{32}$/.test(data.ticket || "")) throw new Error("ESP32 returned an invalid Njk Host connection.");
    return { host: host.origin, ticket: data.ticket };
}

async function openRemoteDesktop(profile, card, button) {
    if (remoteLaunches.has(profile.id)) return;
    if (!profile.password) throw new Error("Configure an ESP32 control password before launching remote desktop.");
    const sameWindow = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true ||
        window.matchMedia("(pointer: coarse)").matches;
    const remoteWindow = sameWindow ? window : window.open("about:blank", `njk-remote-${profile.id}`);
    if (!remoteWindow) throw new Error("Allow pop-ups to open RemotePC.");
    if (!sameWindow) {
        remoteWindow.document.open();
        remoteWindow.document.write(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Opening RemotePC</title><body style="margin:0;padding:24px;background:#edf1ec;color:#17211d;font:16px system-ui">
        <main style="max-width:520px;margin:auto"><h1>Opening RemotePC</h1>
        <p id="handoff-status" role="status" aria-live="polite">Getting a one-time connection ticket...</p>
        <p>Keep ESPWake open until the stream connects.</p></main></body></html>`);
        remoteWindow.document.close();
    }
    const loadingStatus = sameWindow ? cardPart(card, "message") : remoteWindow.document.getElementById("handoff-status");
    let viewerId;
    try {
        const key = `espwake-remote-viewer-${profile.id}`;
        viewerId = localStorage.getItem(key);
        if (!/^[a-f0-9]{32}$/.test(viewerId || "")) {
            viewerId = crypto.randomUUID().replaceAll("-", "");
            localStorage.setItem(key, viewerId);
        }
    } catch (error) {
        if (!sameWindow) remoteWindow.close();
        throw new Error(`Remote device identity could not be saved: ${error.message}`);
    }
    remoteLaunches.add(profile.id);
    const originalIcon = button.innerHTML;
    const spinner = document.createElement("span");
    spinner.className = "config-spinner";
    spinner.setAttribute("aria-hidden", "true");
    button.replaceChildren(spinner);
    button.classList.add("is-connecting");
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", "Opening RemotePC");
    button.title = "Opening RemotePC...";
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
                const data = remoteConnection(await response.json());
                cardPart(card, "message").textContent = "";
                return data;
            } catch (error) {
                if (error.status !== 503 || Date.now() >= deadline || disposed) throw error;
                cardPart(card, "message").textContent = "Waiting for the Windows helper to refresh remote access…";
                loadingStatus.textContent = "Waiting for the Windows helper to refresh remote access. This can take up to 75 seconds.";
                await new Promise(resolve => setTimeout(resolve, 2500));
            }
        }
    }
    const refresh = async (message, reply) => {
        if (disposed || message?.nonce !== nonce) return;
        if (message.type === "njk-handoff-complete") { cleanup(); return; }
        if (message.type !== "njk-refresh-ticket" || refreshing) return;
        if (!vaultKey || (document.hidden && (biometricMetadata || biometricEnrollmentPending))) {
            reply({
                type: "njk-fresh-ticket",
                nonce,
                error: "ESPWake settings are hidden or locked. Return to ESPWake, unlock if needed, then reopen RemotePC to renew access.",
            });
            return;
        }
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
        await rememberRemoteHost(profile.id, data.host);
        const fragment = new URLSearchParams({ ...data, profileId: profile.id, fullscreen: "1", return: "espwake", nonce, clientId: viewerId, sameWindow: sameWindow ? "1" : "0" });
        remoteWindow.location.href = `https://taducanh1605.github.io/remotepc/#${fragment}`;
    } catch (error) {
        cleanup();
        if (!sameWindow) remoteWindow.close();
        throw error;
    } finally {
        remoteLaunches.delete(profile.id);
        button.innerHTML = originalIcon;
        button.classList.remove("is-connecting");
        button.removeAttribute("aria-busy");
        button.setAttribute("aria-label", "Open remote desktop");
        button.disabled = !remoteStates.get(profile.id)?.canRequest;
        button.title = "Open remote desktop";
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
    const previousSettings = { ...profile };
    let settingsSaved = false;

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
        settingsSaved = true;
        cardPart(card, "display-name").textContent = profile.name;
        form.querySelector('[data-field="base-url"]').value = profile.baseUrl;
        form.querySelector('[data-field="password"]').value = "";
        card.querySelector('[data-action="clear-password"]').disabled = !profile.password;
        message.textContent = newPassword
            ? "Address and control password updated."
            : "Settings updated; the saved password was kept.";
        await refreshProfile(profile);
    } catch (error) {
        if (!settingsSaved) Object.assign(profile, previousSettings);
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
        button.closest(".computer-menu")?.removeAttribute("open");
        openSettingsProfileId = cardPart(card, "settings-form").hidden ? profile.id : null;
        setSettingsVisible(card, openSettingsProfileId === profile.id);
    } else if (button.dataset.action === "export") {
        openTransfer("export", profile.id, button);
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
            if (error.trustURL) {
                const trust = document.createElement("a");
                trust.href = error.trustURL;
                trust.target = "_blank";
                trust.rel = "noopener";
                trust.textContent = " Open host certificate check";
                message.appendChild(trust);
            }
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
        const previousProfiles = profiles;
        profiles = profiles.filter((item) => item.id !== profile.id);
        try {
            await saveProfiles();
            if (openSettingsProfileId === profile.id) openSettingsProfileId = null;
            requestsInFlight.delete(profile.id);
            renderProfiles();
            refreshAll();
        } catch (error) {
            profiles = previousProfiles;
            message.textContent = error.message || "The computer could not be deleted.";
            message.classList.add("is-error");
        }
    }
});

addComputerButton.addEventListener("click", async () => {
    addComputerButton.disabled = true;
    try {
        const profile = createProfile({ name: `Computer ${profiles.length + 1}` });
        const previousProfiles = profiles;
        profiles = [...profiles, profile];
        try {
            await saveProfiles();
        } catch (error) {
            profiles = previousProfiles;
            throw error;
        }
        openSettingsProfileId = profile.id;
        renderProfiles();
        refreshAll();
        findCard(profile.id)?.querySelector('[data-field="name"]').focus();
    } catch (error) {
        showConfigurationMessage(error.message, true);
    } finally {
        addComputerButton.disabled = false;
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        scheduleHiddenVaultLock();
    } else {
        // Background timers may be suspended, so check elapsed time before resuming.
        expireHiddenVault();
        cancelHiddenVaultLock();
        if (vaultKey) refreshAll({ quiet: true });
    }
});
window.addEventListener("pagehide", lockVaultForLifecycle);

function showConfigurationMessage(message, isError = false) {
    const notice = document.getElementById("configuration-message");
    notice.textContent = message;
    notice.classList.toggle("is-error", isError);
}

vaultForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = document.getElementById("vault-submit");
    const expectedEpoch = vaultEpoch;
    submit.disabled = true;
    vaultMessage.textContent = "Opening encrypted settings...";
    vaultMessage.classList.remove("is-error");
    try {
        if (creatingVault && vaultPassword.value !== vaultConfirm.value) throw new Error("Settings passphrases do not match.");
        const unlocked = await loadProfiles(vaultPassword.value, expectedEpoch);
        if (expectedEpoch !== vaultEpoch) return;
        if (!unlocked) return;
        vaultPassword.value = "";
        vaultConfirm.value = "";
        if (!activateVault(unlocked, expectedEpoch)) return;
        addComputerButton.focus();
    } catch (error) {
        if (expectedEpoch !== vaultEpoch) return;
        vaultMessage.textContent = error.message || "Encrypted settings could not be opened.";
        vaultMessage.classList.add("is-error");
    } finally {
        vaultPassword.value = "";
        vaultConfirm.value = "";
        submit.disabled = false;
    }
});

biometricUnlockButton.addEventListener("click", async () => {
    const expectedEpoch = vaultEpoch;
    biometricUnlockButton.disabled = true;
    vaultMessage.textContent = "Waiting for device verification...";
    vaultMessage.classList.remove("is-error");
    try {
        if (!biometricSupported) throw new Error("This browser cannot verify platform-authenticator PRF support. Use your settings passphrase.");
        const [envelope, metadata] = await Promise.all([
            readSetting("encryptedProfiles"),
            readSetting("biometricUnlock"),
        ]);
        if (expectedEpoch !== vaultEpoch) return;
        if (!envelope || !metadata) throw new Error("Device authenticator setup is unavailable. Use your settings passphrase.");
        const prfOutput = await requestPrfAssertion(metadata, expectedEpoch);
        if (expectedEpoch !== vaultEpoch) return;
        const key = await EncryptedConfig.unwrapVaultKey(envelope, metadata, prfOutput);
        if (expectedEpoch !== vaultEpoch) return;
        const unlocked = await EncryptedConfig.openWithKey(envelope, key);
        if (expectedEpoch !== vaultEpoch) return;
        biometricMetadata = metadata;
        await forgetDeviceUnlock();
        if (expectedEpoch !== vaultEpoch) return;
        activateVault(unlocked, expectedEpoch);
    } catch (error) {
        if (expectedEpoch !== vaultEpoch) return;
        vaultMessage.textContent = error.name === "NotAllowedError"
            ? "Device verification was cancelled or unavailable. Your settings passphrase still works."
            : error.name === "NotSupportedError"
                ? "This browser or authenticator does not support secure device unlock. Your settings passphrase still works."
            : error.message || "Device authenticator could not unlock these settings. Use your passphrase.";
        vaultMessage.classList.add("is-error");
    } finally {
        biometricUnlockButton.disabled = false;
        if (expectedEpoch === vaultEpoch) biometricUnlockButton.focus();
    }
});

enableBiometricButton.addEventListener("click", () => {
    if (!biometricSupported || !vaultKey) {
        showConfigurationMessage("This browser cannot verify a secure device-authenticator PRF flow.", true);
        return;
    }
    biometricMessage.textContent = "";
    biometricMessage.classList.remove("is-error");
    biometricPassword.value = "";
    biometricDialog.showModal();
    biometricPassword.focus();
});

biometricForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = document.getElementById("biometric-submit");
    const expectedEpoch = vaultEpoch;
    biometricEnrollmentPending = true;
    submit.disabled = true;
    biometricMessage.textContent = "Confirming your passphrase...";
    biometricMessage.classList.remove("is-error");
    let prfOutput;
    let unlocked;
    try {
        const envelope = await readSetting("encryptedProfiles");
        unlocked = await EncryptedConfig.open(envelope, biometricPassword.value, { extractable: true });
        if (expectedEpoch !== vaultEpoch) return;
        const credential = await createPlatformCredential(expectedEpoch);
        if (expectedEpoch !== vaultEpoch) return;
        const credentialId = encodeCredentialId(credential.rawId);
        const prfSalt = randomBytes(32);
        const metadata = { credentialId, prfSalt: EncryptedConfig.encodeBase64(prfSalt) };
        prfOutput = await requestPrfAssertion(metadata, expectedEpoch);
        if (expectedEpoch !== vaultEpoch) return;
        const biometric = await EncryptedConfig.wrapVaultKey(
            envelope, unlocked.key, prfOutput, credentialId, metadata.prfSalt,
        );
        if (expectedEpoch !== vaultEpoch) return;
        await writeBiometricMetadata(biometric);
        if (expectedEpoch !== vaultEpoch) {
            biometricMetadata = biometric;
            biometricUnlockButton.hidden = !biometricSupported;
            return;
        }
        biometricMetadata = biometric;
        biometricEnrollmentPending = false;
        await forgetDeviceUnlock();
        if (expectedEpoch !== vaultEpoch) return;
        biometricDialog.close();
        showConfigurationMessage("Device authenticator is set up. The passphrase remains available as a fallback; settings lock after 60 seconds hidden or when leaving this page.");
        enableBiometricButton.hidden = true;
        removeBiometricButton.hidden = false;
    } catch (error) {
        if (expectedEpoch !== vaultEpoch) return;
        biometricMessage.textContent = error.name === "NotAllowedError"
            ? "Device setup was cancelled or unavailable. Your settings and passphrase are unchanged."
            : error.name === "NotSupportedError"
                ? "This browser or authenticator does not support secure device unlock. Your settings and passphrase are unchanged; use your settings passphrase."
            : error.message || "Device authenticator setup failed. Your settings and passphrase are unchanged.";
        biometricMessage.classList.add("is-error");
    } finally {
        if (expectedEpoch === vaultEpoch) biometricEnrollmentPending = false;
        if (prfOutput instanceof ArrayBuffer) new Uint8Array(prfOutput).fill(0);
        else if (ArrayBuffer.isView(prfOutput)) new Uint8Array(prfOutput.buffer, prfOutput.byteOffset, prfOutput.byteLength).fill(0);
        biometricPassword.value = "";
        submit.disabled = false;
        unlocked = undefined;
    }
});

document.getElementById("biometric-cancel").addEventListener("click", () => {
    if (!document.getElementById("biometric-submit").disabled) biometricDialog.close();
});

biometricDialog.addEventListener("cancel", event => {
    if (document.getElementById("biometric-submit").disabled) event.preventDefault();
});

removeBiometricButton.addEventListener("click", async () => {
    removeBiometricButton.disabled = true;
    try {
        await saveQueue;
        await forgetBiometricMetadata();
        biometricMetadata = null;
        enableBiometricButton.hidden = !biometricSupported;
        removeBiometricButton.hidden = true;
        showConfigurationMessage("Authenticator removed from this vault. Your encrypted settings and passphrase are unchanged.");
    } catch (error) {
        showConfigurationMessage(error.message || "Device authenticator could not be removed.", true);
    } finally {
        removeBiometricButton.disabled = false;
    }
});

function configurationForExport(profileId = null) {
    if (profileId === null) return EncryptedConfig.validateProfiles(profiles);
    const profile = findProfile(profileId);
    if (!profile) throw new Error("This computer is no longer available for export.");
    return EncryptedConfig.validateProfiles([profile]);
}

function openTransfer(mode, profileId = null, trigger) {
    transferMode = mode;
    transferProfileId = profileId;
    transferTrigger = trigger;
    const exporting = mode === "export";
    transferForm.reset();
    transferMessage.textContent = "";
    transferMessage.classList.remove("is-error");
    document.getElementById("transfer-title").textContent = exporting
        ? (profileId === null ? "Export all computers" : `Export ${findProfile(profileId).name}`)
        : "Import computer";
    document.getElementById("transfer-description").textContent = exporting
        ? `${profileId === null ? "All computers" : "Only this computer"} will be exported, including saved addresses and control passwords, fully encrypted. Save any settings changes first. Choose a file passphrase (at least 6 characters) and send it separately from the file.`
        : "Select an encrypted ESP Wake file for one computer or an all-computers backup. New computers are added by default; existing computers stay unchanged. Enter the file passphrase to import.";
    document.getElementById("transfer-file-label").hidden = exporting;
    document.getElementById("transfer-mode-label").hidden = exporting;
    document.getElementById("transfer-confirm-label").hidden = !exporting;
    transferFile.required = !exporting;
    transferConfirm.required = exporting;
    transferPassword.autocomplete = exporting ? "new-password" : "current-password";
    document.getElementById("transfer-submit").textContent = exporting ? "Export file" : "Import file";
    transferDialog.showModal();
    (exporting ? transferPassword : transferFile).focus();
}

document.getElementById("export-all").addEventListener("click", event => openTransfer("export", null, event.currentTarget));
document.getElementById("import-config").addEventListener("click", event => openTransfer("import", null, event.currentTarget));
document.getElementById("transfer-cancel").addEventListener("click", () => transferDialog.close());
transferDialog.addEventListener("close", () => {
    transferForm.reset();
    if (transferTrigger?.isConnected) transferTrigger.focus();
    else addComputerButton.focus();
});

transferForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!vaultKey) return;
    const expectedEpoch = vaultEpoch;
    const submit = document.getElementById("transfer-submit");
    submit.disabled = true;
    document.getElementById("transfer-cancel").disabled = true;
    transferForm.setAttribute("aria-busy", "true");
    transferMessage.textContent = "Processing encrypted configuration...";
    transferMessage.classList.remove("is-error");
    try {
        if (transferMode === "export") {
            if (transferPassword.value !== transferConfirm.value) throw new Error("File passphrases do not match.");
            const exportedProfiles = configurationForExport(transferProfileId);
            const { envelope } = await EncryptedConfig.create(exportedProfiles, transferPassword.value);
            expireHiddenVault();
            if (expectedEpoch !== vaultEpoch) return;
            const blob = new Blob([JSON.stringify(envelope)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = transferProfileId === null ? "espwake-all.espwake" : "espwake-computer.espwake";
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            showConfigurationMessage(`${exportedProfiles.length} computer(s) exported in an encrypted file. Send the passphrase separately.`);
        } else {
            const file = transferFile.files[0];
            if (!file || file.size > EncryptedConfig.MAX_FILE_BYTES) throw new Error("Select a configuration file no larger than 1 MB.");
            const { profiles: imported } = await EncryptedConfig.open(EncryptedConfig.parseFile(await file.text()), transferPassword.value);
            expireHiddenVault();
            if (expectedEpoch !== vaultEpoch) return;
            const replace = document.getElementById("transfer-mode").value === "replace";
            if (replace && !window.confirm("Replace all saved computers with this file? Export a backup first if needed.")) return;
            const updated = replace ? [] : [...profiles];
            let added = 0;
            for (const profile of imported) {
                const duplicate = updated.some(existing =>
                    existing.id === profile.id ||
                    (profile.deviceHostname && existing.deviceHostname === profile.deviceHostname) ||
                    (profile.baseUrl && existing.baseUrl === profile.baseUrl));
                if (!duplicate) {
                    updated.push(createProfile(profile));
                    added++;
                }
            }
            EncryptedConfig.validateProfiles(updated);
            const previousProfiles = profiles;
            profiles = updated;
            try {
                await saveProfiles();
            } catch (error) {
                if (expectedEpoch === vaultEpoch) profiles = previousProfiles;
                throw error;
            }
            if (expectedEpoch !== vaultEpoch) return;
            openSettingsProfileId = null;
            renderProfiles();
            refreshAll();
            showConfigurationMessage(`${added} computer(s) imported; ${imported.length - added} duplicate(s) skipped.`);
        }
        transferDialog.close();
    } catch (error) {
        if (expectedEpoch !== vaultEpoch) return;
        transferMessage.textContent = error.message || "Configuration transfer failed.";
        transferMessage.classList.add("is-error");
    } finally {
        transferPassword.value = "";
        transferConfirm.value = "";
        submit.disabled = false;
        document.getElementById("transfer-cancel").disabled = false;
        transferForm.removeAttribute("aria-busy");
    }
});

transferDialog.addEventListener("cancel", event => {
    if (document.getElementById("transfer-submit").disabled) event.preventDefault();
});

transferDialog.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        event.preventDefault();
        if (!document.getElementById("transfer-submit").disabled) transferDialog.close();
    }
});

lockSettingsButton.addEventListener("click", async () => {
    dashboard.inert = true;
    clearInterval(pollTimer);
    try {
        await Promise.all([...deviceOperations.values()]);
        await saveQueue;
        await forgetDeviceUnlock();
        clearActiveVault();
        window.location.reload();
    } catch (error) {
        dashboard.inert = false;
        showConfigurationMessage("Settings could not be locked. Reload this page to lock it.", true);
    }
});

async function startRemoteBroker(parameters) {
    const origin = "https://taducanh1605.github.io";
    const nonce = parameters.get("nonce");
    const profileId = parameters.get("profileId");
    const host = parameters.get("host");
    if (window.parent === window || window.location.origin !== origin ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(profileId || "") || !nonce || nonce.length > 128) return;
    try {
        const parentUrl = new URL(window.parent.location.href);
        if (parentUrl.origin !== origin || !["/remotepc/", "/remotepc/index.html"].includes(parentUrl.pathname)) return;
    } catch { return; }
    history.replaceState(null, "", window.location.pathname);
    let busy = false;
    window.addEventListener("message", async event => {
        if (event.source !== window.parent || event.origin !== origin || event.data?.nonce !== nonce ||
            event.data.type !== "njk-refresh-ticket" || busy) return;
        busy = true;
        const reply = data => window.parent.postMessage({ type: "njk-fresh-ticket", nonce, ...data }, origin);
        try {
            const remembered = await loadRememberedProfiles();
            const profile = remembered?.find(item => item.id === profileId);
            if (!profile?.password || await readSetting(`remoteHost-${profileId}`) !== host) {
                throw new Error("ESPWake settings are locked, missing, or no longer match this host. Return to ESPWake, unlock with your authenticator or passphrase, then retry RemotePC access.");
            }
            profiles = remembered;
            const response = await requestDevice(profile, "api/remote", { forceProbe: true });
            const data = remoteConnection(await response.json());
            if (data.host !== host || !/^[a-f0-9]{32}$/.test(data.ticket || "")) {
                throw new Error("ESPWake returned access for a different host or an invalid ticket.");
            }
            reply({ host, ticket: data.ticket });
        } catch (error) {
            reply({ error: error.status === 503 ? "The Windows helper has no fresh remote ticket. Check the helper and retry." : error.message });
        } finally { busy = false; }
    });
    window.parent.postMessage({ type: "njk-broker-ready", nonce }, origin);
}

(async function initialize() {
    try {
        EncryptedConfig.requireCrypto();
        database = await openDatabase();
        const capability = await getBiometricCapability();
        biometricSupported = capability.supported;
        const brokerParameters = new URLSearchParams(window.location.hash.slice(1));
        if (brokerParameters.get("broker") === "1") {
            await startRemoteBroker(brokerParameters);
            return;
        }
        creatingVault = await readSetting("encryptedProfiles") === null;
        document.getElementById("vault-description").textContent = creatingVault
            ? "Create a settings passphrase of at least 6 characters to encrypt this browser's saved computers and control passwords. Existing settings will be migrated. The passphrase is never saved and cannot be recovered."
            : "Unlock this browser's encrypted computers with your settings passphrase. The passphrase is never saved; it is separate from your ESP32 control password.";
        document.getElementById("vault-submit").textContent = creatingVault ? "Encrypt settings" : "Unlock settings";
        document.getElementById("vault-confirm-label").hidden = !creatingVault;
        vaultConfirm.required = creatingVault;
        vaultPassword.autocomplete = creatingVault ? "new-password" : "current-password";
        const rememberedProfiles = creatingVault ? null : await loadRememberedProfiles();
        if (rememberedProfiles) {
            activateVault({ key: vaultKey, salt: vaultSalt, profiles: rememberedProfiles }, vaultEpoch);
            return;
        }
        vaultForm.hidden = false;
        biometricUnlockButton.hidden = !biometricMetadata || !biometricSupported;
        if (!biometricSupported) {
            vaultMessage.textContent = `${capability.reason} Your settings passphrase remains available.`;
            vaultMessage.classList.add("is-error");
        }
    } catch (error) {
        console.error("Initialization failed:", error);
        vaultMessage.textContent = error.message || "Saved settings could not be loaded in this browser.";
        vaultMessage.classList.add("is-error");
    }
})();

if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js").catch((error) => {
            console.error("Service worker registration failed:", error);
        });
    });
}
