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

The configuration button opens a fresh window and posts the saved control password from that window to the ESP32 login endpoint. The form stays attached until navigation, and configuration URLs retain a trailing slash. Proxy path prefixes are preserved. Passwords are not placed in URLs, and the new window does not retain an opener.

After deploying changes to GitHub Pages, reload the dashboard to receive the updated script/service worker. Local edits do not change the published site automatically.

Run the focused regression tests with Node.js:

```shell
node --test tests/configuration-login.test.cjs
```

## License
This project is open-source and available under the MIT License.
