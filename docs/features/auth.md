# Reader Authentication

## Purpose

The EPUB reader runs inside the MyLibriBooks application iframe. Authentication is centralized in `features/auth.js` so feature modules use one API boundary and one session-expiration policy.

## Environments

### Local Development

- Parent application: `http://localhost:3001`
- Reader: `http://127.0.0.1:5501`
- API: `https://beta.mylibribooks.com`
- Authentication: bearer token received from the parent with `postMessage`

The reader accepts only messages from the configured parent origin whose type is `MYLIBRI_AUTH_TOKEN`. The token is kept in memory and in `sessionStorage` under `reader_auth_token`. Local API calls attach it as an `Authorization: Bearer <token>` header and omit cookies.

If no token exists when the local reader loads, authentication waits for the parent message. This avoids treating normal iframe startup timing as an expired session.

### Vercel UAT

- Parent application: `https://libweb.vercel.app`
- Reader: `https://libreader.vercel.app`
- Authentication: bearer token received from the parent with `postMessage`

The Vercel reader is not on the MyLibriBooks production cookie domain, so it also waits for a parent token before calling `GET /api/user/session`. Once the token is received, requests use `Authorization: Bearer <token>` and omit cookies.

### Production

- Parent application: `https://mylibribooks.com`
- Reader: `https://reada.mylibribooks.com`
- API: `https://beta.mylibribooks.com`
- Authentication: HttpOnly `auth_session` cookie

Production API requests use `credentials: "include"`. Tokens in `sessionStorage` are never attached to production requests.

## Parent Message Contract

```js
readerIframe.contentWindow.postMessage({
  type: "MYLIBRI_AUTH_TOKEN",
  token: authToken
}, "http://127.0.0.1:5501");
```

The reader validates both `event.origin` and `event.source`, then verifies the token through `GET /api/user/session`.

## API Helper

All authenticated reader API calls use:

```js
readerFetch(path, options)
```

The helper:

- Prefixes paths with `https://beta.mylibribooks.com`.
- Adds JSON content type unless a caller overrides it.
- Preserves caller headers and fetch options.
- Selects bearer-token or cookie authentication from the reader origin.
- Sends every HTTP 401 to the centralized session-expiration handler.

## User Verification

`verifyReaderUser()` calls `GET /api/user/session`. A successful response is stored in the in-memory `readerAuth` state. Feature modules can use `readerAuth.isAuthenticated()`, `readerAuth.getUser()`, or `readerAuth.whenVerified()`.

The `reader-authenticated` event tells queued analytics to retry after verification succeeds.

## Session Expiration

The first HTTP 401 marks the page session as expired. Later API calls are rejected before reaching the network, which prevents analytics from continuing after authentication is lost.

The reader displays a blocking session-expired overlay and redirects the top-level application after five seconds:

- Local: `http://localhost:3001`
- Production: `https://mylibribooks.com/`

The top window is redirected because navigating only the iframe would leave the surrounding application on a stale authenticated screen.

## Reading History

`features/reading-history.js` calls `saveReadingSession(payload)`, which waits for verified authentication and posts to `/api/user/reading/sessions` through `readerFetch()`. Failed or unauthenticated payloads remain in the existing localStorage queue for later retry.
