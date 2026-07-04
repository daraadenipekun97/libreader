(function () {
  "use strict";

  const MIN_READING_WPM = 100;
  const MAX_READING_WPM = 500;
  const ACTIVE_WINDOW_MS = 120000;
  const SYNC_INTERVAL_SECONDS = 300;
  const SYNC_INTERVAL_MS = SYNC_INTERVAL_SECONDS * 1000;
  const COMPLETION_THRESHOLD = 85;
  const API_URL = "https://beta.mylibribooks.com/api/user/reader/reading-history";

  function ReadingHistoryManager(app) {
    this.app = app;
    this.book = null;
    this.rendition = null;
    this.context = window.readerContext || {};
    this.storage = new ReadingHistoryStorage();
    this.sync = new ReadingHistorySync(this.storage);
    this.session = null;
    this.currentView = null;
    this.lastInteractionAt = 0;
    this.lastSyncVerifiedSeconds = 0;
    this.lastQueuedVerifiedSeconds = 0;
    this.boundContents = [];
    this.syncTimer = null;
    this.backButton = null;

    this.onRelocated = this.onRelocated.bind(this);
    this.onDisplayed = this.onDisplayed.bind(this);
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
    this.onBeforeUnload = this.onBeforeUnload.bind(this);
    this.onActivity = this.onActivity.bind(this);
    this.onBackToBook = this.onBackToBook.bind(this);
    this.onPeriodicSync = this.onPeriodicSync.bind(this);

    ["click", "keydown", "mousemove", "touchstart"].forEach(type => {
      document.addEventListener(type, this.onActivity, true);
    });
    document.addEventListener("visibilitychange", this.onVisibilityChange, false);
    window.addEventListener("beforeunload", this.onBeforeUnload, false);
  }

  ReadingHistoryManager.prototype.attach = function (book, rendition) {
    this.detach();
    this.book = book;
    this.rendition = rendition;
    this.context = window.readerContext || {};

    if (!this.hasValidContext()) return;

    this.session = this.storage.loadSession(this.context.bookId) || this.createSession();
    this.session.bookId = this.context.bookId;
    this.session.genre = this.context.genre;
    this.session.sessions = this.session.sessions || 1;
    this.session.highestPageRead = Math.max(
      Number(this.session.highestPageRead) || 0,
      this.highestCertifiedPage(this.session.certifiedLocations)
    );
    this.lastQueuedVerifiedSeconds = this.session.lastQueuedVerifiedSeconds || 0;
    this.lastSyncVerifiedSeconds = this.session.lastSyncedVerifiedSeconds || 0;
    this.save();

    rendition.on("relocated", this.onRelocated);
    rendition.on("displayed", this.onDisplayed);
    this.attachBackButton();
    this.startSyncTimer();
    this.sync.retry();
  };

  ReadingHistoryManager.prototype.detach = function () {
    if (this.session) {
      this.checkpointCurrentView({ allowHidden: true });
      this.queueSync("detach", { keepalive: true });
      this.save();
    }
    this.stopSyncTimer();
    this.detachBackButton();
    this.book = null;
    if (this.rendition && this.rendition.off) {
      try {
        this.rendition.off("relocated", this.onRelocated);
        this.rendition.off("displayed", this.onDisplayed);
      } catch (err) {}
    }
    this.unbindContents();
    this.rendition = null;
    this.currentView = null;
    this.session = null;
  };

  ReadingHistoryManager.prototype.hasValidContext = function () {
    return !!(this.context && this.context.bookId && this.context.genre);
  };

  ReadingHistoryManager.prototype.createSession = function () {
    const now = new Date().toISOString();
    return {
      bookId: this.context.bookId,
      title: "",
      author: "",
      genre: this.context.genre,
      pagesRead: 0,
      highestPageRead: 0,
      startedAt: now,
      finishedAt: now,
      minutesRead: 0,
      sessions: 1,
      isCompleted: false,
      completionPercentage: 0,
      verifiedReadingSeconds: 0,
      certifiedLocations: [],
      finalAnchorCertified: false,
      synced: false,
      updatedAt: now
    };
  };

  ReadingHistoryManager.prototype.setMetadata = function (metadata) {
    if (!this.session) return;
    this.session.title = safeTrim(metadata.title);
    this.session.author = safeTrim(metadata.creator);
    this.updatePayloadFields();
    this.save();
  };

  ReadingHistoryManager.prototype.onActivity = function () {
    this.lastInteractionAt = Date.now();
  };

  ReadingHistoryManager.prototype.onDisplayed = function (view) {
    const contents = view && view.contents ? view.contents : view;
    this.bindContents(contents);
  };

  ReadingHistoryManager.prototype.onVisibilityChange = function () {
    if (document.visibilityState === "hidden") {
      this.checkpointCurrentView({ allowHidden: true });
      this.queueSync("hidden", { keepalive: true });
      this.save();
    } else {
      this.onActivity();
      if (this.currentView) this.currentView.startedAtMs = Date.now();
      this.sync.retry();
    }
  };

  ReadingHistoryManager.prototype.onBeforeUnload = function () {
    this.checkpointCurrentView({ allowHidden: true });
    this.queueSync("beforeunload", { keepalive: true });
    this.save();
  };

  ReadingHistoryManager.prototype.onBackToBook = function () {
    this.checkpointCurrentView({ allowHidden: true });
    this.queueSync("back", { keepalive: true });
    this.save();
  };

  ReadingHistoryManager.prototype.onRelocated = function (location) {
    if (!this.session) return;
    this.finalizeCurrentView();
    this.onActivity();
    this.startView(location);
    this.syncIfDue();
  };

  ReadingHistoryManager.prototype.startSyncTimer = function () {
    this.stopSyncTimer();
    this.syncTimer = window.setInterval(this.onPeriodicSync, SYNC_INTERVAL_MS);
  };

  ReadingHistoryManager.prototype.stopSyncTimer = function () {
    if (!this.syncTimer) return;
    window.clearInterval(this.syncTimer);
    this.syncTimer = null;
  };

  ReadingHistoryManager.prototype.onPeriodicSync = function () {
    if (!this.session || !this.isActiveReadingNow()) {
      this.sync.retry();
      return;
    }

    this.checkpointCurrentView();
    this.queueSync("interval");
  };

  ReadingHistoryManager.prototype.attachBackButton = function () {
    this.detachBackButton();
    this.backButton = document.querySelector(".app button.open");
    if (this.backButton) this.backButton.addEventListener("click", this.onBackToBook, true);
  };

  ReadingHistoryManager.prototype.detachBackButton = function () {
    if (!this.backButton) return;
    this.backButton.removeEventListener("click", this.onBackToBook, true);
    this.backButton = null;
  };

  ReadingHistoryManager.prototype.bindContents = function (contents) {
    if (!contents || !contents.document) return;
    if (this.boundContents.some(item => item.contents === contents)) return;

    ["click", "keydown", "mousemove", "touchstart"].forEach(type => {
      contents.document.addEventListener(type, this.onActivity, true);
    });

    this.boundContents.push({
      contents: contents
    });
  };

  ReadingHistoryManager.prototype.unbindContents = function () {
    this.boundContents.forEach(item => {
      try {
        ["click", "keydown", "mousemove", "touchstart"].forEach(type => {
          item.contents.document.removeEventListener(type, this.onActivity, true);
        });
      } catch (err) {}
    });
    this.boundContents = [];
  };

  ReadingHistoryManager.prototype.startView = function (location) {
    const locationId = this.locationId(location);
    if (!locationId) {
      this.currentView = null;
      return;
    }

    this.currentView = {
      id: locationId,
      location: location,
      startedAtMs: Date.now(),
      wordCount: 0,
      finalAnchor: this.isFinalAnchor(location)
    };

    this.getVisibleText(location).then(text => {
      if (!this.currentView || this.currentView.id !== locationId) return;
      this.currentView.wordCount = this.countWords(text);
    }).catch(err => {
      console.warn("reading history visible text error", err);
    });
  };

  ReadingHistoryManager.prototype.finalizeCurrentView = function () {
    if (!this.session || !this.currentView) return;

    const view = this.currentView;
    this.currentView = null;
    this.certifyView(view);
  };

  ReadingHistoryManager.prototype.checkpointCurrentView = function (options) {
    if (!this.session || !this.currentView) return false;
    const certified = this.certifyView(this.currentView, options);
    if (certified) {
      this.currentView = null;
      return true;
    }
    return false;
  };

  ReadingHistoryManager.prototype.certifyView = function (view, options) {
    if (!this.session || !view) return false;
    options = options || {};

    if (!this.isActiveReadingView(view, options)) return;
    if (!view.wordCount) return;
    if (this.isCertified(view.id)) return;

    const elapsedSeconds = Math.max(0, (Date.now() - view.startedAtMs) / 1000);
    const minSeconds = (view.wordCount / MAX_READING_WPM) * 60;
    const maxSeconds = (view.wordCount / MIN_READING_WPM) * 60;

    if (elapsedSeconds < minSeconds) return;

    this.session.certifiedLocations.push(view.id);
    this.session.verifiedReadingSeconds += Math.min(elapsedSeconds, maxSeconds);
    this.session.highestPageRead = Math.max(
      this.session.highestPageRead || 0,
      this.locationNumber(view.location)
    );
    if (view.finalAnchor) this.session.finalAnchorCertified = true;
    this.updatePayloadFields();
    this.save();
    if (this.session.isCompleted) this.queueSync("completed", { force: true });
    return true;
  };

  ReadingHistoryManager.prototype.isActiveReadingNow = function () {
    if (document.visibilityState !== "visible") return false;
    return this.lastInteractionAt === 0 || Date.now() - this.lastInteractionAt <= ACTIVE_WINDOW_MS;
  };

  ReadingHistoryManager.prototype.isActiveReadingView = function (view, options) {
    options = options || {};
    if (!options.allowHidden && document.visibilityState !== "visible") return false;
    return this.lastInteractionAt === 0 || this.lastInteractionAt >= view.startedAtMs || Date.now() - this.lastInteractionAt <= ACTIVE_WINDOW_MS;
  };

  ReadingHistoryManager.prototype.isCertified = function (locationId) {
    return this.session.certifiedLocations.indexOf(locationId) !== -1;
  };

  ReadingHistoryManager.prototype.updatePayloadFields = function () {
    const total = this.totalReadableLocations();
    const certified = this.session.certifiedLocations.length;
    const completion = total > 0 ? Math.min(100, Math.round((certified / total) * 100)) : 0;

    this.session.pagesRead = certified;
    this.session.finishedAt = new Date().toISOString();
    this.session.minutesRead = Math.round(this.session.verifiedReadingSeconds / 60);
    this.session.completionPercentage = completion;
    this.session.isCompleted = completion >= COMPLETION_THRESHOLD && !!this.session.finalAnchorCertified;
    this.session.updatedAt = new Date().toISOString();
    this.session.synced = false;
  };

  ReadingHistoryManager.prototype.totalReadableLocations = function () {
    try {
      if (this.book && this.book.locations && this.book.locations.length() > 0) {
        return this.book.locations.length();
      }
    } catch (err) {}
    return 0;
  };

  ReadingHistoryManager.prototype.locationId = function (location) {
    if (!location || !location.start) return "";
    if (typeof location.start.location === "number" && location.start.location >= 0) {
      return String(location.start.location);
    }
    return location.start.cfi || "";
  };

  ReadingHistoryManager.prototype.locationNumber = function (location) {
    if (!location) return 0;
    const end = location.end && location.end.location;
    const start = location.start && location.start.location;
    let index = typeof end === "number" && end >= 0 ? end : start;

    if (!(typeof index === "number" && index >= 0)) {
      const cfi = location.end && location.end.cfi || location.start && location.start.cfi;
      try {
        index = this.book.locations.locationFromCfi(cfi);
      } catch (err) {
        index = -1;
      }
    }

    return typeof index === "number" && index >= 0 ? Math.floor(index) + 1 : 0;
  };

  ReadingHistoryManager.prototype.highestCertifiedPage = function (certifiedLocations) {
    if (!Array.isArray(certifiedLocations)) return 0;
    return certifiedLocations.reduce((highest, locationId) => {
      if (!/^\d+$/.test(String(locationId))) return highest;
      return Math.max(highest, Number(locationId) + 1);
    }, 0);
  };

  ReadingHistoryManager.prototype.isFinalAnchor = function (location) {
    try {
      const total = this.totalReadableLocations();
      if (total > 0 && location.end && location.end.location >= total - 1) return true;
      if (location.end && location.end.percentage >= 0.99) return true;
      if (location.start && location.start.percentage >= 0.99) return true;
    } catch (err) {}
    return false;
  };

  ReadingHistoryManager.prototype.getVisibleText = function (location) {
    if (!location || !location.start || !location.end || !location.start.cfi || !location.end.cfi) {
      return Promise.resolve("");
    }

    try {
      const rangeCfi = this.app.makeRangeCfi(location.start.cfi, location.end.cfi);
      return this.book.getRange(rangeCfi).then(range => range.toString());
    } catch (err) {
      return Promise.resolve(this.fallbackVisibleText());
    }
  };

  ReadingHistoryManager.prototype.fallbackVisibleText = function () {
    try {
      const contents = this.rendition.manager.getContents()[0];
      return contents.document.body.innerText || "";
    } catch (err) {
      return "";
    }
  };

  ReadingHistoryManager.prototype.countWords = function (text) {
    if (!text) return 0;
    return text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean).length;
  };

  ReadingHistoryManager.prototype.payload = function () {
    if (!this.session) return null;
    return {
      bookId: this.session.bookId,
      title: this.session.title,
      author: this.session.author,
      genre: this.session.genre,
      pagesRead: this.session.pagesRead,
      highestPageRead: this.session.highestPageRead || 0,
      startedAt: this.session.startedAt,
      finishedAt: this.session.finishedAt,
      minutesRead: this.session.minutesRead,
      sessions: this.session.sessions,
      isCompleted: this.session.isCompleted,
      completionPercentage: this.session.completionPercentage
    };
  };

  ReadingHistoryManager.prototype.queueSync = function (reason, options) {
    if (!this.session) return;
    options = options || {};
    this.updatePayloadFields();
    if (!this.hasNewVerifiedProgress() && !options.force) {
      this.sync.retry({ keepalive: !!options.keepalive });
      return;
    }

    const payload = this.payload();
    this.lastQueuedVerifiedSeconds = this.session.verifiedReadingSeconds;
    this.session.lastQueuedVerifiedSeconds = this.lastQueuedVerifiedSeconds;
    this.storage.enqueue(this.session.bookId, payload, reason);
    this.save();
    this.sync.retry({ keepalive: !!options.keepalive });
  };

  ReadingHistoryManager.prototype.syncIfDue = function () {
    if (!this.session) return;
    const delta = this.session.verifiedReadingSeconds - this.lastSyncVerifiedSeconds;
    if (delta >= SYNC_INTERVAL_SECONDS || this.session.isCompleted) {
      this.lastSyncVerifiedSeconds = this.session.verifiedReadingSeconds;
      this.session.lastSyncedVerifiedSeconds = this.lastSyncVerifiedSeconds;
      this.queueSync("interval");
    }
  };

  ReadingHistoryManager.prototype.hasNewVerifiedProgress = function () {
    return this.session && this.session.verifiedReadingSeconds > this.lastQueuedVerifiedSeconds;
  };

  ReadingHistoryManager.prototype.save = function () {
    if (!this.session) return;
    this.storage.saveSession(this.session.bookId, this.session);
  };

  function ReadingHistoryStorage() {}

  ReadingHistoryStorage.prototype.sessionKey = function (bookId) {
    return "ePubViewer:" + bookId + ":reading-history:session";
  };

  ReadingHistoryStorage.prototype.queueKey = function (bookId) {
    return "ePubViewer:" + bookId + ":reading-history:queue";
  };

  ReadingHistoryStorage.prototype.loadSession = function (bookId) {
    try {
      const raw = localStorage.getItem(this.sessionKey(bookId));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  };

  ReadingHistoryStorage.prototype.saveSession = function (bookId, session) {
    localStorage.setItem(this.sessionKey(bookId), JSON.stringify(session));
  };

  ReadingHistoryStorage.prototype.enqueue = function (bookId, payload, reason) {
    const queue = this.loadQueue(bookId);
    queue.push({
      id: "reading-history-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      synced: false,
      payload: payload,
      reason: reason || "sync",
      queuedAt: new Date().toISOString()
    });
    localStorage.setItem(this.queueKey(bookId), JSON.stringify(queue));
  };

  ReadingHistoryStorage.prototype.loadQueue = function (bookId) {
    try {
      const raw = localStorage.getItem(this.queueKey(bookId));
      const queue = raw ? JSON.parse(raw) : [];
      return Array.isArray(queue) ? queue.map(item => {
        if (!item.id) item.id = "reading-history-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        return item;
      }) : [];
    } catch (err) {
      return [];
    }
  };

  ReadingHistoryStorage.prototype.saveQueue = function (bookId, queue) {
    localStorage.setItem(this.queueKey(bookId), JSON.stringify(queue));
  };

  function ReadingHistorySync(storage) {
    this.storage = storage;
    this.apiUrl = API_URL;
    this.inFlight = false;
  }

  ReadingHistorySync.prototype.retry = function (options) {
    options = options || {};
    if (!this.apiUrl || this.inFlight || !(window.readerContext && window.readerContext.bookId)) return;
    const bookId = window.readerContext.bookId;
    const queue = this.storage.loadQueue(bookId);
    const pending = queue.filter(item => !item.synced);
    if (pending.length === 0) return;

    this.inFlight = true;
    const item = pending[0];
    this.post(item.payload, { keepalive: !!options.keepalive }).then(() => {
      this.storage.saveQueue(bookId, queue.filter(queued => queued.id !== item.id));
    }).catch(() => {
      this.storage.saveQueue(bookId, queue);
    }).then(() => {
      this.inFlight = false;
    });
  };

  ReadingHistorySync.prototype.post = function (payload, options) {
    options = options || {};
    return fetch(this.apiUrl, {
      method: "POST",
      keepalive: !!options.keepalive,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }).then(resp => {
      if (!resp.ok) throw new Error("reading history sync failed");
      return resp;
    });
  };

  function safeTrim(value) {
    return value ? String(value).trim() : "";
  }

  window.ReadingHistoryManager = ReadingHistoryManager;
})();
