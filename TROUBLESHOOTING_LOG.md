# Troubleshooting Summary: "Blocked Script Execution" Error

This document summarizes the steps taken to resolve the persistent `Blocked script execution... sandbox... 'allow-scripts'` error encountered when loading the embedded Shopify app.

## 1. Initial Problem

App fails to load in Shopify Admin iframe, showing a sandbox error indicating the `allow-scripts` permission is missing. This prevents the frontend JavaScript (including React and App Bridge) from running. Browser console also showed related issues like missing App Bridge parameters (`apiKey`, `host`).

## 2. Hypotheses

*   Incorrect Content Security Policy (CSP) header blocking script execution or necessary connections (potentially interaction between manual CSP and library).
*   Failure in App Bridge initialization due to missing or incorrect configuration (`apiKey`, `host`).
*   Session validation issues or missing installation check between the app backend and Shopify, leading Shopify to distrust the app and enforce the sandbox *before* backend middleware can react and redirect.
*   ES Module loading/timing issues preventing middleware from being correctly applied.
*   Failure in post-initialization communication/permission handshake between App Bridge and Shopify Admin shell.
*   Failure of App Bridge CDN script (or potentially *any* script) to execute fully due to missing `allow-scripts` sandbox permission.
*   Missing configuration flags (e.g., `future` flags for new auth strategies) or subtle differences in `shopifyApi` setup compared to official templates.
*   Incorrect server-side handling of initial request vs. authenticated request for the main app page.

## 3. Steps Taken & Outcomes

*   **Checked `.env` Variables:** Ensured `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`, and `HOST` were present and correctly configured in `daily-drop-manager/backend/.env`. Confirmed `HOST` matched the ngrok URL.
    *   *Outcome:* Variables seemed correct, but errors persisted. Added logging to `server.js` to confirm they were loaded.

*   **Switched Session Storage:** Replaced volatile `MemorySessionStorage` with persistent `SQLiteSessionStorage` in `daily-drop-manager/backend/shopify.js` to prevent session loss on server restart.
    *   *Outcome:* Resolved an `ERR_MODULE_NOT_FOUND` crash by reinstalling the `@shopify/shopify-app-session-storage-sqlite` package. Session storage seems stable now, but the sandbox error remained.

*   **Examined/Modified CSP (in `server.js` fallback route):**
    *   Analyzed the manually set CSP header.
    *   Temporarily removed the `font-src` directive.
        *   *Outcome:* No change. Reverted.
    *   Corrected the `frame-ancestors` directive after encountering a "Refused to frame" error. The issue was using the full decoded path from the `host` parameter instead of just the hostname (`admin.shopify.com`).
        *   *Outcome:* Resolved "Refused to frame" error, but sandbox error returned.

*   **App Bridge Configuration Injection:**
    *   Identified that static `frontend/dist/index.html` wasn't receiving `apiKey`/`host`. `main.jsx` was incorrectly trying to use `import.meta.env`.
    *   Modified `server.js` fallback route to read `index.html`, inject a `<script>` setting `window.shopify = { apiKey: ..., host: ... };`, and send modified HTML.
    *   Modified `main.jsx` to read config from `window.shopify`.
    *   Moved the injected script from `</head>` to start of `<body>`.
        *   *Outcome:* `main.jsx` now receives correct config, but sandbox error persists.

*   **Adjusted App Bridge Config:**
    *   Commented out `forceRedirect: true` in App Bridge config within `main.jsx`.
        *   *Outcome:* No change. Sandbox error persisted.
    *   Restored `forceRedirect: true` in App Bridge config.
        *   *Outcome:* No change. Sandbox error persisted.

*   **Simplified Frontend (React):** Replaced `App.jsx` content with minimal component rendering static text and attempting a basic App Bridge Toast action.
    *   *Outcome:* Sandbox error persisted. Console logs showed App Bridge instance *was* available and the Toast action was *dispatched*, but the Toast likely didn't appear, suggesting post-initialization communication failure.

*   **Refactored Middleware Application:**
    *   Attempted applying `shopifyAppInstance` globally via `app.use(shopifyAppInstance)` in `server.js`.
        *   *Outcome:* Backend crashed immediately with `TypeError: app.use() requires a middleware function`.
    *   Refactored `shopify.js` to export a creator function (`createShopifyAppInstance`) instead of the instance directly, to mitigate potential ES Module timing issues. Removed duplicate instance creation logic in `shopify.js`.
    *   Modified `server.js` to import and call the creator function.
        *   *Outcome:* Backend still crashed with `TypeError: app.use() requires a middleware function` or `TypeError: Cannot read properties of undefined (reading 'auth')`.
    *   Removed global `app.use(shopifyAppInstance)`. Applied specific Shopify middleware functions (`auth.begin`, `auth.callback`, `validateAuthenticatedSession`, etc.) directly to relevant routes in `server.js`, with checks for validity.
        *   *Outcome:* Backend server started successfully.
    *   Attempted applying `shopifyAppInstance` middleware directly to `app.get('*', ...)` route.
        *   *Outcome:* Backend crashed with `Error: Route.get() requires a callback function but got a [object Object]`.

*   **CSP Application Strategy:**
    *   Removed manual CSP from fallback route, attempting to rely on global middleware.
        *   *Outcome:* Backend crashed (see middleware refactoring).
    *   Removed manual CSP and applied `shopifyAppInstance` to fallback route.
        *   *Outcome:* Backend crashed (see middleware refactoring).
    *   Applied manual CSP setting within fallback route handler.
        *   *Outcome:* Server starts, sandbox error persists in browser.
    *   Removed manual CSP from fallback route handler, relying on `validateAuthenticatedSession` (applied before handler) to manage headers during auth.
        *   *Outcome:* Server starts, backend logs show redirect attempt, but browser sandbox likely still blocks it.

*   **Static HTML Test (CDN App Bridge):**
    *   Created `static-test.html` using CDN App Bridge script.
    *   Modified `server.js` fallback to serve this file + inject config.
    *   Wrapped inline script in `DOMContentLoaded` listener.
    *   *Outcome:* Sandbox error persisted. `DOMContentLoaded` fired, config was read, but `window['@shopify/app-bridge']` was still undefined. This indicates the sandbox blocks the CDN script execution before it can define the library.
    *   Reverted `server.js` to serve `index.html`. Deleted `static-test.html`.

*   **Applied `ensureInstalledOnShop` Middleware:** Added `app.use(shopifyAppInstance.ensureInstalledOnShop());` early in `server.js` before other routes.
    *   *Outcome:* Backend logged errors (`ensureInstalledOnShop did not receive a shop query argument`) for asset requests. Browser showed `400 Bad Request` for assets and sandbox error persisted for `/exitiframe` path.

*   **Applied `validateAuthenticatedSession` to Fallback Route:** Removed global `ensureInstalledOnShop`. Added `validateAuthenticatedSession()` as the first middleware for the `app.get('*', ...)` route.
    *   *Outcome:* Backend logs showed `Session was not valid. Redirecting to /auth?shop=...`, but browser likely couldn't perform redirect due to initial sandboxing. Browser sandbox error persisted.

*   **Removed Session Validation from Fallback Route:** Removed `validateAuthenticatedSession()` from the start of the `app.get('*', ...)` route. Fallback handler now always serves HTML, relying on frontend App Bridge to initiate auth if needed.
    *   *Outcome:* Test failed because global `ensureInstalledOnShop` middleware was still incorrectly present, causing 400 errors on assets.

*   **Corrected Server Setup:** Explicitly removed global `ensureInstalledOnShop` middleware from `server.js`.
    *   *Outcome:* Sandbox error still occurred immediately, preventing App Bridge (`forceRedirect: true`) from initiating auth flow.

*   **Compared with CLI Template (Remix):** Generated default Remix template.
    *   Identified key difference: Template uses `future: { unstable_newEmbeddedAuthStrategy: true }` flag in its `shopifyApp` config. Template also uses server-side auth (`authenticate.admin`) in a `loader` before rendering the main app route component.

*   **Added `future` flag to `shopifyApi` config:** Added `future: { unstable_newEmbeddedAuthStrategy: true }` to the `shopifyApi` call in `shopify.js`.
    *   *Outcome:* Sandbox error still occurred immediately.

*   **Re-added `validateAuthenticatedSession` to Fallback Route:** Added `validateAuthenticatedSession()` back as the first middleware for `app.get('*', ...)`, intending for it to handle the auth redirect *before* the custom HTML handler runs (if session is invalid).
    *   *Outcome:* Backend logs showed `Session was not valid. Redirecting to /auth?shop=...`, but browser sandbox still blocked the redirect.

*   **Aligned `shopifyApi` Config with Template:** Modified `shopify.js` to use full `HOST` for `hostName`, removed `hostScheme`, removed `isEmbeddedApp: true`, set specific `apiVersion: ApiVersion.January25`.
    *   *Outcome:* Sandbox error persisted, still blocked redirect.

*   **Implemented Loader Pattern:**
    *   Created `loader.html`.
    *   Modified `server.js` fallback to serve `loader.html` first without session check but with CSP.
        *   *Outcome:* `loader.html` loaded successfully without sandbox error.
    *   Added client-side redirect script (`window.location.href`) to `loader.html`.
    *   Restored `server.js` fallback (`*`) to use `validateAuthenticatedSession` and serve `index.html`.
        *   *Outcome:* Backend logs showed loader -> redirect -> `validateAuthenticatedSession` -> attempt to redirect to `/auth`. Browser likely still blocked `/auth` redirect due to sandbox.
    *   Removed manual CSP from `loader.html` response.
        *   *Outcome:* No change, backend still attempted `/auth` redirect, browser blocked.
    *   Restored manual CSP to `loader.html` response.
    *   Modified `loader.html` script to use App Bridge CDN and `AppBridge.actions.Redirect`.
    *   Modified `server.js` loader route to inject API key into `loader.html`.
        *   *Outcome:* No change, backend still attempted `/auth` redirect, browser blocked.

*   **Re-added `isEmbeddedApp: true` to `shopifyApi` config:** Explicitly set `isEmbeddedApp: true` in `shopify.js`, keeping the loader pattern.
    *   *Outcome:* No change, backend logs still showed `/auth` redirect attempt, browser still blocked.

*   **Implemented Client-Side Auth Check:**
    *   Removed `validateAuthenticatedSession` from main `*` route in `server.js`.
    *   Added `/api/verify` endpoint (protected by session validation) to `server.js`.
    *   Set `forceRedirect: false` in `main.jsx` App Bridge config.
    *   Added `useEffect` in `App.jsx` to use `authenticatedFetch` to call `/api/verify`.
    *   If `/api/verify` fails (401/403), use App Bridge `Redirect` action to go to `/auth?shop=...`.
    *   *Outcome:* Sandbox error occurred immediately on loading index.html, before client-side check could run.

*   **Pinned Backend Shopify Library Versions:** Removed `^` from `@shopify/shopify-api`, `@shopify/shopify-app-express`, `@shopify/shopify-app-session-storage-sqlite` in backend `package.json` and ran `npm install`.
    *   *Outcome:* No change, sandbox error still occurred immediately on loading `index.html`.

*   **Explicitly Set Framing Headers:** Added manual `Content-Security-Policy` and `X-Frame-Options` headers to the main app route (`*`) in `server.js` (where `index.html` is served), keeping the client-side auth check.
    *   *Outcome:* No change, sandbox error still occurred immediately.

*   **Explicitly Set Cookie Options:** Added `cookieOptions: { sameSite: 'None', secure: true }` to `shopifyApi` config in `shopify.js`.
    *   *Outcome:* No change, sandbox error still occurred immediately.

*   **Radical Backend/Frontend Simplification:**
    *   Removed API/webhook/auth middleware and routes from `server.js`.
    *   Main `*` route serves `index.html` without session check or config injection, but with manual CSP/X-Frame headers.
    *   `/loader.html` route serves loader with API key injection and CSP.
    *   Removed client-side auth check from `App.jsx`, reverted to basic App Bridge init/Toast test.
    *   Set `forceRedirect: true` in `main.jsx`.
    *   *Outcome:* No change, sandbox error still occurred immediately.

*   **Minimal HTML Test:** Changed main `*` route to serve hardcoded minimal HTML with CSP/X-Frame headers.
    *   *Outcome:* Minimal HTML loaded successfully, NO sandbox error.

*   **Restored index.html Serving:** Reverted main `*` route to serve `index.html` (still with explicit headers, no server-side auth check).
    *   *Outcome:* Sandbox error returned immediately, confirming issue is with `index.html` or its assets.

*   **Attempt Legacy Build:** Added `@vitejs/plugin-legacy` to frontend build. Rebuilt frontend.
    *   *Outcome:* Build succeeded, added `nomodule` scripts/polyfills to `index.html`, but primary script still uses `type="module"`. Sandbox error persisted immediately.

*   **Modified Vite Build Config:** Set `build.target: 'es2015'` and `build.polyfillModulePreload: true` in `vite.config.js`. Rebuilt frontend.
    *   *Outcome:* Build succeeded (with deprecation/override notes). Sandbox error persisted immediately.

*   **Injected Early App Bridge (CDN):** Modified `server.js` to inject *both* `window.shopify` config and App Bridge CDN script (`unpkg.com`) into `<head>` before Vite scripts.
    *   *Outcome:* Sandbox error persisted immediately. Browser also showed CSP error blocking `unpkg.com` (as expected, since it wasn't added to `script-src`). App Bridge still failed to initialize in `main.jsx` despite `window.shopify` object being present later.

*   **Loader Pattern w/ Pre-Auth:** Modified `server.js` to serve `loader.html` from `/` route (no session check). `loader.html` used App Bridge CDN to redirect to `/auth?shop=...`. Fallback `*` route added `validateAuthenticatedSession` before serving main `index.html`.
    *   *Outcome:* Sandbox error (`allow-scripts`) occurred immediately on `/` load, preventing `loader.html` scripts (both CDN and inline) from running. Loader failed with "App Bridge CDN script not loaded yet".

*   **Deferred Module Loading:** Modified authenticated `*` route handler in `server.js` to read `index.html`, comment out the main `<script type="module">` tag, inject config, and add an inline script to dynamically re-append the module script after a timeout.
    *   *Outcome:* This attempt was not reached. The initial load of `/` still served `loader.html`, which failed immediately due to the sandbox error blocking its own scripts (see previous step). The deferred loading logic for the main app was never executed.

*   **Switched to Non-Embedded:** Decided to abandon embedded approach due to persistent sandbox errors.
    *   Modified `shopify.js`: Set `isEmbeddedApp: false`, removed `future` flag.
    *   Modified `server.js`: Removed `/` loader route. Added `validateAuthenticatedSession` to `*` route. Removed `frame-ancestors` from CSP. Reverted `index.html` serving to normal (inject config only).
    *   Modified `main.jsx`: Removed `forceRedirect: true` from App Bridge config.
    *   *Goal:* Eliminate sandbox errors by running standalone. Expect loss of embedded-only App Bridge UI features.

*   **Fix Non-Embedded Redirect Loop:** Encountered `ERR_TOO_MANY_REDIRECTS` after switching to non-embedded.
    *   *Diagnosis:* Logs showed successful callback/session creation, but immediate failure of `validateAuthenticatedSession` on the subsequent redirect to `*`, causing a loop back to `/auth`.
    *   *Attempt 1:* Explicitly add `/auth` and `/auth/callback` routes. Outcome: Loop persisted. Logs showed webhook registration failing during callback.
    *   *Attempt 2:* Disable automatic webhook registration during auth (`shopify.js`). Remove explicit redirect from `/auth/callback` route handler (`server.js`). Outcome: Loop persisted. "Registering webhooks" log still appeared.
    *   *Attempt 3:* Re-added `shopifyAppInstance.redirectToShopifyOrAppRoot()` to `/auth/callback` route, suspecting it finalizes session state. Outcome: Loop persisted.
    *   *Attempt 4:* Removed `redirectToShopifyOrAppRoot()` again, added simple manual redirect `res.redirect('/?shop=...')` after `auth.callback()`. Outcome: Callback failed with 500 Internal Server Error, logs indicated Shopify returned 400 Bad Request during token exchange.
    *   *Attempt 5:* Verified URLs/Keys match Partner Dashboard. Modified `shopify.js` to provide only hostname (no scheme) to `hostName` config, aligning with docs examples. Outcome: Callback still failed with 500/400.
    *   *Attempt 6:* Removed manual redirect from `/auth/callback`, letting only `auth.callback()` handle the route.
    *   *Attempt 7:* Explicitly validate *offline* session in main `*` route using `validateAuthenticatedSession({ online: false })` in `server.js`. Outcome: Failed. Logs showed `Missing Authorization header` error during validation, causing redirect loop.
    *   *Attempt 8:* Removed server-side session validation from `*` route. Added explicit redirect `/?shop=...` from `/auth/callback`. Added `/api/verify-session` endpoint (protected by validation). Implemented client-side check in `App.jsx` using `authenticatedFetch('/api/verify-session')` and App Bridge `Redirect` on failure. Outcome: Failed. Frontend error `Missing API key or shop from window.shopify` because backend wasn't injecting `shop`.
    *   *Attempt 9:* Modified `server.js` `*` route to correctly inject `req.query.shop` into `window.shopify` object. Outcome: Failed. Frontend error `APP::ERROR::INVALID_CONFIG: host must be provided` because `host` parameter is lost after OAuth redirect.
    *   *Attempt 10:* Modified `server.js` `*` route handler to *derive* and Base64 encode the `host` parameter from `req.query.shop` (`shop-domain/admin`) if `req.query.host` is missing. Outcome: Partially successful. App Bridge initialized, but threw non-fatal `postMessage` origin mismatch errors. Proceeding to client-side auth check.
    *   *Attempt 11 (Client-side Auth Check):* Frontend `App.jsx` uses `authenticatedFetch('/api/verify-session')`. Outcome: ???

## 4. Current Status

*   Backend (`