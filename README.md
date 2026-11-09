# ESP WAKE PC

## Overview
This project is a static web application that consists of HTML, CSS, and JavaScript files. It serves as a simple template for building web applications.

## Project Structure
```
static-web-project
├── src
│   ├── index.html        # Main HTML document
│   ├── css
│   │   └── styles.css    # Styles for the web application
│   ├── js
│   │   └── script.js      # JavaScript code for interactivity
```

## Getting Started

### Prerequisites
- A web browser (e.g., Chrome, Firefox, Safari)
- A code editor (optional, e.g., VS Code)

### Installation
1. Clone the repository or download the project files.
2. Navigate to the `static-web-project/src` directory.

### Running the Application
1. Open `index.html` in your web browser.
2. The application should load and be fully functional.

### Customization
- Modify `styles.css` to change the appearance of the application.
- Update `script.js` to add or change functionality.

## Encrypted settings and moving computers between devices

Open the dashboard over **HTTPS** (or localhost) in a browser with Web Crypto
and IndexedDB support. On first use, create a **settings passphrase** of at
least 6 characters and confirm it. This is separate from each ESP32's control
password. Existing plaintext profiles, including older single-device settings,
are migrated only after the encrypted record commits successfully; the old
`profiles`, `baseUrl` and `password` records are deleted in that same transaction.
Until migration succeeds, legacy records remain unchanged for retry.

The dashboard now starts locked. Enter the settings passphrase on each reload
to enable computers, polling and control actions. **Lock settings** reloads the
dashboard and discards the in-memory key. No settings passphrase or decryption
key is persisted by this app. Losing this passphrase means losing access to
this browser's saved configuration; keep a separately encrypted export as a
backup. Your browser/password manager may offer to remember entered passphrases;
that is outside this application's storage.

To use the same computers on another phone, tablet or computer:

1. Unlock the source dashboard, open the desired computer's settings and choose
   **Export this computer**. It exports only that computer's saved configuration;
   save any edits first. For a complete backup, use **Export all** at the bottom.
2. Choose and confirm a **file passphrase** (at least 6 characters). This can
   be different from the local settings passphrase.
3. Send `espwake-computer.espwake` (or `espwake-all.espwake` for a full backup)
   to the other device. Send its passphrase through a separate channel;
   do not send both together.
4. On the destination dashboard, create/unlock its local encrypted settings,
   choose **Import computer** next to **Add computer**, select the file and enter
   its file passphrase. The same import accepts single-computer exports and full backups.
5. Default import adds new computers while preserving existing settings, skipping
   duplicates by profile ID, bound ESP32 hostname or configured address.
   **Replace all computers** requires confirmation and replaces the list instead.

All exported computer names, addresses, identities, endpoint inventories and
control passwords are inside authenticated **AES-256-GCM** ciphertext.
Keys are derived using **PBKDF2-SHA-256 with 600,000 iterations**, a random
16-byte salt and a fresh 12-byte IV per encryption. The same format protects
IndexedDB records. Only format/version, cryptographic parameters, salt, IV and
ciphertext remain readable. Runtime status, remote tickets and viewer IDs are
not exported. Imports accept only this encrypted format, at most 1 MB and 100
computers, and reject invalid URLs/identities, incorrect passphrases and damaged
files without replacing saved settings. Imports are re-encrypted using the
destination browser's local key; they are not automatic synchronization.

Encryption does not prevent offline password guessing against a weak passphrase:
six characters are
accepted for convenience, but longer, unpredictable passphrases are recommended.
Existing longer passphrases and encrypted files remain compatible.

Encryption protects stored/exported data, not a compromised dashboard or an
unlocked session: JavaScript must decrypt control passwords in memory to send
commands. Use trusted devices and **HTTPS ESP32/proxy addresses**. Storage
encryption does not encrypt HTTP network traffic or remove the risks of legacy
firmware's unverified configured endpoint. Deleted legacy records may remain in
browser backups or underlying storage; this is not a forensic secure erase.

Encryption/storage regression tests: `node --test tests\encrypted-config.test.cjs`.

## Remote desktop launch

Each computer has a monitor-icon action beside its settings controls. It becomes
available when the PC is online, **RemotePC streaming** is enabled in the ESP32
configuration, the paired Windows helper reports Njk Host, and the ESP32 has a
control password. The device setting is a separate persisted select and defaults
to disabled. An offline PC or disabled RemotePC has a disabled monitor button
with a dark icon and red background; its tooltip explains why. Save that same
password in this computer's ESP Wake profile.
While the monitor action is preparing access it shows a spinner, a green
background and `aria-busy`; polling does not turn that busy icon into an
unavailable/red indicator. Completion or failure restores the monitor icon.
Dark/red remains reserved for an offline PC or disabled/unavailable RemotePC.
The action requests `POST /api/remote` from the identity-verified ESP32, then opens
`/remotepc/` and connects automatically. Approve the host certificate if required.
Firmware 2026.11.09.1 adds `browser_host`: when computer DuckDNS is configured
and enabled, RemotePC uses that **PC hostname**, preserving the gateway port,
instead of the literal IPv4/IPv6 address reported by the Windows helper.
The helper/ESP32 network-detection IP remains unchanged. This preference also
applies when renewing tickets or restoring saved access. No hostname is guessed
from the ESP32's own hostname. Without configured computer DNS, or with older
firmware that does not supply `browser_host`, the original `host` remains the
compatibility fallback. Invalid supplied browser origins fail visibly; DNS/TLS
errors do not silently switch back to a potentially unreachable IP.
Update the ESP32 using **Get Latest Firmware -> Install Firmware** to enable
hostname advertisement, and enable its registered **Computer DuckDNS hostname**.
The client must be able to resolve that hostname and trust its HTTPS certificate.
Before leaving ESPWake, it reserves access with the Host's
`POST /api/connect-prepare`. This consumes the ESP ticket and returns a different
single-use ticket valid for ten minutes, without exposing a persistent token;
stale tickets are discarded while the dashboard can still request fresh access.
Normal launches do not depend on a suspended ESPWake page to renew access.
The initial launch window shows progress instead of remaining blank while the
Windows helper refreshes the pool. Update the Host gateway before this dashboard;
certificate failures provide a certificate-check link without leaving ESPWake.
Touch/mobile and installed ESPWake launches navigate the existing window to the
canonical RemotePC URL rather than opening a temporary blank browser tab.
Whether a separately installed RemotePC app captures that link is controlled by
the phone's browser/OS. The RemotePC manifest requests reuse of an existing app.
RemotePC selects fullscreen automatically for this launch. A browser requiring
a fresh user gesture can defer fullscreen until the first video tap without
blocking the stream or asking for a token/Connect click. Versioned script assets
refresh the connection shell; host credentials remain in the fragment only as
an ephemeral ticket. A persistent, non-secret per-profile viewer ID allows Host
to replace an old connection from the same browser/profile without disconnecting
other devices or weakening the multi-client Quit guard.

The host issues four single-use connection tickets valid for two minutes. The
Windows helper forwards them through USB or authenticated bonded Bluetooth;
the ESP32 keeps them only in RAM and releases one per authenticated request.
Tickets travel in the RemotePC URL fragment, not its query, and are removed from
browser history before redemption. The long-lived host token never enters the
ESP32 or ESP Wake profile. An exhausted/expired pool requires the next helper
report; errors remain visible. Both PWAs use the same forest/lime design tokens,
Manrope/Space Grotesk typography and compact controls.

Legacy, unprepared links can renew an expired/reused ticket through an
origin-scoped BroadcastChannel with a random per-launch nonce. The
exact-origin/source postMessage broker is tried alongside BroadcastChannel.
RemotePC retries requests and displays elapsed progress; an unanswered attempt
ends with an explicit return-to-ESPWake link, not an indefinite loading status.
Browser/OS suspension can defer timeout callbacks; another browser/storage
partition cannot share this channel. New prepared launches do not require the
dashboard or broker to remain active.

## Configuration Login

In a normal browser tab, the configuration button opens a fresh window and posts the saved control password from that window to the ESP32 login endpoint. The form stays attached until navigation.

In the installed app (standalone/fullscreen, including iOS Home Screen mode), Config submits the saved control password as a POST to `/login` using a form in the current page with `target="_self"`. This leaves the dashboard instead of creating an `about:blank` popup. The ESP32's successful login response redirects to its configuration root. With no saved password, Config opens the root page directly as before. This frontend-only workaround still needs verification on the target phone: the operating system/browser controls how out-of-scope PWA navigation is displayed and handed off.

Configuration URLs retain a trailing slash and proxy path prefixes. Passwords are not placed in URLs, and the new window does not retain an opener.

After deploying changes to GitHub Pages, reload the dashboard to receive the updated script/service worker. Local edits do not change the published site automatically.

## ESP32 endpoint discovery and identity

After the configured base URL first answers `/api/identity`, the dashboard stores the ESP32's stable `device_hostname` (derived from the station MAC) as the profile identity. It stores discovered HTTPS IP/hostname URLs separately. Status and control requests revalidate the selected endpoint first, then try the configured URL and stored alternatives sequentially if needed. Discovery stops at the first matching hostname; it does not wait for all unreachable addresses or create concurrent TLS handshakes. The working bootstrap URL is reused immediately. The endpoint inventory is optional and refreshed at most every five minutes during polling; its failure does not make a verified connection offline.

Only a matching identity may receive credentials at a discovered address. Operations for the same configured URL are serialized. A status refresh tries up to three times on a timeout or transport failure; failed endpoints move behind known alternatives, and each alternative must pass identity verification before receiving credentials. The existing card state stays visible while retries run; only three transport failures mark it unreachable. Authentication, identity mismatch, HTTP and invalid-response errors are surfaced directly, without retries. A power command is never automatically resent: a lost response does not prove the relay command failed. The dashboard never derives identity from an IP. Use **Forget ESP32 identity** only when intentionally replacing/rebinding the physical board.

Identity, status and optional endpoint inventory requests have 1,500 ms deadlines, including response body reads. Each retried status attempt shares one 1,500 ms network budget across identity discovery, status and optional inventory: three timed-out attempts take approximately 4.5 seconds, not three long discovery rounds. Optional inventory runs only after a successful status and cannot turn that success into an offline result if it times out. These are failure limits, not expected latency; browser scheduling and queued operations can add time. Firmware may spend about 810 ms on three unanswered pings or 1,060 ms including IPv4 fallback, before TLS/network overhead, so 700 ms would cause false failures. Power requests retain the twelve-second deadline because older firmware waits for the seven-second relay hold before replying to forced shutdown; shortening it would falsely report failure after a command has already acted.

Legacy firmware keeps using only the manually configured URL, including proxy prefixes and the existing GET/POST password contract. Old firmware may return a 404 without CORS headers, which browsers expose as a fetch error rather than a visible 404. An unbound profile can still attempt status at its explicitly configured URL; connection/authentication failures remain visible. This compatibility path is never used for an already-bound profile or discovered addresses. Identity support is checked again after five minutes or on manual refresh, so upgrading an old board enables discovery without recreating the profile. Certificate errors and HTTPS-to-HTTP mixed-content restrictions still require browser/user action.

## Certificate Confirmation

The certificate confirmation button opens `GET /certificate-check` on the saved ESP32 base URL, preserving its port and any proxy prefix. After the user accepts the browser's certificate warning for their own device, the firmware serves a page that calls `window.close()`. No password or configuration session is required or changed. This does not bypass certificate verification or install a trusted certificate.

Browsers normally allow a script-opened tab to close itself. Mobile PWA handoff to another browser or a manually opened tab may prevent automatic closing; the page then displays "Connection confirmed" and can be closed manually. Certificate exceptions may not carry over to a different browser context. This endpoint requires updated ESP32 firmware; older firmware returns Not Found.

Run the focused regression tests with Node.js:

```shell
node --test tests/*.test.cjs
```

## Firmware and Windows helper downloads

Downloads are available from this public repository's
[latest release](https://github.com/taducanh1605/espwake/releases/latest) and the ESP32
configuration page, not the dashboard footer. In configuration, the Windows helper link
appears only when automatic USB computer detection is checked.
Firmware source is maintained separately in the private `esp32_wake` repository.
No GitHub token is needed by a device or a user downloading release assets.

- **esp32_wake_ota.bin**: application-only ESP32-C3 firmware. In ESP32 configuration,
  use **Choose File** for a local `.bin`, or **Get Latest Firmware** to download and verify the
  latest release in the ESP32's inactive OTA partition. Then click **Install Firmware** and confirm.
  Choosing a file or downloading alone does not activate the image or restart. The downloaded
  filename/version is shown next to the selector; it is not saved on the browser computer.
  Downloaded readiness resets on ESP32 reboot. Selecting a local file takes precedence;
  Get Latest Firmware clears the local choice.
- **esp32-wake-usb-flash.zip**: merged image plus USB flash scripts for first installation/recovery.
  Extract, connect the board, and run `flash_merged.bat COM4` (replace COM4).
  Do not upload the merged `esp32_wake_firmware.bin` using OTA.
- **esp32-wake-windows-helper.zip**: extract and run `install-helper.bat`.
  Use Run as administrator for Windows startup before sign-in; normal mode starts at user sign-in.
  Enable automatic USB computer detection in ESP32 configuration. See the included `INSTALL.md`.
- **firmware-manifest.json** and **SHA256SUMS.txt**: version, board, byte size and SHA-256 integrity data.

For maintainers: update `src/firmware_version.h` in the private firmware checkout, run
`build_release.ps1`, then `public_release.ps1`. Its default frontend checkout is the sibling
`espwake` directory. The publisher validates binaries and creates a draft, verifies uploaded asset
sizes, then publishes it as latest in this repository. Existing versions are not overwritten.
Only approved distribution assets are published, never the private source tree.

Updates preserve ESP32 settings and require signing in again after restart. Keep power connected.
Firmware `2026.10.20.2` fixes manual GitHub redirect handling. If older firmware shows
`ESP_ERR_HTTP_MAX_REDIRECT`, download the application `.bin` here using a browser and install
it once using the old configuration page's upload button.
Firmware without OTA support needs one USB update first. GitHub OTA requires Internet/NTP,
verifies TLS and SHA-256, and does not run automatically. Checksums are not firmware signatures;
protect release publishing access. Invalid transfers do not switch boot partitions, but runtime
defects in a valid image require USB recovery (no automatic health rollback).

## License

This project is open-source and available under the MIT License.
