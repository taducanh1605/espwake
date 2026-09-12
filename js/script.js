const DB_NAME = "ESPWakeDB";
const STORE_NAME = "settings";
const POLL_INTERVAL_MS = 7000;
const REQUEST_TIMEOUT_MS = 12000;

const computersList = document.getElementById("computers-list");
const emptyState = document.getElementById("empty-state");
const computerTemplate = document.getElementById("computer-template");
const addComputerButton = document.getElementById("add-computer");

let database;
let profiles = [];
let pollTimer;
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
        ...overrides,
    };
}

async function loadProfiles() {
    const storedProfiles = await readSetting("profiles");
    if (Array.isArray(storedProfiles)) return storedProfiles;

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

function findProfile(id) {
    return profiles.find((profile) => profile.id === id);
}

function findCard(id) {
    return computersList.querySelector(`[data-profile-id="${CSS.escape(id)}"]`);
}

function cardPart(card, role) {
    return card.querySelector(`[data-role="${role}"]`);
}

async function request(profile, path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(endpoint(profile, path), {
            cache: "no-store",
            ...options,
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
    } finally {
        clearTimeout(timeout);
    }
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
        card.querySelector('[data-action="move-up"]').disabled = index === 0;
        card.querySelector('[data-action="move-down"]').disabled = index === profiles.length - 1;
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

async function refreshProfile(profile, { quiet = false } = {}) {
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
        const response = await request(profile, "stt");
        const data = await response.json();
        const device = Object.values(data)[0];
        if (!device || typeof device.stat !== "string") throw new Error("Invalid status response");

        renderPowerState(card, device.stat.toLowerCase());
        setConnection(card, "online", "ESP Connected");
        hideConnectionHelp(card);
        cardPart(card, "last-updated").textContent = `Updated at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    } catch (error) {
        console.error(`Status request failed for ${profile.name}:`, error);
        renderPowerState(card, "unknown");
        setConnection(card, "error", "ESP Offline");
        cardPart(card, "device-status").textContent = "Cannot reach this ESP32";
        cardPart(card, "last-updated").textContent = "Check its address, proxy, or network connection.";
        showConnectionHelp(card, profile);
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

async function sendPowerCommand(profile, card) {
    const state = card.dataset.deviceState;
    let path;
    let confirmation;

    if (state === "connected" || state === "up") {
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

    const action = card.querySelector('[data-action="power"]');
    const label = cardPart(card, "power-label");
    const message = cardPart(card, "message");
    action.disabled = true;
    label.textContent = "Sending...";
    message.classList.remove("is-error");

    try {
        const options = profile.password
            ? {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body: new URLSearchParams({ password: profile.password }),
            }
            : { method: "GET" };
        await request(profile, path, options);
        cardPart(card, "last-updated").textContent = "Command sent. Waiting for the next status update...";
        setTimeout(() => refreshProfile(profile), 1200);
    } catch (error) {
        console.error(`Power command failed for ${profile.name}:`, error);
        message.textContent = profile.password
            ? "Command failed. Check the saved password and connection."
            : "The power command could not be sent.";
        message.classList.add("is-error");
        renderPowerState(card, state);
    }
}

function openConfiguration(profile) {
    if (!profile.baseUrl) throw new Error("Enter and save an ESP32 address first.");

    if (!profile.password) {
        window.open(profile.baseUrl, "_blank", "noopener,noreferrer");
        return;
    }

    const targetName = `esp-config-${profile.id}`;
    const configWindow = window.open("about:blank", targetName);
    if (!configWindow) throw new Error("Allow pop-ups to open the configuration page.");

    const loginForm = document.createElement("form");
    loginForm.method = "POST";
    loginForm.action = endpoint(profile, "login");
    loginForm.target = targetName;
    loginForm.hidden = true;

    const passwordField = document.createElement("input");
    passwordField.type = "hidden";
    passwordField.name = "password";
    passwordField.value = profile.password;
    loginForm.appendChild(passwordField);
    document.body.appendChild(loginForm);
    loginForm.submit();
    loginForm.remove();
}

computersList.addEventListener("submit", async (event) => {
    const form = event.target.closest('[data-role="settings-form"]');
    if (!form) return;
    event.preventDefault();

    const card = form.closest(".computer-card");
    const profile = findProfile(card.dataset.profileId);
    const message = cardPart(card, "message");
    message.classList.remove("is-error");

    try {
        profile.name = form.querySelector('[data-field="name"]').value.trim() || "Computer";
        profile.baseUrl = normalizeBaseUrl(form.querySelector('[data-field="base-url"]').value);
        const newPassword = form.querySelector('[data-field="password"]').value;
        if (newPassword) profile.password = newPassword;

        await saveProfiles();
        cardPart(card, "display-name").textContent = profile.name;
        form.querySelector('[data-field="base-url"]').value = profile.baseUrl;
        form.querySelector('[data-field="password"]').value = "";
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
    } else if (button.dataset.action === "refresh") {
        await refreshProfile(profile);
    } else if (button.dataset.action === "config") {
        try {
            openConfiguration(profile);
        } catch (error) {
            message.textContent = error.message;
            message.classList.add("is-error");
        }
    } else if (button.dataset.action === "trust-certificate") {
        window.open(profile.baseUrl, "_blank", "noopener,noreferrer");
    } else if (button.dataset.action === "move-up") {
        await moveProfile(profile, -1);
    } else if (button.dataset.action === "move-down") {
        await moveProfile(profile, 1);
    } else if (button.dataset.action === "delete") {
        if (!window.confirm(`Delete ${profile.name}?`)) return;
        profiles = profiles.filter((item) => item.id !== profile.id);
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
