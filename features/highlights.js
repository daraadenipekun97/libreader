(function () {
  "use strict";

  const COLORS = {
    yellow: "#ffd84d",
    green: "#73d677",
    blue: "#74b9ff",
    pink: "#ff8fbd",
    purple: "#b59cff"
  };

  function HighlightManager(app) {
    this.app = app;
    this.book = null;
    this.rendition = null;
    this.highlights = [];
    this.pendingSelection = null;
    this.boundContents = [];
    this.storage = new HighlightStorage();
    this.selectedHandler = this.onSelected.bind(this);
    this.displayedHandler = this.onDisplayed.bind(this);
    this.reapplyHandler = this.reapplyAnnotations.bind(this);
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
    this.renderList();
  }

  function HighlightStorage() {}

  HighlightStorage.prototype.key = function (bookId) {
    return "ePubViewer:" + bookId + ":highlights";
  };

  HighlightStorage.prototype.load = function (bookId) {
    const raw = localStorage.getItem(this.key(bookId));
    return this.parse(raw).filter(item => item.bookId === bookId);
  };

  HighlightStorage.prototype.save = function (bookId, highlights) {
    localStorage.setItem(this.key(bookId), JSON.stringify(highlights));
  };

  HighlightStorage.prototype.parse = function (raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(this.isValidHighlight) : [];
    } catch (err) {
      return [];
    }
  };

  HighlightStorage.prototype.isValidHighlight = function (item) {
    return item &&
      typeof item.id === "string" &&
      typeof item.bookId === "string" &&
      typeof item.text === "string" &&
      typeof item.cfiRange === "string" &&
      typeof item.color === "string" &&
      typeof item.createdAt === "string";
  };

  HighlightManager.prototype.attach = function (book, rendition) {
    this.detach();
    this.book = book;
    this.rendition = rendition;
    this.highlights = this.load();
    this.renderList();
    this.restoreAnnotations();

    rendition.on("selected", this.selectedHandler);
    rendition.on("relocated", this.reapplyHandler);
    rendition.on("displayed", this.displayedHandler);
  };

  HighlightManager.prototype.detach = function () {
    this.hideToolbar();
    this.pendingSelection = null;
    this.unbindContents();
    if (this.restoreTimer) {
      window.clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.book = null;
    this.rendition = null;
    this.highlights = [];
    this.renderList();
  };

  HighlightManager.prototype.bookId = function () {
    return this.book ? this.book.key() : "";
  };

  HighlightManager.prototype.storageKey = function () {
    return this.storage.key(this.bookId());
  };

  HighlightManager.prototype.load = function () {
    if (!this.book) return [];
    try {
      return this.storage.load(this.bookId());
    } catch (err) {
      console.error("error loading highlights", err);
      return [];
    }
  };

  HighlightManager.prototype.save = function () {
    if (!this.book) return;
    try {
      this.storage.save(this.bookId(), this.highlights);
    } catch (err) {
      console.error("error saving highlights", err);
    }
  };

  HighlightManager.prototype.onSelected = function (cfiRange, contents) {
    const text = this.getSelectedText(contents);
    if (this.wordCount(text) < 3) {
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
    if (this.wordCount(this.getSelectedText(contents)) >= 3) return;
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
    this.pendingSelection = null;
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

  HighlightManager.prototype.createHighlight = function (color) {
    if (!this.pendingSelection || !this.book || !this.rendition) return;
    if (!COLORS[color]) color = "yellow";

    const record = {
      id: "highlight-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      bookId: this.bookId(),
      text: this.pendingSelection.text,
      cfiRange: this.pendingSelection.cfiRange,
      color: color,
      createdAt: new Date().toISOString()
    };

    this.highlights = this.highlights.filter(item => item.cfiRange !== record.cfiRange);
    this.highlights.push(record);
    this.save();
    this.applyAnnotation(record, true);
    this.renderList();
    this.clearSelection(this.pendingSelection.contents);
    this.hideToolbar();
  };

  HighlightManager.prototype.clearSelection = function (contents) {
    try {
      contents.window.getSelection().removeAllRanges();
    } catch (err) {}
  };

  HighlightManager.prototype.restoreAnnotations = function () {
    this.highlights.forEach(record => this.applyAnnotation(record, false));
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
    if (!this.rendition || !this.rendition.annotations) return;
    try {
      if (!force && this.hasAnnotation(record.cfiRange)) {
        this.deferColorSync();
        return;
      }
      if (force) this.rendition.annotations.remove(record.cfiRange, "highlight");
      this.rendition.annotations.highlight(record.cfiRange, {
        id: record.id,
        color: record.color
      });
      this.deferColorSync();
    } catch (err) {
      console.error("error applying highlight", err);
    }
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
    const fill = COLORS[color] || COLORS.yellow;
    element.setAttribute("data-highlight-color", color);
    Array.from(element.querySelectorAll("rect")).forEach(rect => {
      rect.setAttribute("fill", fill);
      rect.setAttribute("fill-opacity", "0.42");
      rect.setAttribute("mix-blend-mode", "multiply");
    });
  };

  HighlightManager.prototype.renderList = function () {
    if (!this.list) return;
    this.list.innerHTML = "";

    if (!this.book) {
      this.list.appendChild(this.emptyNode("Open a book to see highlights."));
      return;
    }

    if (this.highlights.length === 0) {
      this.list.appendChild(this.emptyNode("No highlights yet."));
      return;
    }

    this.highlights
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .forEach(record => {
        this.list.appendChild(this.highlightNode(record));
      });
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
    color.classList.add("highlight-swatch", "highlight-swatch-" + record.color);

    const date = meta.appendChild(document.createElement("span"));
    date.classList.add("highlight-date");
    date.innerText = this.formatDate(record.createdAt);

    const remove = meta.appendChild(document.createElement("button"));
    remove.classList.add("highlight-delete");
    remove.type = "button";
    remove.title = "Delete highlight";
    remove.innerText = "delete";
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
    this.rendition.display(record.cfiRange);
  };

  HighlightManager.prototype.deleteHighlight = function (id) {
    const record = this.highlights.filter(item => item.id === id)[0];
    if (!record) return;

    try {
      if (this.rendition && this.rendition.annotations) {
        this.rendition.annotations.remove(record.cfiRange, "highlight");
      }
    } catch (err) {
      console.error("error removing highlight", err);
    }

    this.highlights = this.highlights.filter(item => item.id !== id);
    this.save();
    this.renderList();
  };

  window.HighlightManager = HighlightManager;
})();
