const EncryptedConfig = (() => {
    const MAX_FILE_BYTES = 1024 * 1024;
    const ITERATIONS = 600000;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });

    function requireCrypto() {
        if (!globalThis.crypto?.subtle) {
            throw new Error("Encrypted settings require Web Crypto. Open this dashboard over HTTPS or localhost.");
        }
    }

    function validatePassword(password) {
        if (typeof password !== "string" || password.length < 6 || password.length > 1024) {
            throw new Error("Use a passphrase between 6 and 1024 characters.");
        }
    }

    function text(value, field, maximum, fallback) {
        if (value === undefined && fallback !== undefined) return fallback;
        if (typeof value !== "string" || value.length > maximum) {
            throw new Error(`Invalid configuration field: ${field}.`);
        }
        return value;
    }

    function address(value, httpsOnly = false) {
        const input = text(value, "address", 2048);
        if (!input && !httpsOnly) return "";
        const url = new URL(input);
        if (!(httpsOnly ? url.protocol === "https:" : ["http:", "https:"].includes(url.protocol)) ||
            url.username || url.password || url.search || url.hash) {
            throw new Error("Configuration addresses must be HTTP(S) URLs without embedded credentials, queries or fragments.");
        }
        return url.href.replace(/\/+$/, "");
    }

    function validateProfiles(value) {
        if (!Array.isArray(value) || value.length > 100) throw new Error("Configuration must contain at most 100 computers.");
        const ids = new Set();
        return value.map(profile => {
            if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Invalid computer configuration.");
            const id = text(profile.id, "id", 128);
            if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error("Invalid or duplicate computer ID.");
            ids.add(id);
            const deviceHostname = text(profile.deviceHostname, "deviceHostname", 253, "");
            if (deviceHostname && (!deviceHostname.split(".").every(label =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(deviceHostname))) {
                throw new Error("Invalid ESP32 hostname identity.");
            }
            const candidates = profile.endpointCandidates ?? [];
            if (!Array.isArray(candidates) || candidates.length > 100) throw new Error("Invalid endpoint list.");
            return {
                id,
                name: text(profile.name, "name", 120),
                baseUrl: address(profile.baseUrl),
                password: text(profile.password, "password", 1024),
                deviceHostname,
                endpointCandidates: candidates.map(candidate => {
                    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid endpoint.");
                    return {
                        url: address(candidate.url, true),
                        address: text(candidate.address, "endpoint address", 253),
                        family: text(candidate.family, "endpoint family", 16),
                        scope: text(candidate.scope, "endpoint scope", 64, "unknown"),
                        source: text(candidate.source, "endpoint source", 64, "unknown"),
                    };
                }),
                endpointsUpdatedAt: Number.isFinite(profile.endpointsUpdatedAt) && profile.endpointsUpdatedAt >= 0
                    ? profile.endpointsUpdatedAt : 0,
                identityUnsupported: profile.identityUnsupported === true,
            };
        });
    }

    function encode(bytes) {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    function decode(value, expectedLength) {
        if (typeof value !== "string" || value.length > MAX_FILE_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
            throw new Error("Invalid encrypted configuration encoding.");
        }
        const binary = atob(value);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (encode(bytes) !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
            throw new Error("Invalid encrypted configuration encoding.");
        }
        return bytes;
    }

    async function deriveKey(password, salt, extractable = false) {
        requireCrypto();
        const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
            material, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"],
        );
    }

    function vaultBinding(envelope) {
        return encoder.encode(JSON.stringify({
            format: envelope.format,
            version: envelope.version,
            cipher: envelope.cipher,
            kdf: envelope.kdf,
            iterations: envelope.iterations,
            salt: envelope.salt,
        }));
    }

    function wrappingKeyInfo(envelope) {
        const domain = encoder.encode("ESPWake WebAuthn PRF vault wrap v1\u0000");
        const binding = vaultBinding(envelope);
        const info = new Uint8Array(domain.length + binding.length);
        info.set(domain);
        info.set(binding, domain.length);
        return info;
    }

    function validateBiometricMetadata(metadata) {
        if (!metadata || metadata.version !== 1 ||
            typeof metadata.credentialId !== "string" || !/^[A-Za-z0-9_-]{16,2048}$/.test(metadata.credentialId) ||
            typeof metadata.prfSalt !== "string" || typeof metadata.iv !== "string" ||
            typeof metadata.wrappedKey !== "string") {
            throw new Error("Device authenticator data is invalid. Use your settings passphrase.");
        }
        const fields = ["version", "credentialId", "prfSalt", "iv", "wrappedKey"];
        if (Object.keys(metadata).length !== fields.length ||
            fields.some(field => !Object.prototype.hasOwnProperty.call(metadata, field))) {
            throw new Error("Device authenticator data is invalid. Use your settings passphrase.");
        }
        const credentialBytes = Uint8Array.from(
            atob(metadata.credentialId.replace(/-/g, "+").replace(/_/g, "/") +
                "=".repeat((4 - metadata.credentialId.length % 4) % 4)),
            character => character.charCodeAt(0),
        );
        if (!credentialBytes.length || encode(credentialBytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") !== metadata.credentialId) {
            throw new Error("Device authenticator data is invalid. Use your settings passphrase.");
        }
        decode(metadata.prfSalt, 32);
        decode(metadata.iv, 12);
        const wrapped = decode(metadata.wrappedKey);
        if (wrapped.length !== 48) throw new Error("Device authenticator data is invalid. Use your settings passphrase.");
        return metadata;
    }

    async function derivePrfWrappingKey(prfOutput, prfSalt, envelope) {
        if (!(prfOutput instanceof ArrayBuffer) && !ArrayBuffer.isView(prfOutput)) {
            throw new Error("This authenticator did not provide the required PRF output.");
        }
        const output = prfOutput instanceof ArrayBuffer
            ? new Uint8Array(prfOutput)
            : new Uint8Array(prfOutput.buffer, prfOutput.byteOffset, prfOutput.byteLength);
        if (output.byteLength !== 32) {
            output.fill(0);
            throw new Error("This authenticator returned an invalid PRF result.");
        }
        let material;
        try {
            material = await crypto.subtle.importKey("raw", output, "HKDF", false, ["deriveKey"]);
        } finally {
            output.fill(0);
        }
        return crypto.subtle.deriveKey({
            name: "HKDF",
            hash: "SHA-256",
            salt: prfSalt,
            info: wrappingKeyInfo(envelope),
        }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }

    async function wrapVaultKey(envelope, key, prfOutput, credentialId, savedPrfSalt) {
        requireCrypto();
        if (!key || key.type !== "secret" || !key.extractable || key.algorithm?.name !== "AES-GCM" ||
            key.algorithm.length !== 256 || !key.usages?.includes("decrypt") || !key.usages?.includes("encrypt")) {
            throw new Error("The vault key cannot be securely wrapped.");
        }
        const prfSalt = savedPrfSalt ? decode(savedPrfSalt, 32) : crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const wrappingKey = await derivePrfWrappingKey(prfOutput, prfSalt, envelope);
        const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
        try {
            const wrappedKey = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv, additionalData: vaultBinding(envelope) },
                wrappingKey,
                rawKey,
            );
            const metadata = {
                version: 1,
                credentialId,
                prfSalt: encode(prfSalt),
                iv: encode(iv),
                wrappedKey: encode(new Uint8Array(wrappedKey)),
            };
            return validateBiometricMetadata(metadata);
        } finally {
            rawKey.fill(0);
        }
    }

    async function unwrapVaultKey(envelope, metadata, prfOutput) {
        requireCrypto();
        validateBiometricMetadata(metadata);
        const prfSalt = decode(metadata.prfSalt, 32);
        const wrappingKey = await derivePrfWrappingKey(prfOutput, prfSalt, envelope);
        let rawKey;
        try {
            rawKey = new Uint8Array(await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: decode(metadata.iv, 12), additionalData: vaultBinding(envelope) },
                wrappingKey,
                decode(metadata.wrappedKey, 48),
            ));
            if (rawKey.length !== 32) throw new Error("Invalid wrapped vault key.");
            return await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        } catch (error) {
            if (error.name === "OperationError") {
                throw new Error("Device authenticator could not unlock these settings. Use your settings passphrase.");
            }
            throw error;
        } finally {
            rawKey?.fill(0);
        }
    }

    async function seal(profiles, key, salt) {
        requireCrypto();
        const plaintext = encoder.encode(JSON.stringify({ version: 1, profiles: validateProfiles(profiles) }));
        if (plaintext.length > MAX_FILE_BYTES / 2) throw new Error("Configuration is too large.");
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
        return {
            format: "espwake-encrypted-config", version: 1,
            cipher: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iterations: ITERATIONS,
            salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)),
        };
    }

    async function create(profiles, password) {
        validatePassword(password);
        requireCrypto();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveKey(password, salt);
        return { key, salt, envelope: await seal(profiles, key, salt) };
    }

    async function open(envelope, password, { extractable = false } = {}) {
        validatePassword(password);
        if (!envelope || envelope.format !== "espwake-encrypted-config" || envelope.version !== 1 ||
            envelope.cipher !== "AES-256-GCM" || envelope.kdf !== "PBKDF2-SHA-256" || envelope.iterations !== ITERATIONS) {
            throw new Error("Unsupported encrypted configuration format.");
        }
        const salt = decode(envelope?.salt, 16);
        const key = await deriveKey(password, salt, extractable);
        return openWithKey(envelope, key, salt, { allowExtractable: extractable });
    }

    async function openWithKey(envelope, key, savedSalt, { allowExtractable = false } = {}) {
        requireCrypto();
        if (!envelope || envelope.format !== "espwake-encrypted-config" || envelope.version !== 1 ||
            envelope.cipher !== "AES-256-GCM" || envelope.kdf !== "PBKDF2-SHA-256" || envelope.iterations !== ITERATIONS) {
            throw new Error("Unsupported encrypted configuration format.");
        }
        const salt = decode(envelope.salt, 16);
        if (savedSalt && encode(savedSalt) !== envelope.salt) throw new Error("Saved unlock key does not match this configuration.");
        if (!key || key.type !== "secret" || (!allowExtractable && key.extractable) || key.algorithm?.name !== "AES-GCM" ||
            key.algorithm.length !== 256 || !key.usages?.includes("decrypt")) {
            throw new Error("Saved unlock key is invalid.");
        }
        const iv = decode(envelope.iv, 12);
        const ciphertext = decode(envelope.ciphertext);
        if (ciphertext.length < 16 || ciphertext.length > MAX_FILE_BYTES / 2 + 16) throw new Error("Invalid configuration size.");
        let plaintext;
        try {
            plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
        } catch (error) {
            if (error.name !== "OperationError") throw error;
            throw new Error("Incorrect passphrase or damaged configuration.");
        }
        const payload = JSON.parse(decoder.decode(plaintext));
        if (payload.version !== 1) throw new Error("Unsupported configuration contents.");
        return { key, salt, profiles: validateProfiles(payload.profiles) };
    }

    function parseFile(contents) {
        if (typeof contents !== "string" || encoder.encode(contents).length > MAX_FILE_BYTES) throw new Error("Configuration file is too large (maximum 1 MB).");
        return JSON.parse(contents);
    }

    return {
        MAX_FILE_BYTES, validateProfiles, validatePassword, requireCrypto, create, seal, open,
        openWithKey, wrapVaultKey, unwrapVaultKey, validateBiometricMetadata,
        encodeBase64: encode, decodeBase64: decode, parseFile,
    };
})();
