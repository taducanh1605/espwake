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

## License
This project is open-source and available under the MIT License.
