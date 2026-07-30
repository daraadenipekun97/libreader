(function () {
  "use strict";

  const COLOR_HEX_BY_NAME = {
    yellow: "#F8E71C",
    green: "#8BC34A",
    blue: "#74B9FF",
    pink: "#FF8FBD",
    purple: "#B59CFF"
  };
  const COLOR_NAMES = Object.keys(COLOR_HEX_BY_NAME);
  const MIN_SELECTION_WORDS = 3;

  function HighlightManager(app) {
    this.app = app;
    this.book = null;
    this.rendition = null;
    this.highlights = [];
    this.pendingSelection = null;
    this.boundContents = [];
    this.renderedAnnotations = {};
    this.createInProgress = false;
    this.loading = false;
    this.loadingBookId = "";
    this.loadedBookId = "";
    this.loadPromise = null;
    this.statusMessage = "";
    this.statusIsError = false;
    this.updateInProgress = {};
    this.deleteInProgress = {};
    this.selectedHandler = this.onSelected.bind(this);
    this.displayedHandler = this.onDisplayed.bind(this);
    this.reapplyHandler = this.reapplyAnnotations.bind(this);
    this.authenticatedHandler = this.onAuthenticated.bind(this);
    this.restoreTimer = null;
    this.toolbar = app.qs(".highlight-toolbar");
    this.list = app.qs(".highlights-list");

    this.toolbar.addEventListener("mousedown", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.toolbar.addEventListener("touchstart", event => {
      event.stopPropagation();
    });
    this.toolbar.addEventListener("click", this.onToolbarClick.bind(this));
    document.body.addEventListener("click", this.onBodyClick.bind(this));
    window.addEventListener("reader-authenticated", this.authenticatedHandler, false);
    this.renderList();
  }

  HighlightManager.prototype.attach = function (book, rendition) {
    this.detach();
    this.book = book;
    this.rendition = rendition;
    this.highlights = [];
    this.renderedAnnotations = {};
    this.statusMessage = "";
    this.statusIsError = false;
    this.renderList();

    rendition.on("selected", this.selectedHandler);
    rendition.on("relocated", this.reapplyHandler);
    rendition.on("displayed", this.displayedHandler);
    this.loadHighlights();
  };

  HighlightManager.prototype.detach = function () {
    this.hideToolbar();
    this.pendingSelection = null;
    if (this.rendition && this.rendition.off) {
      try {
        this.rendition.off("selected", this.selectedHandler);
        this.rendition.off("relocated", this.reapplyHandler);
        this.rendition.off("displayed", this.displayedHandler);
      } catch (err) {}
    }
    this.unbindContents();
    if (this.restoreTimer) {
      window.clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.book = null;
    this.rendition = null;
    this.highlights = [];
    this.renderedAnnotations = {};
    this.createInProgress = false;
    this.loading = false;
    this.loadingBookId = "";
    this.loadedBookId = "";
    this.loadPromise = null;
    this.statusMessage = "";
    this.statusIsError = false;
    this.updateInProgress = {};
    this.deleteInProgress = {};
    this.renderList();
  };

  HighlightManager.prototype.bookId = function () {
    return window.readerContext && window.readerContext.bookId
      ? String(window.readerContext.bookId)
      : "";
  };

  HighlightManager.prototype.onAuthenticated = function () {
    if (this.book && this.rendition && this.loadedBookId !== this.bookId()) {
      this.loadHighlights();
    }
  };

  HighlightManager.prototype.loadHighlights = function () {
    const bookId = this.bookId();
    if (!this.book || !this.rendition || !bookId) {
      this.setStatus("Highlights need a valid book ID.", true);
      return Promise.resolve();
    }
    if (this.loadPromise && this.loadingBookId === bookId) {
      return this.loadPromise;
    }
    if (this.loadedBookId === bookId) {
      return Promise.resolve(this.highlights);
    }

    this.loading = true;
    this.loadingBookId = bookId;
    this.setStatus("Loading highlights...", false);
    this.log("HIGHLIGHTS_FETCH_STARTED", { bookId: bookId });

    this.loadPromise = this.whenAuthenticated()
      .then(() => fetchBookHighlights(bookId))
      .then(highlights => {
        if (!this.book || this.bookId() !== bookId) return;
        this.highlights = uniqueHighlights(highlights);
        this.loading = false;
        this.loadedBookId = bookId;
        this.statusMessage = "";
        this.statusIsError = false;
        this.renderList();
        this.restoreAnnotations();
        this.log("HIGHLIGHTS_FETCH_SUCCEEDED", {
          bookId: bookId,
          count: this.highlights.length
        });
      })
      .catch(err => {
        this.loading = false;
        this.setStatus(this.userErrorMessage(err, "Unable to load highlights."), true);
        this.log("HIGHLIGHTS_FETCH_FAILED", {
          bookId: bookId,
          status: err.status || 0,
          error: err.message || String(err)
        });
      })
      .then(() => {
        if (this.loadingBookId === bookId) {
          this.loadingBookId = "";
          this.loadPromise = null;
        }
      });

    return this.loadPromise;
  };

  HighlightManager.prototype.whenAuthenticated = function () {
    if (!window.readerAuth || !window.readerAuth.whenVerified) {
      return Promise.reject(new Error("Reader authentication is not available."));
    }
    return window.readerAuth.whenVerified();
  };

  HighlightManager.prototype.onSelected = function (cfiRange, contents) {
    const text = this.getSelectedText(contents);
    if (this.wordCount(text) < MIN_SELECTION_WORDS) {
      this.hideToolbar();
      return;
    }
    if (!this.bookId()) {
      this.setStatus("Highlights are unavailable for this book.", true);
      this.hideToolbar();
      return;
    }
    if (!isValidCfiRange(cfiRange)) {
      this.setStatus("This selection cannot be highlighted.", true);
      this.hideToolbar();
      return;
    }

    this.pendingSelection = {
      cfiRange: cfiRange,
      contents: contents,
      text: text
    };
    this.bindContents(contents);
    this.showToolbar(contents);
  };

  HighlightManager.prototype.checkSelectionCleared = function (contents) {
    if (this.toolbar.classList.contains("hidden")) return;
    if (!this.pendingSelection || this.pendingSelection.contents !== contents) return;
    if (this.wordCount(this.getSelectedText(contents)) >= MIN_SELECTION_WORDS) return;
    this.hideToolbar();
  };

  HighlightManager.prototype.getSelectedText = function (contents) {
    try {
      return contents.window.getSelection().toString().trim().replace(/\s+/g, " ");
    } catch (err) {
      return "";
    }
  };

  HighlightManager.prototype.wordCount = function (text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
  };

  HighlightManager.prototype.showToolbar = function (contents) {
    const pos = this.getToolbarPosition(contents);
    this.toolbar.style.left = pos.left + "px";
    this.toolbar.style.top = pos.top + "px";
    this.setToolbarDisabled(false);
    this.toolbar.classList.remove("hidden");
  };

  HighlightManager.prototype.getToolbarPosition = function (contents) {
    const fallback = {
      left: Math.max(12, Math.round((window.innerWidth - 220) / 2)),
      top: Math.max(12, window.innerHeight - 104)
    };

    try {
      const selection = contents.window.getSelection();
      if (!selection || selection.rangeCount === 0) return fallback;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const iframe = contents.document.defaultView.frameElement;
      const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
      const left = iframeRect.left + rect.left + (rect.width / 2) - 110;
      const top = iframeRect.top + rect.top - 52;
      return {
        left: Math.max(12, Math.min(window.innerWidth - 232, Math.round(left))),
        top: Math.max(12, Math.round(top))
      };
    } catch (err) {
      return fallback;
    }
  };

  HighlightManager.prototype.hideToolbar = function () {
    this.toolbar.classList.add("hidden");
    this.setToolbarDisabled(false);
    this.pendingSelection = null;
  };

  HighlightManager.prototype.setToolbarDisabled = function (disabled) {
    Array.from(this.toolbar.querySelectorAll("[data-highlight-color]")).forEach(button => {
      button.disabled = !!disabled;
    });
  };

  HighlightManager.prototype.onToolbarClick = function (event) {
    const button = event.target.closest("[data-highlight-color]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    this.createHighlight(button.dataset.highlightColor);
  };

  HighlightManager.prototype.onBodyClick = function (event) {
    if (this.toolbar.classList.contains("hidden")) return;
    if (this.toolbar.contains(event.target)) return;
    this.hideToolbar();
  };

  HighlightManager.prototype.onDisplayed = function (view) {
    const contents = view && view.contents ? view.contents : view;
    if (contents) this.bindContents(contents);
    this.reapplyAnnotations();
  };

  HighlightManager.prototype.bindContents = function (contents) {
    if (!contents || !contents.document || !contents.window) return;
    if (this.boundContents.some(item => item.contents === contents)) return;

    const check = this.checkSelectionCleared.bind(this, contents);
    const delayedCheck = () => window.setTimeout(check, 0);

    contents.document.addEventListener("selectionchange", delayedCheck, false);
    contents.document.addEventListener("mousedown", delayedCheck, false);
    contents.document.addEventListener("touchstart", delayedCheck, false);
    contents.document.addEventListener("keyup", delayedCheck, false);

    this.boundContents.push({
      contents: contents,
      check: delayedCheck
    });
  };

  HighlightManager.prototype.unbindContents = function () {
    this.boundContents.forEach(item => {
      try {
        item.contents.document.removeEventListener("selectionchange", item.check, false);
        item.contents.document.removeEventListener("mousedown", item.check, false);
        item.contents.document.removeEventListener("touchstart", item.check, false);
        item.contents.document.removeEventListener("keyup", item.check, false);
      } catch (err) {}
    });
    this.boundContents = [];
  };

  HighlightManager.prototype.createHighlight = function (colorName) {
    if (this.createInProgress || !this.pendingSelection || !this.book || !this.rendition) return;

    const color = normalizeColor(COLOR_HEX_BY_NAME[colorName]);
    if (!color) {
      this.setStatus("Choose a valid highlight colour.", true);
      return;
    }

    const selection = this.pendingSelection;
    const payload = {
      bookId: this.bookId(),
      text: selection.text,
      cfiRange: selection.cfiRange,
      color: color
    };

    if (!isValidHighlightPayload(payload)) {
      this.setStatus("This selection cannot be highlighted.", true);
      return;
    }

    this.createInProgress = true;
    this.setToolbarDisabled(true);
    this.log("HIGHLIGHT_CREATE_STARTED", {
      bookId: payload.bookId,
      cfiRange: payload.cfiRange
    });

    return this.whenAuthenticated()
      .then(() => createHighlight(payload))
      .then(record => {
        if (!this.book || this.bookId() !== String(record.bookId)) return;
        this.upsertHighlight(record);
        this.applyAnnotation(record, true);
        this.renderList();
        this.clearSelection(selection.contents);
        this.hideToolbar();
        this.setStatus("", false);
        this.log("HIGHLIGHT_CREATE_SUCCEEDED", {
          highlightId: record.id,
          bookId: record.bookId,
          cfiRange: record.cfiRange,
          status: 201
        });
      })
      .catch(err => {
        this.setToolbarDisabled(false);
        this.setStatus(this.userErrorMessage(err, "Unable to create highlight."), true);
        this.log("HIGHLIGHT_CREATE_FAILED", {
          bookId: payload.bookId,
          cfiRange: payload.cfiRange,
          status: err.status || 0,
          error: err.message || String(err)
        });
      })
      .then(() => {
        this.createInProgress = false;
      });
  };

  HighlightManager.prototype.clearSelection = function (contents) {
    try {
      contents.window.getSelection().removeAllRanges();
    } catch (err) {}
  };

  HighlightManager.prototype.restoreAnnotations = function () {
    this.highlights.forEach(record => {
      if (this.applyAnnotation(record, false)) {
        this.log("HIGHLIGHT_RESTORE_SUCCEEDED", {
          highlightId: record.id,
          bookId: record.bookId,
          cfiRange: record.cfiRange
        });
      }
    });
    this.deferColorSync();
  };

  HighlightManager.prototype.reapplyAnnotations = function () {
    if (this.restoreTimer) window.clearTimeout(this.restoreTimer);
    this.restoreTimer = window.setTimeout(() => {
      this.restoreTimer = null;
      this.restoreAnnotations();
    }, 0);
  };

  HighlightManager.prototype.applyAnnotation = function (record, force) {
    if (!this.rendition || !this.rendition.annotations || !record || !record.cfiRange) return false;
    const key = this.annotationKey(record);
    try {
      if (!force && (this.renderedAnnotations[key] || this.hasAnnotation(record.cfiRange))) {
        this.renderedAnnotations[key] = true;
        this.deferColorSync();
        return true;
      }
      if (force) this.removeRenderedHighlight(record);
      this.rendition.annotations.highlight(record.cfiRange, {
        id: record.id,
        color: record.color
      });
      this.renderedAnnotations[key] = true;
      this.deferColorSync();
      return true;
    } catch (err) {
      this.log("HIGHLIGHT_RESTORE_FAILED", {
        highlightId: record.id,
        bookId: record.bookId,
        cfiRange: record.cfiRange,
        error: err && err.message || String(err)
      }, "warn");
      return false;
    }
  };

  HighlightManager.prototype.removeRenderedHighlight = function (record) {
    if (!record || !record.cfiRange) return;
    try {
      if (this.rendition && this.rendition.annotations) {
        this.rendition.annotations.remove(record.cfiRange, "highlight");
      }
    } catch (err) {
      console.warn("error removing highlight annotation", {
        highlightId: record.id,
        bookId: record.bookId,
        cfiRange: record.cfiRange,
        error: err && err.message || String(err)
      });
    }
    delete this.renderedAnnotations[this.annotationKey(record)];
  };

  HighlightManager.prototype.annotationKey = function (record) {
    return String(record.id) + ":" + record.cfiRange;
  };

  HighlightManager.prototype.hasAnnotation = function (cfiRange) {
    try {
      const annotations = this.rendition.annotations._annotations || {};
      return Object.prototype.hasOwnProperty.call(annotations, encodeURI(cfiRange));
    } catch (err) {
      return false;
    }
  };

  HighlightManager.prototype.deferColorSync = function () {
    window.setTimeout(this.syncAnnotationColors.bind(this), 0);
    window.setTimeout(this.syncAnnotationColors.bind(this), 100);
  };

  HighlightManager.prototype.syncAnnotationColors = function () {
    if (!this.rendition) return;
    const byCfi = {};
    this.highlights.forEach(item => {
      byCfi[item.cfiRange] = item;
    });

    try {
      this.rendition.views().forEach(view => {
        Object.keys(view.highlights || {}).forEach(cfiRange => {
          const record = byCfi[cfiRange];
          const item = view.highlights[cfiRange];
          if (!record || !item || !item.element) return;
          this.colorHighlightElement(item.element, record.color);
        });
      });
    } catch (err) {
      console.error("error coloring highlights", err);
    }
  };

  HighlightManager.prototype.colorHighlightElement = function (element, color) {
    const fill = normalizeColor(color) || COLOR_HEX_BY_NAME.yellow;
    element.setAttribute("data-highlight-color", fill);
    Array.from(element.querySelectorAll("rect")).forEach(rect => {
      rect.setAttribute("fill", fill);
      rect.setAttribute("fill-opacity", "0.42");
      rect.setAttribute("mix-blend-mode", "multiply");
    });
  };

  HighlightManager.prototype.renderList = function () {
    if (!this.list) return;
    this.list.innerHTML = "";

    if (this.statusMessage) {
      this.list.appendChild(this.statusNode(this.statusMessage, this.statusIsError));
    }

    if (!this.book) {
      this.list.appendChild(this.emptyNode("Open a book to see highlights."));
      return;
    }

    if (this.loading) {
      this.list.appendChild(this.emptyNode("Loading highlights..."));
      return;
    }

    if (this.highlights.length === 0) {
      this.list.appendChild(this.emptyNode("No highlights yet."));
      return;
    }

    this.highlights.forEach(record => {
      this.list.appendChild(this.highlightNode(record));
    });
  };

  HighlightManager.prototype.statusNode = function (text, isError) {
    const el = document.createElement("div");
    el.classList.add("highlights-empty");
    el.style.color = isError ? "#9f2a2a" : "#666";
    el.innerText = text;
    return el;
  };

  HighlightManager.prototype.emptyNode = function (text) {
    const el = document.createElement("div");
    el.classList.add("highlights-empty");
    el.innerText = text;
    return el;
  };

  HighlightManager.prototype.highlightNode = function (record) {
    const item = document.createElement("div");
    item.classList.add("highlight-item");
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.addEventListener("click", () => this.goToHighlight(record));
    item.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.goToHighlight(record);
      }
    });

    const meta = item.appendChild(document.createElement("div"));
    meta.classList.add("highlight-meta");

    const color = meta.appendChild(document.createElement("span"));
    color.classList.add("highlight-swatch");
    color.style.background = normalizeColor(record.color) || COLOR_HEX_BY_NAME.yellow;

    const date = meta.appendChild(document.createElement("span"));
    date.classList.add("highlight-date");
    date.innerText = this.formatDate(record.createdAt);

    const palette = meta.appendChild(document.createElement("span"));
    palette.classList.add("highlight-palette");
    COLOR_NAMES.forEach(name => {
      const button = palette.appendChild(document.createElement("button"));
      button.classList.add("highlight-color", "highlight-color-" + name);
      button.type = "button";
      button.title = "Change highlight colour to " + name;
      button.disabled = !!this.updateInProgress[record.id];
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        this.updateHighlightColor(record.id, COLOR_HEX_BY_NAME[name]);
      });
    });

    const remove = meta.appendChild(document.createElement("button"));
    remove.classList.add("highlight-delete");
    remove.type = "button";
    remove.title = "Delete highlight";
    remove.innerText = this.deleteInProgress[record.id] ? "deleting..." : "delete";
    remove.disabled = !!this.deleteInProgress[record.id];
    remove.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.deleteHighlight(record.id);
    });

    const text = item.appendChild(document.createElement("div"));
    text.classList.add("highlight-text");
    text.innerText = record.text;

    return item;
  };

  HighlightManager.prototype.formatDate = function (value) {
    try {
      return new Date(value).toLocaleDateString();
    } catch (err) {
      return "";
    }
  };

  HighlightManager.prototype.goToHighlight = function (record) {
    if (!this.rendition) return;
    try {
      const result = this.rendition.display(record.cfiRange);
      if (result && result.catch) {
        result.catch(err => this.handleHighlightNavigationError(record, err));
      }
    } catch (err) {
      this.handleHighlightNavigationError(record, err);
    }
  };

  HighlightManager.prototype.handleHighlightNavigationError = function (record, err) {
    this.setStatus("This highlight location is no longer available.", true);
    console.warn("highlight navigation failed", {
      highlightId: record && record.id,
      cfiRange: record && record.cfiRange,
      error: err && err.message || String(err)
    });
  };

  HighlightManager.prototype.updateHighlightColor = function (id, color) {
    const record = this.findHighlight(id);
    color = normalizeColor(color);
    if (!record || !color || this.updateInProgress[id]) return;
    if (normalizeColor(record.color) === color) return;

    this.updateInProgress[id] = true;
    this.renderList();
    this.log("HIGHLIGHT_UPDATE_STARTED", {
      highlightId: id,
      bookId: record.bookId,
      cfiRange: record.cfiRange
    });

    return this.whenAuthenticated()
      .then(() => updateHighlight(id, { color: color }))
      .then(updated => {
        const existing = this.findHighlight(id);
        if (!existing) return;
        this.removeRenderedHighlight(existing);
        this.replaceHighlight(updated);
        this.applyAnnotation(updated, true);
        this.setStatus("", false);
        this.log("HIGHLIGHT_UPDATE_SUCCEEDED", {
          highlightId: updated.id,
          bookId: updated.bookId,
          cfiRange: updated.cfiRange,
          status: 200
        });
      })
      .catch(err => {
        this.setStatus(this.userErrorMessage(err, "Unable to update highlight colour."), true);
        this.log("HIGHLIGHT_UPDATE_FAILED", {
          highlightId: id,
          bookId: record.bookId,
          cfiRange: record.cfiRange,
          status: err.status || 0,
          error: err.message || String(err)
        });
      })
      .then(() => {
        delete this.updateInProgress[id];
        this.renderList();
      });
  };

  HighlightManager.prototype.deleteHighlight = function (id) {
    const record = this.findHighlight(id);
    if (!record || this.deleteInProgress[id]) return;

    this.deleteInProgress[id] = true;
    this.renderList();
    this.log("HIGHLIGHT_DELETE_STARTED", {
      highlightId: id,
      bookId: record.bookId,
      cfiRange: record.cfiRange
    });

    return this.whenAuthenticated()
      .then(() => deleteHighlight(id))
      .then(() => {
        this.removeRenderedHighlight(record);
        this.highlights = this.highlights.filter(item => String(item.id) !== String(id));
        this.setStatus("", false);
        this.log("HIGHLIGHT_DELETE_SUCCEEDED", {
          highlightId: id,
          bookId: record.bookId,
          cfiRange: record.cfiRange,
          status: 200
        });
      })
      .catch(err => {
        this.setStatus(this.userErrorMessage(err, "Unable to delete highlight."), true);
        this.log("HIGHLIGHT_DELETE_FAILED", {
          highlightId: id,
          bookId: record.bookId,
          cfiRange: record.cfiRange,
          status: err.status || 0,
          error: err.message || String(err)
        });
      })
      .then(() => {
        delete this.deleteInProgress[id];
        this.renderList();
      });
  };

  HighlightManager.prototype.findHighlight = function (id) {
    return this.highlights.filter(item => String(item.id) === String(id))[0] || null;
  };

  HighlightManager.prototype.upsertHighlight = function (record) {
    this.highlights = this.highlights.filter(item => String(item.id) !== String(record.id));
    this.highlights.unshift(record);
    this.highlights = uniqueHighlights(this.highlights);
  };

  HighlightManager.prototype.replaceHighlight = function (record) {
    let replaced = false;
    this.highlights = this.highlights.map(item => {
      if (String(item.id) !== String(record.id)) return item;
      replaced = true;
      return record;
    });
    if (!replaced) this.highlights.unshift(record);
    this.highlights = uniqueHighlights(this.highlights);
  };

  HighlightManager.prototype.setStatus = function (message, isError) {
    this.statusMessage = message || "";
    this.statusIsError = !!isError;
    this.renderList();
  };

  HighlightManager.prototype.userErrorMessage = function (err, fallback) {
    if (err && err.userMessage) return err.userMessage;
    if (err && err.message) return err.message;
    return fallback;
  };

  HighlightManager.prototype.log = function (eventName, detail, level) {
    const payload = Object.assign({ event: eventName }, detail || {});
    if (level === "warn") {
      console.warn("HIGHLIGHTS", payload);
    } else {
      console.debug("HIGHLIGHTS", payload);
    }
  };

  function fetchBookHighlights(bookId) {
    return requestJson("/api/user/highlights/" + encodeURIComponent(bookId), {
      method: "GET"
    }).then(result => {
      const data = result.data && Array.isArray(result.data.data) ? result.data.data : [];
      return data.map(mapApiHighlight).filter(isValidMappedHighlight);
    });
  }

  function createHighlight(payload) {
    return requestJson("/api/user/highlights", {
      method: "POST",
      body: JSON.stringify(payload)
    }).then(result => requireApiHighlight(result.data && result.data.data));
  }

  function updateHighlight(id, payload) {
    return requestJson("/api/user/highlights/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify(payload)
    }).then(result => requireApiHighlight(result.data && result.data.data));
  }

  function deleteHighlight(id) {
    return requestJson("/api/user/highlights/" + encodeURIComponent(id), {
      method: "DELETE"
    });
  }

  function requestJson(path, options) {
    if (!window.readerFetch) {
      return Promise.reject(new Error("Reader API is not available."));
    }

    options = options || {};
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if ((options.method || "GET").toUpperCase() !== "GET" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    return window.readerFetch(path, Object.assign({}, options, { headers: headers }))
      .then(response => parseApiResponse(response).then(data => {
        if (!response.ok) throw apiError(response, data);
        return {
          status: response.status,
          data: data
        };
      }));
  }

  function parseApiResponse(response) {
    return response.text().then(text => {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        const error = new Error("The highlights endpoint returned invalid JSON.");
        error.status = response.status;
        throw error;
      }
    });
  }

  function apiError(response, data) {
    const message = extractApiMessage(data) || "The highlights request failed.";
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    error.userMessage = message;
    return error;
  }

  function extractApiMessage(data) {
    if (!data) return "";
    if (data.errors && typeof data.errors === "object") {
      const firstKey = Object.keys(data.errors)[0];
      const firstError = firstKey && data.errors[firstKey];
      if (Array.isArray(firstError) && firstError[0]) return String(firstError[0]);
      if (typeof firstError === "string") return firstError;
    }
    if (typeof data.message === "string") return data.message;
    return "";
  }

  function mapApiHighlight(highlight) {
    if (!highlight) return null;
    return {
      id: highlight.id,
      bookId: String(highlight.book_id),
      text: String(highlight.text || ""),
      cfiRange: String(highlight.cfi_range || ""),
      color: normalizeColor(highlight.color) || COLOR_HEX_BY_NAME.yellow,
      createdAt: highlight.created_at || "",
      updatedAt: highlight.updated_at || ""
    };
  }

  function requireApiHighlight(highlight) {
    const mapped = mapApiHighlight(highlight);
    if (!isValidMappedHighlight(mapped)) {
      throw new Error("The highlights endpoint returned an invalid highlight.");
    }
    return mapped;
  }

  function isValidMappedHighlight(highlight) {
    return !!(highlight &&
      highlight.id !== undefined &&
      highlight.bookId &&
      highlight.text &&
      isValidCfiRange(highlight.cfiRange) &&
      normalizeColor(highlight.color));
  }

  function isValidHighlightPayload(payload) {
    return !!(payload &&
      payload.bookId &&
      payload.text &&
      payload.cfiRange &&
      isValidCfiRange(payload.cfiRange) &&
      normalizeColor(payload.color));
  }

  function uniqueHighlights(highlights) {
    const seenIds = {};
    const seenAnnotations = {};
    return highlights.filter(item => {
      if (!item || item.id === undefined || !item.cfiRange) return false;
      const idKey = String(item.id);
      const annotationKey = idKey + ":" + item.cfiRange;
      if (seenIds[idKey] || seenAnnotations[annotationKey]) return false;
      seenIds[idKey] = true;
      seenAnnotations[annotationKey] = true;
      return true;
    });
  }

  function normalizeColor(color) {
    if (!color) return "";
    const value = String(color).trim();
    if (COLOR_HEX_BY_NAME[value]) return COLOR_HEX_BY_NAME[value];
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
    return "";
  }

  function isValidCfiRange(cfiRange) {
    return typeof cfiRange === "string" && cfiRange.indexOf("epubcfi(") === 0;
  }

  window.HighlightManager = HighlightManager;
})();
