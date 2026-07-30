(function () {
  "use strict";

  const MIN_READING_WPM = 100;
  const MAX_READING_WPM = 500;
  const ACTIVE_WINDOW_MS = 120000;
  const FALLBACK_SYNC_INTERVAL_SECONDS = 300;
  const FALLBACK_SYNC_INTERVAL_MS = FALLBACK_SYNC_INTERVAL_SECONDS * 1000;
  const COMPLETION_THRESHOLD = 85;

  function ReadingHistoryManager(app) {
    this.app = app;
    this.book = null;
    this.rendition = null;
    this.context = window.readerContext || {};
    this.storage = new ReadingHistoryStorage();
    this.sync = new ReadingHistorySync(this.storage, this);
    this.session = null;
    this.currentView = null;
    this.lastInteractionAt = 0;
    this.lastSyncVerifiedSeconds = 0;
    this.lastQueuedVerifiedSeconds = 0;
    this.progressVersion = 0;
    this.lastSyncedProgressVersion = 0;
    this.lastSuccessfulPayloadHash = "";
    this.transitionQueue = Promise.resolve();
    this.visitedLocationKeys = {};
    this.rejectedLocationKeys = {};
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
    this.session.pageContent = this.formatPageContent(this.session.pageContent);
    this.session.highestPageRead = Math.max(
      Number(this.session.highestPageRead) || 0,
      this.highestCertifiedPage(this.session.certifiedLocations)
    );
    this.lastQueuedVerifiedSeconds = this.session.lastQueuedVerifiedSeconds || 0;
    this.lastSyncVerifiedSeconds = this.session.lastSyncedVerifiedSeconds || 0;
    this.progressVersion = Number(this.session.progressVersion) || 0;
    this.lastSyncedProgressVersion = Number(this.session.lastSyncedProgressVersion) || 0;
    this.lastSuccessfulPayloadHash = this.session.lastSuccessfulPayloadHash || "";
    this.save();

    rendition.on("relocated", this.onRelocated);
    rendition.on("displayed", this.onDisplayed);
    this.attachBackButton();
    this.startSyncTimer();
    this.sync.retry();
  };

  ReadingHistoryManager.prototype.detach = function () {
    if (this.session) {
      this.pauseCurrentView();
      this.sync.retry({ keepalive: true, trigger: "detach" });
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
      pageContent: "",
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
    if (document.visibilityState !== "visible") return;

    const now = Date.now();
    if (this.currentView) {
      this.updateViewActiveTime(this.currentView, now);
      this.currentView.lastActivityAtMs = now;
      this.currentView.trackingActive = true;
    }
    this.lastInteractionAt = now;
  };

  ReadingHistoryManager.prototype.onDisplayed = function (view) {
    const contents = view && view.contents ? view.contents : view;
    this.bindContents(contents);
  };

  ReadingHistoryManager.prototype.onVisibilityChange = function () {
    if (document.visibilityState === "hidden") {
      if (this.currentView) {
        this.pauseCurrentView();
      }
      this.sync.retry({ keepalive: true, trigger: "hidden" });
      this.save();
    } else {
      this.onActivity();
      this.sync.retry();
    }
  };

  ReadingHistoryManager.prototype.onBeforeUnload = function () {
    this.pauseCurrentView();
    this.sync.retry({ keepalive: true, trigger: "beforeunload" });
    this.save();
  };

  ReadingHistoryManager.prototype.onBackToBook = function () {
    this.pauseCurrentView();
    this.sync.retry({ keepalive: true, trigger: "back" });
    this.save();
  };

  ReadingHistoryManager.prototype.onRelocated = function (location) {
    if (!this.session) return;
    this.transitionQueue = this.transitionQueue.then(() => {
      if (!this.session) return null;
      return this.transitionToLocation(location);
    }).catch(err => {
      console.warn("reading history relocation error", err);
      if (this.session) this.startView(location);
    });
  };

  ReadingHistoryManager.prototype.startSyncTimer = function () {
    this.stopSyncTimer();
    this.syncTimer = window.setInterval(this.onPeriodicSync, FALLBACK_SYNC_INTERVAL_MS);
  };

  ReadingHistoryManager.prototype.stopSyncTimer = function () {
    if (!this.syncTimer) return;
    window.clearInterval(this.syncTimer);
    this.syncTimer = null;
  };

  ReadingHistoryManager.prototype.onPeriodicSync = function () {
    if (!this.session || !this.isActiveReadingNow()) {
      this.sync.retry({ trigger: "fallback-interval" });
      return;
    }

    this.logSyncSkipped("no progress change");
    this.sync.retry({ trigger: "fallback-interval" });
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

    const now = Date.now();
    const pageNumber = this.locationNumber(location);
    const wasVisited = !!this.visitedLocationKeys[locationId];
    const previousRejection = this.rejectedLocationKeys[locationId] || null;
    const alreadyCertified = this.isCertified(locationId);
    const view = {
      id: locationId,
      location: location,
      startedAtMs: now,
      activeReadingMs: 0,
      lastAccountedAtMs: now,
      lastActivityAtMs: this.lastInteractionAt || now,
      trackingActive: document.visibilityState === "visible",
      wordCount: 0,
      pageContent: "",
      minimumAllowedReadingSeconds: 0,
      maximumAllowedReadingSeconds: 0,
      wasVisited: wasVisited,
      previousRejection: previousRejection,
      alreadyCertifiedOnEntry: alreadyCertified,
      finalAnchor: this.isFinalAnchor(location)
    };
    this.visitedLocationKeys[locationId] = true;
    this.currentView = view;

    view.textReady = this.getVisibleText(location).then(text => {
      view.wordCount = this.countWords(text);
      view.pageContent = this.formatPageContent(text);
      view.minimumAllowedReadingSeconds = this.minimumAllowedSeconds(view.wordCount);
      view.maximumAllowedReadingSeconds = this.maximumAllowedSeconds(view.wordCount);
      this.logReadingHistory("PAGE_ENTERED", {
        timestamp: new Date().toISOString(),
        locationKey: locationId,
        pageNumber: pageNumber,
        cfi: location.start && location.start.cfi,
        navigationDirection: this.navigationDirection(pageNumber),
        wasVisited: wasVisited,
        previouslyFailed: !!previousRejection,
        previousRejectionReason: previousRejection && previousRejection.reason || "",
        alreadyCertified: alreadyCertified,
        newTimerStarted: true,
        highestPageRead: this.session && this.session.highestPageRead || 0,
        pagesRead: this.session && this.session.pagesRead || 0,
        wordCount: view.wordCount,
        minimumAllowedSeconds: roundDebugSeconds(view.minimumAllowedReadingSeconds),
        maximumAllowedSeconds: roundDebugSeconds(view.maximumAllowedReadingSeconds),
        pageContent: view.pageContent
      });
    }).catch(err => {
      console.warn("reading history visible text error", err);
    });
  };

  ReadingHistoryManager.prototype.transitionToLocation = function (location) {
    const previousView = this.currentView;
    const nextLocationKey = this.locationId(location);
    this.currentView = null;

    return this.finalizeView(previousView, nextLocationKey).then(result => {
      this.onActivity();
      this.startView(location);
      if (result && result.certified) {
        this.queueSync("qualifying-page-turn", {
          trigger: "qualifying-page-turn",
          pageWasNewlyCertified: true
        });
      } else if (previousView && result && result.reason) {
        this.logSyncDecision({
          pageWasNewlyCertified: false,
          finalSyncDecision: false,
          skipReason: "page failed validation"
        });
        this.logSyncSkipped("page failed validation");
      }
    });
  };

  ReadingHistoryManager.prototype.finalizeView = function (view, nextLocationKey) {
    if (!this.session || !view) return Promise.resolve({ certified: false, reason: "no previous page" });

    return Promise.resolve(view.textReady).then(() => {
      this.updateViewActiveTime(view, Date.now());
      view.trackingActive = false;
      this.logReadingHistory("PAGE_FINALIZING", {
        previousLocationKey: view.id,
        pageNumber: this.locationNumber(view.location),
        nextLocationKey: nextLocationKey || "",
        activeDwellSeconds: roundDebugSeconds(Math.max(0, view.activeReadingMs / 1000)),
        wallClockDwellSeconds: roundDebugSeconds(Math.max(0, (Date.now() - view.startedAtMs) / 1000)),
        minimumAllowedSeconds: roundDebugSeconds(this.minimumAllowedSeconds(view.wordCount)),
        maximumAllowedSeconds: roundDebugSeconds(this.maximumAllowedSeconds(view.wordCount)),
        previousRejectionStatus: view.previousRejection || this.rejectedLocationKeys[view.id] || null,
        certifiedStatusBeforeEvaluation: this.isCertified(view.id),
        visibilityState: document.visibilityState,
        readerActivityState: this.isActiveReadingNow() ? "active" : "inactive"
      });
      return this.certifyView(view);
    });
  };

  ReadingHistoryManager.prototype.certifyView = function (view, options) {
    if (!this.session || !view) return { certified: false, reason: "missing session or page" };
    options = options || {};

    this.updateViewActiveTime(view, Date.now());
    if (!view.wordCount) return this.rejectView(view, "missing visible text");
    if (this.isCertified(view.id)) return this.rejectView(view, "duplicate page/location");

    const activeReadingSeconds = Math.max(0, view.activeReadingMs / 1000);
    const minimumAllowedReadingSeconds = this.minimumAllowedSeconds(view.wordCount);
    const maximumAllowedReadingSeconds = this.maximumAllowedSeconds(view.wordCount);

    if (activeReadingSeconds < minimumAllowedReadingSeconds) {
      return this.rejectView(view, "below minimum reading time");
    }

    const pageLocationNumber = this.locationNumber(view.location) || view.id;
    const secondsAddedToVerifiedReading = Math.min(
      activeReadingSeconds,
      maximumAllowedReadingSeconds
    );
    const pagesReadBefore = this.session.pagesRead || 0;
    const highestPageReadBefore = this.session.highestPageRead || 0;
    const verifiedReadingSecondsBefore = this.session.verifiedReadingSeconds || 0;
    const completionPercentageBefore = this.session.completionPercentage || 0;
    const progressVersionBefore = this.progressVersion;
    const wasRevisitedAfterFailure = !!(view.previousRejection || this.rejectedLocationKeys[view.id]);

    this.session.certifiedLocations.push(view.id);
    this.session.verifiedReadingSeconds += secondsAddedToVerifiedReading;
    this.session.pageContent = view.pageContent;
    this.session.highestPageRead = Math.max(
      this.session.highestPageRead || 0,
      this.locationNumber(view.location)
    );

    if (view.finalAnchor) this.session.finalAnchorCertified = true;
    this.bumpProgressVersion();
    this.updatePayloadFields();
    this.save();
    delete this.rejectedLocationKeys[view.id];
    this.logReadingHistory("PAGE_CERTIFIED", {
      locationKey: view.id,
      pageLocationNumber: pageLocationNumber,
      pageContent: view.pageContent,
      wordCount: view.wordCount,
      dwellSeconds: roundDebugSeconds(activeReadingSeconds),
      minimumAllowedSeconds: roundDebugSeconds(minimumAllowedReadingSeconds),
      maximumAllowedSeconds: roundDebugSeconds(maximumAllowedReadingSeconds),
      secondsAdded: roundDebugSeconds(secondsAddedToVerifiedReading),
      verifiedReadingSeconds: roundDebugSeconds(this.session.verifiedReadingSeconds),
      minutesRead: this.session.minutesRead,
      pagesRead: this.session.pagesRead,
      highestPageRead: this.session.highestPageRead,
      completionPercentage: this.session.completionPercentage,
      progressVersion: this.progressVersion
    });
    if (wasRevisitedAfterFailure) {
      this.logReadingHistory("REVISITED_PAGE_CERTIFIED", {
        locationKey: view.id,
        pageNumber: pageLocationNumber,
        secondsAdded: roundDebugSeconds(secondsAddedToVerifiedReading),
        pagesReadBefore: pagesReadBefore,
        pagesReadAfter: this.session.pagesRead,
        highestPageReadBefore: highestPageReadBefore,
        highestPageReadAfter: this.session.highestPageRead,
        verifiedReadingSecondsBefore: roundDebugSeconds(verifiedReadingSecondsBefore),
        verifiedReadingSecondsAfter: roundDebugSeconds(this.session.verifiedReadingSeconds),
        completionPercentageBefore: completionPercentageBefore,
        completionPercentageAfter: this.session.completionPercentage,
        progressVersionBefore: progressVersionBefore,
        progressVersionAfter: this.progressVersion
      });
    }
    this.logReadingHistory("SESSION_SAVED", {
      timestamp: new Date().toISOString(),
      progressVersion: this.progressVersion,
      pagesRead: this.session.pagesRead,
      minutesRead: this.session.minutesRead,
      verifiedReadingSeconds: roundDebugSeconds(this.session.verifiedReadingSeconds),
      highestPageRead: this.session.highestPageRead,
      completionPercentage: this.session.completionPercentage,
      isCompleted: this.session.isCompleted
    });
    return { certified: true, reason: "certified" };
  };

  ReadingHistoryManager.prototype.rejectView = function (view, reason) {
    const wordCount = view && view.wordCount || 0;
    const dwellSeconds = view ? Math.max(0, view.activeReadingMs / 1000) : 0;
    if (view && view.id && reason !== "duplicate page/location") {
      this.rejectedLocationKeys[view.id] = {
        reason: reason,
        rejectedAt: new Date().toISOString()
      };
    }
    this.logReadingHistory("PAGE_REJECTED", {
      locationKey: view && view.id || "",
      pageNumber: view ? this.locationNumber(view.location) : 0,
      dwellSeconds: roundDebugSeconds(dwellSeconds),
      minimumAllowedSeconds: roundDebugSeconds(this.minimumAllowedSeconds(wordCount)),
      maximumAllowedSeconds: roundDebugSeconds(this.maximumAllowedSeconds(wordCount)),
      rejectionReason: reason
    });
    return { certified: false, reason: reason };
  };

  ReadingHistoryManager.prototype.pauseCurrentView = function () {
    if (!this.currentView) return;
    this.updateViewActiveTime(this.currentView, Date.now());
    this.currentView.trackingActive = false;
  };

  ReadingHistoryManager.prototype.isActiveReadingNow = function () {
    if (document.visibilityState !== "visible") return false;
    return this.lastInteractionAt > 0 && Date.now() - this.lastInteractionAt <= ACTIVE_WINDOW_MS;
  };

  ReadingHistoryManager.prototype.updateViewActiveTime = function (view, now) {
    if (!view) return;
    now = now || Date.now();

    const lastAccountedAtMs = view.lastAccountedAtMs || view.startedAtMs || now;
    if (view.trackingActive && view.lastActivityAtMs) {
      const activeUntilMs = Math.min(now, view.lastActivityAtMs + ACTIVE_WINDOW_MS);
      if (activeUntilMs > lastAccountedAtMs) {
        view.activeReadingMs = (view.activeReadingMs || 0) + activeUntilMs - lastAccountedAtMs;
      }
    }
    view.lastAccountedAtMs = now;
  };

  ReadingHistoryManager.prototype.minimumAllowedSeconds = function (wordCount) {
    return wordCount > 0 ? (wordCount / MAX_READING_WPM) * 60 : 0;
  };

  ReadingHistoryManager.prototype.maximumAllowedSeconds = function (wordCount) {
    return wordCount > 0 ? (wordCount / MIN_READING_WPM) * 60 : 0;
  };

  ReadingHistoryManager.prototype.isCertified = function (locationId) {
    return this.session.certifiedLocations.indexOf(locationId) !== -1;
  };

  ReadingHistoryManager.prototype.bumpProgressVersion = function () {
    this.progressVersion += 1;
    this.session.progressVersion = this.progressVersion;
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
    this.session.progressVersion = this.progressVersion;
    this.session.lastSyncedProgressVersion = this.lastSyncedProgressVersion;
    this.session.lastSuccessfulPayloadHash = this.lastSuccessfulPayloadHash;
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
    const startCfi = location.start && location.start.cfi || "";
    const endCfi = location.end && location.end.cfi || "";
    if (startCfi && endCfi) {
      return "cfi:" + startCfi + "|" + endCfi;
    }
    if (startCfi) {
      return "cfi:" + startCfi;
    }
    const locationNumber = typeof location.start.location === "number" && location.start.location >= 0
      ? location.start.location
      : -1;
    if (locationNumber >= 0) {
      return "loc:" + locationNumber;
    }
    return "";
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

  ReadingHistoryManager.prototype.navigationDirection = function (pageNumber) {
    const highestPageRead = this.session && this.session.highestPageRead || 0;
    if (!pageNumber || !highestPageRead) return "unknown";
    if (pageNumber > highestPageRead) return "forward-or-new";
    if (pageNumber < highestPageRead) return "backward-or-return";
    return "same-highest";
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

  ReadingHistoryManager.prototype.formatPageContent = function (text) {
    if (!text) return "";
    return text.trim().replace(/\s+/g, " ").slice(0, 20);
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
    const payload = this.payload();
    const payloadHash = stablePayloadHash(payload);
    const progressChanged = this.hasUnsyncedProgress(payloadHash);
    if (!payload || !payload.bookId) {
      this.logSyncDecision({
        pageWasNewlyCertified: !!options.pageWasNewlyCertified,
        progressChanged: false,
        payloadHashChanged: false,
        finalSyncDecision: false,
        skipReason: "invalid payload"
      });
      this.logSyncSkipped("invalid payload");
      return;
    }
    if (!progressChanged && !options.force) {
      this.logSyncDecision({
        pageWasNewlyCertified: !!options.pageWasNewlyCertified,
        progressChanged: false,
        payloadHashChanged: payloadHash !== this.lastSuccessfulPayloadHash,
        finalSyncDecision: false,
        skipReason: "no progress change"
      });
      this.logSyncSkipped("no progress change");
      this.sync.retry({ keepalive: !!options.keepalive, trigger: options.trigger || reason });
      return;
    }

    this.lastQueuedVerifiedSeconds = this.session.verifiedReadingSeconds;
    this.session.lastQueuedVerifiedSeconds = this.lastQueuedVerifiedSeconds;
    this.storage.enqueueLatest(
      this.session.bookId,
      payload,
      reason,
      this.session.pageContent,
      this.progressVersion,
      payloadHash
    );
    this.save();
    this.logSyncDecision({
      pageWasNewlyCertified: !!options.pageWasNewlyCertified,
      progressChanged: progressChanged || !!options.force,
      payloadHashChanged: payloadHash !== this.lastSuccessfulPayloadHash,
      finalSyncDecision: true,
      skipReason: ""
    });
    this.sync.retry({ keepalive: !!options.keepalive, trigger: options.trigger || reason });
  };

  ReadingHistoryManager.prototype.hasUnsyncedProgress = function (payloadHash) {
    return !!(this.session && (
      this.progressVersion > this.lastSyncedProgressVersion ||
      payloadHash !== this.lastSuccessfulPayloadHash
    ));
  };

  ReadingHistoryManager.prototype.markSyncSucceeded = function (progressVersion, payloadHash) {
    if (!this.session) return;
    this.lastSyncedProgressVersion = Math.max(this.lastSyncedProgressVersion, Number(progressVersion) || 0);
    this.lastSuccessfulPayloadHash = payloadHash || this.lastSuccessfulPayloadHash;
    this.session.lastSyncedProgressVersion = this.lastSyncedProgressVersion;
    this.session.lastSuccessfulPayloadHash = this.lastSuccessfulPayloadHash;
    this.session.synced = this.progressVersion <= this.lastSyncedProgressVersion;
    this.save();
  };

  ReadingHistoryManager.prototype.logSyncSkipped = function (reason) {
    this.logReadingHistory("SYNC_SKIPPED", { reason: reason });
  };

  ReadingHistoryManager.prototype.logSyncDecision = function (detail) {
    detail = detail || {};
    const payload = this.payload();
    const payloadHash = stablePayloadHash(payload);
    this.logReadingHistory("SYNC_DECISION", {
      pageWasNewlyCertified: !!detail.pageWasNewlyCertified,
      progressChanged: !!detail.progressChanged,
      progressVersion: this.progressVersion,
      lastSyncedProgressVersion: this.lastSyncedProgressVersion,
      payloadHashChanged: typeof detail.payloadHashChanged === "boolean"
        ? detail.payloadHashChanged
        : payloadHash !== this.lastSuccessfulPayloadHash,
      requestCurrentlyInProgress: !!(this.sync && this.sync.inFlight),
      finalSyncDecision: !!detail.finalSyncDecision,
      skipReason: detail.skipReason || ""
    });
  };

  ReadingHistoryManager.prototype.logReadingHistory = function (eventName, detail) {
    console.debug("READING_HISTORY", Object.assign({ event: eventName }, detail || {}));
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

  ReadingHistoryStorage.prototype.enqueue = function (bookId, payload, reason, pageContent) {
    this.enqueueLatest(bookId, payload, reason, pageContent, 0, stablePayloadHash(payload));
  };

  ReadingHistoryStorage.prototype.enqueueLatest = function (
    bookId,
    payload,
    reason,
    pageContent,
    progressVersion,
    payloadHash
  ) {
    const queue = this.loadQueue(bookId);
    const latest = {
      id: "reading-history-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      synced: false,
      payload: payload,
      pageContent: pageContent || "",
      reason: reason || "sync",
      progressVersion: Number(progressVersion) || 0,
      payloadHash: payloadHash || stablePayloadHash(payload),
      queuedAt: new Date().toISOString()
    };
    const synced = queue.filter(item => item.synced);
    synced.push(latest);
    localStorage.setItem(this.queueKey(bookId), JSON.stringify(synced));
  };

  ReadingHistoryStorage.prototype.loadQueue = function (bookId) {
    try {
      const raw = localStorage.getItem(this.queueKey(bookId));
      const queue = raw ? JSON.parse(raw) : [];
      return Array.isArray(queue) ? queue.map(item => {
        if (!item.id) item.id = "reading-history-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        if (typeof item.pageContent !== "string") item.pageContent = "";
        if (typeof item.progressVersion !== "number") item.progressVersion = 0;
        if (typeof item.payloadHash !== "string") item.payloadHash = stablePayloadHash(item.payload);
        return item;
      }) : [];
    } catch (err) {
      return [];
    }
  };

  ReadingHistoryStorage.prototype.saveQueue = function (bookId, queue) {
    localStorage.setItem(this.queueKey(bookId), JSON.stringify(queue));
  };

  function ReadingHistorySync(storage, manager) {
    this.storage = storage;
    this.manager = manager;
    this.inFlight = false;
    this.retryRequested = false;
    this.retry = this.retry.bind(this);
    window.addEventListener("reader-authenticated", this.retry, false);
  }

  ReadingHistorySync.prototype.retry = function (options) {
    options = options || {};
    const trigger = options.trigger || "retry";
    if (this.inFlight) {
      this.retryRequested = true;
      this.logDecision(false, "request already in progress");
      this.log("SYNC_SKIPPED", { reason: "request already in progress" });
      return;
    }
    if (!(window.readerContext && window.readerContext.bookId)) {
      this.logDecision(false, "invalid payload");
      this.log("SYNC_SKIPPED", { reason: "invalid payload" });
      return;
    }
    if (!window.readerFetch || !window.readerAuth || !window.readerAuth.isAuthenticated()) {
      this.logDecision(false, "missing authentication");
      this.log("SYNC_SKIPPED", { reason: "missing authentication" });
      return;
    }
    if (window.readerAuth && window.readerAuth.isSessionExpired()) {
      this.logDecision(false, "missing authentication");
      this.log("SYNC_SKIPPED", { reason: "missing authentication" });
      return;
    }
    const bookId = window.readerContext.bookId;
    const queue = this.storage.loadQueue(bookId);
    const pending = queue.filter(item => !item.synced);
    if (pending.length === 0) {
      this.logDecision(false, "no progress change");
      this.log("SYNC_SKIPPED", { reason: "no progress change" });
      return;
    }

    this.inFlight = true;
    const item = pending[pending.length - 1];
    this.storage.saveQueue(bookId, queue.filter(queued => queued.synced || queued.id === item.id));
    this.log("SYNC_STARTED", {
      trigger: trigger,
      progressVersion: item.progressVersion,
      payloadSummary: payloadSummary(item.payload)
    });
    this.post(item.payload, { keepalive: !!options.keepalive }).then(response => {
      this.log("SYNC_SUCCEEDED", {
        synchronizedProgressVersion: item.progressVersion,
        responseStatus: response && response.status || 200
      });
      this.storage.saveQueue(bookId, this.storage.loadQueue(bookId).filter(queued => queued.id !== item.id));
      if (this.manager) this.manager.markSyncSucceeded(item.progressVersion, item.payloadHash);
    }).catch(err => {
      const latestQueue = this.storage.loadQueue(bookId);
      const hasPendingItem = latestQueue.some(queued => !queued.synced);
      if (!hasPendingItem) latestQueue.push(item);
      this.storage.saveQueue(bookId, latestQueue);
      this.log("SYNC_FAILED", {
        progressVersion: item.progressVersion,
        error: err && err.message || String(err),
        payloadRemainsQueued: true
      });
    }).then(() => {
      this.inFlight = false;
      if (this.retryRequested) {
        this.retryRequested = false;
        this.retry(options);
      }
    });
  };

  ReadingHistorySync.prototype.log = function (eventName, detail) {
    if (this.manager && this.manager.logReadingHistory) {
      this.manager.logReadingHistory(eventName, detail);
    } else {
      console.debug("READING_HISTORY", Object.assign({ event: eventName }, detail || {}));
    }
  };

  ReadingHistorySync.prototype.logDecision = function (finalSyncDecision, skipReason) {
    if (!this.manager || !this.manager.logSyncDecision) return;
    this.manager.logSyncDecision({
      pageWasNewlyCertified: false,
      progressChanged: false,
      finalSyncDecision: finalSyncDecision,
      skipReason: skipReason || ""
    });
  };

  ReadingHistorySync.prototype.post = function (payload, options) {
    return saveReadingSession(payload, options);
  };

  function saveReadingSession(payload, options) {
    options = options || {};

    if (!window.readerFetch || !window.readerAuth) {
      return Promise.reject(new Error("Reader authentication is not available."));
    }
    if (window.readerAuth.isSessionExpired()) {
      return Promise.reject(new Error("Reading analytics stopped because the session expired."));
    }

    function send() {
      return window.readerFetch("/api/user/reading/sessions", {
        method: "POST",
        keepalive: !!options.keepalive,
        body: JSON.stringify(payload)
      }).then(response => response.text().then(text => {
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (err) {
            throw new Error("The reading session endpoint returned invalid JSON.");
          }
        }
        if (!response.ok) {
          throw new Error(data && data.message || "Unable to save the reading session.");
        }
        return {
          status: response.status,
          data: data
        };
      }));
    }

    const request = window.readerAuth.isAuthenticated()
      ? send()
      : window.readerAuth.whenVerified().then(send);

    return request.catch(err => {
      console.error("Reading session save failed:", err.message || err);
      throw err;
    });
  }

  function safeTrim(value) {
    return value ? String(value).trim() : "";
  }

  function roundDebugSeconds(value) {
    return Math.round(value * 100) / 100;
  }

  function stablePayloadHash(payload) {
    if (!payload) return "";
    try {
      return JSON.stringify(Object.keys(payload).sort().reduce((copy, key) => {
        copy[key] = payload[key];
        return copy;
      }, {}));
    } catch (err) {
      return "";
    }
  }

  function payloadSummary(payload) {
    if (!payload) return {};
    return {
      bookId: payload.bookId,
      pagesRead: payload.pagesRead,
      highestPageRead: payload.highestPageRead,
      minutesRead: payload.minutesRead,
      isCompleted: payload.isCompleted,
      completionPercentage: payload.completionPercentage
    };
  }

  window.ReadingHistoryManager = ReadingHistoryManager;
})();
