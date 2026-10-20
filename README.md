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

## Configuration Login

In a normal browser tab, the configuration button opens a fresh window and posts the saved control password from that window to the ESP32 login endpoint. The form stays attached until navigation.

In the installed app (standalone/fullscreen, including iOS Home Screen mode), Config submits the saved control password as a POST to `/login` using a form in the current page with `target="_self"`. This leaves the dashboard instead of creating an `about:blank` popup. The ESP32's successful login response redirects to its configuration root. With no saved password, Config opens the root page directly as before. This frontend-only workaround still needs verification on the target phone: the operating system/browser controls how out-of-scope PWA navigation is displayed and handed off.

Configuration URLs retain a trailing slash and proxy path prefixes. Passwords are not placed in URLs, and the new window does not retain an opener.

After deploying changes to GitHub Pages, reload the dashboard to receive the updated script/service worker. Local edits do not change the published site automatically.

## Certificate Confirmation

The certificate confirmation button opens `GET /certificate-check` on the saved ESP32 base URL, preserving its port and any proxy prefix. After the user accepts the browser's certificate warning for their own device, the firmware serves a page that calls `window.close()`. No password or configuration session is required or changed. This does not bypass certificate verification or install a trusted certificate.

Browsers normally allow a script-opened tab to close itself. Mobile PWA handoff to another browser or a manually opened tab may prevent automatic closing; the page then displays "Connection confirmed" and can be closed manually. Certificate exceptions may not carry over to a different browser context. This endpoint requires updated ESP32 firmware; older firmware returns Not Found.

Run the focused regression tests with Node.js:

```shell
node --test tests/configuration-login.test.cjs
```

## Firmware and Windows helper downloads

The dashboard and ESP32 configuration page link to this public repository's
[latest release](https://github.com/taducanh1605/espwake/releases/latest).
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
