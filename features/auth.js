(function () {
  "use strict";

  const API_BASE_URL = "https://backendnodedev-dot-starlit-advice-260914.appspot.com";
  const LOCAL_READER_ORIGIN = "http://127.0.0.1:5501";
  const LOCAL_PARENT_ORIGIN = "http://localhost:3001";
  const PRODUCTION_PARENT_ORIGIN = "https://mylibribooks.com";
  const TOKEN_STORAGE_KEY = "reader_auth_token";
  const REDIRECT_DELAY_MS = 5000;
  const ALLOWED_PARENT_ORIGINS = [LOCAL_PARENT_ORIGIN, PRODUCTION_PARENT_ORIGIN];

  let authToken = readStoredToken();
  let authenticatedUser = null;
  let verificationPromise = null;
  let sessionExpired = false;
  let sessionExpirationHandled = false;

  function isLocalDevelopment() {
    return window.location.origin === LOCAL_READER_ORIGIN;
  }

  function readStoredToken() {
    try {
      return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function storeToken(token) {
    authToken = token;
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch (err) {
      console.error("Unable to store the reader authentication token.", err);
    }
  }

  function clearToken() {
    authToken = "";
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (err) {}
  }

  function readerFetch(path, options) {
    options = options || {};

    // Once a session expires, no later API call may leak through, including analytics retries.
    if (sessionExpired) {
      return Promise.reject(new Error("Reader API activity stopped because the session expired."));
    }

    const requestOptions = Object.assign({}, options);
    const headers = new Headers(options.headers || {});
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    if (isLocalDevelopment()) {
      const token = authToken || readStoredToken();
      if (token) headers.set("Authorization", "Bearer " + token);
      requestOptions.credentials = "omit";
    } else {
      requestOptions.credentials = "include";
    }

    requestOptions.headers = headers;
    const url = /^https?:\/\//i.test(path) ? path : API_BASE_URL + path;

    return fetch(url, requestOptions).then(response => {
      if (response.status === 401) handleSessionExpiration();
      return response;
    });
  }

  function parseJsonResponse(response) {
    return response.text().then(text => {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error("The session endpoint returned invalid JSON.");
      }
    });
  }

  function verifyReaderUser() {
    if (sessionExpired) {
      return Promise.reject(new Error("Cannot verify an expired reader session."));
    }
    if (verificationPromise) return verificationPromise;

    if (isLocalDevelopment() && !(authToken || readStoredToken())) {
      authenticatedUser = null;
      console.warn("Reader authentication is waiting for a token from the parent application.");
      return Promise.resolve(null);
    }

    const verification = readerFetch("/api/user/session", { method: "GET" })
      .then(response => parseJsonResponse(response).then(data => ({ response: response, data: data })))
      .then(result => {
        if (!result.response.ok) {
          const message = result.data && result.data.message || "Reader user is not authenticated.";
          throw new Error(message);
        }

        authenticatedUser = result.data && (result.data.user || result.data.data) || result.data;
        if (!authenticatedUser) throw new Error("The session response did not include an authenticated user.");

        if (isLocalDevelopment()) console.log("Authenticated reader user:", authenticatedUser);
        window.dispatchEvent(new CustomEvent("reader-authenticated", {
          detail: { user: authenticatedUser }
        }));
        return authenticatedUser;
      })
      .catch(err => {
        authenticatedUser = null;
        console.error("Reader authentication failed:", err.message || err);
        throw err;
      });

    verificationPromise = verification.then(user => {
      verificationPromise = null;
      return user;
    }, err => {
      verificationPromise = null;
      throw err;
    });
    return verificationPromise;
  }

  function whenVerified() {
    if (authenticatedUser && !sessionExpired) return Promise.resolve(authenticatedUser);
    return verifyReaderUser().then(user => {
      if (!user) throw new Error("Reader user has not been authenticated.");
      return user;
    });
  }

  function handleAuthMessage(event) {
    if (ALLOWED_PARENT_ORIGINS.indexOf(event.origin) === -1) return;
    if (event.source !== window.parent) return;
    if (!event.data || event.data.type !== "MYLIBRI_AUTH_TOKEN") return;
    if (typeof event.data.token !== "string" || !event.data.token.trim()) return;

    storeToken(event.data.token.trim());
    authenticatedUser = null;
    verifyReaderUser().catch(() => {});
  }

  function handleSessionExpiration() {
    // Several requests can return 401 together; only the first should create UI and schedule navigation.
    if (sessionExpirationHandled) return;
    sessionExpirationHandled = true;
    sessionExpired = true;
    authenticatedUser = null;
    clearToken();
    lockReaderInteraction();
    showSessionExpiredOverlay();

    window.setTimeout(() => {
      const redirectUrl = isLocalDevelopment() ? LOCAL_PARENT_ORIGIN : PRODUCTION_PARENT_ORIGIN + "/";
      // The reader is embedded, so the top window must leave the whole application rather than only the iframe.
      window.top.location.href = redirectUrl;
    }, REDIRECT_DELAY_MS);
  }

  function lockReaderInteraction() {
    const app = document.querySelector(".app");
    if (app) {
      app.style.pointerEvents = "none";
      app.setAttribute("aria-hidden", "true");
      if ("inert" in app) app.inert = true;
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

    ["click", "keydown", "keyup", "touchstart", "pointerdown"].forEach(type => {
      window.addEventListener(type, blockReaderInteraction, true);
    });
  }

  function blockReaderInteraction(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function showSessionExpiredOverlay() {
    if (document.getElementById("reader-session-expired")) return;

    const overlay = document.createElement("div");
    overlay.id = "reader-session-expired";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "reader-session-expired-title");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.94);color:#111827;font-family:Arial,sans-serif;";

    const dialog = document.createElement("div");
    dialog.style.cssText = "width:min(460px,100%);padding:28px;background:#fff;border-radius:8px;box-shadow:0 18px 50px rgba(0,0,0,.35);text-align:center;";

    const title = document.createElement("h1");
    title.id = "reader-session-expired-title";
    title.textContent = "Session Expired";
    title.style.cssText = "margin:0 0 12px;font-size:24px;line-height:1.25;letter-spacing:0;";

    const message = document.createElement("p");
    message.textContent = "Your session has expired. Please sign in again to continue reading. Redirecting you to MyLibriBooks...";
    message.style.cssText = "margin:0;color:#4b5563;font-size:16px;line-height:1.6;letter-spacing:0;";

    dialog.appendChild(title);
    dialog.appendChild(message);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  window.addEventListener("message", handleAuthMessage, false);

  window.readerFetch = readerFetch;
  window.verifyReaderUser = verifyReaderUser;
  window.readerAuth = {
    getUser: function () { return authenticatedUser; },
    isAuthenticated: function () { return !!authenticatedUser && !sessionExpired; },
    isSessionExpired: function () { return sessionExpired; },
    whenVerified: whenVerified
  };

  verifyReaderUser().catch(() => {});
})();
