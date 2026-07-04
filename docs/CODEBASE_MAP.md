# Codebase Map

This document maps the current MyLibriBooks EPUB Reader implementation.

## Project Shape

- `index.html`: static UI structure, settings controls, reader shell, script loading.
- `style.css`: application, sidebar, reader, settings, dictionary, and mobile styling.
- `script.js`: main reader application logic through the global `App` constructor.
- `features/highlights.js`: highlight creation, highlight storage, annotation restore, and highlight list behavior.
- `features/reading-history.js`: local reading-history tracking, certified pages-read calculation, and future API sync queueing.
- `features/speech.js`: Text-to-Speech setup and EasySpeech integration.
- `libs/epub.js`: customized epub.js build used for EPUB parsing, rendering, CFI, locations, and spine access.
- `libs/epub.orig.js`: original epub.js reference build.
- `libs/epub.js.diff`: diff showing known local epub.js modifications.
- `polyfills/`: browser compatibility polyfills loaded before application code.

## Runtime Load Order

`index.html` loads dependencies and application scripts in this order:

1. Polyfills.
2. `sanitize-html`.
3. `jszip`.
4. Customized `libs/epub.js`.
5. Raven/Sentry.
6. `features/highlights.js`.
7. `features/reading-history.js`.
8. `script.js`.
9. EasySpeech from CDN.
10. `features/speech.js`.

`script.js` creates the global `ePubViewer` immediately after loading. `features/speech.js` initializes on `document.body.onload`.

## Major Globals

- `window.onerror`: global error handler that displays the `.error` panel and reports to Raven when enabled.
- `ePubViewer`: global instance of `App`, created from `document.querySelector(".app")`.
- `window.globalVariable`: object used to expose the current page or spine text to `features/speech.js`; currently shaped as `{ epubText }`.
- `window.globalVariableTag`: object used by `features/speech.js` for speech boundary highlighting; currently shaped as `{ epubBodyTag }`.
- `window.readerContext`: parsed iframe URL context shaped as `{ bookUrl, bookId, genre, hideOpenButton }`.
- `disableRaven` / `window.disableRaven`: optional flags checked before sending Raven errors.
- `EasySpeech`: global provided by the CDN EasySpeech IIFE script.
- `ePub`: global provided by `libs/epub.js`.
- `sanitizeHtml`: global provided by `libs/sanitize-html.min.js`.

## Main App State

`App` stores mutable reader state on `this.state`.

Important fields:

- `state.book`: current epub.js book object.
- `state.rendition`: current epub.js rendition object.
- `state.dictInterval`: interval used to poll the current text selection for dictionary lookup.
- `state.showDictTimeout`: timeout used to delay dictionary display until selection stabilizes.
- `state.lastWord`: last dictionary word shown.

`doReset()` destroys existing `rendition` and `book`, clears UI fields, hides navigation buttons, hides the sidebar, and resets dictionary UI.

## Major Functions in `script.js`

### Initialization and Errors

- `isRavenDisabled()`: checks local/global Raven disable flags.
- `window.onerror`: catches uncaught errors, shows the app error panel, and optionally reports to Raven.
- `App(el)`: constructor that wires DOM event listeners, loads saved settings, applies theme, and opens the TOC tab.
- `fatal(msg, err, usersFault)`: displays a fatal error and optionally sends it to Raven.

### DOM Helpers

- `qs(q)`: scoped `querySelector` inside the app element.
- `qsa(q)`: scoped `querySelectorAll` returning an array.
- `el(t, c)`: creates an element and optionally adds one class.

### Book Loading

- `doOpenBook()`: creates a hidden file input, reads a selected EPUB with `FileReader`, validates ZIP magic bytes, and calls `doBook()`.
- `doBook(url, opts)`: resets current state, creates `ePub(url, opts)`, renders to `.book`, registers epub.js hooks/events, loads metadata/navigation/cover, displays the rendition, starts dictionary polling, and populates speech text globals.
- `onBookReady()`: shows reader controls and loads or generates epub.js locations.
- `onBookMetadataLoaded(metadata)`: fills title, author, description, series, and series index UI.
- `onBookCoverLoaded(url)`: loads cover URL directly or through `book.archive.createUrl()`.
- `onNavigationLoaded(nav)`: builds the TOC list from epub.js navigation data.

### Navigation and Position

- `makeRangeCfi(a, b)`: combines start and end CFIs into an epub.js range CFI.
- `onTocItemClick(href, event)`: displays a TOC target.
- `onResultClick(href, event)`: displays a search result CFI.
- `onKeyUp(event)`: left/right arrow navigation.
- `onRenditionClick(event)`: page click navigation by horizontal region; right edge opens sidebar.
- `onRenditionDisplayedTouchSwipe(event)`: attaches touchstart/touchend listeners to rendered content for swipe navigation.
- `onRenditionRelocated(event)`: updates active TOC item and hides dictionary.
- `onRenditionRelocatedUpdateIndicators(event)`: updates progress text or rebuilds the progress bar.
- `onRenditionRelocatedSavePos(event)`: saves current start/end CFI to localStorage.
- `onRenditionStartedRestorePos(event)`: restores saved start CFI after rendition start.
- `onRenditionRestoreCurrentPos(event, location)`: prepares current-page text for speech from saved or relocated CFI data.
- `onRenditionUpdateCurrentPos(event)`: updates `window.globalVariable.epubText` from the current relocated range.
- `onFirstRenditionUpdateCurrentPos(event)`: initializes `window.globalVariable.epubText` from the first relocated range.
- `checkLastChapter(location)`: logs whether the current spine item is the last chapter.

### Settings and Theme

- `loadSettingsFromStorage()`: restores chip settings for theme, font, font size, line spacing, margin, and progress.
- `restoreChipActive(container)`: loads a saved setting or applies the default chip.
- `setDefaultChipActive(container)`: chooses the chip marked `data-default`.
- `setChipActive(container, value)`: updates active chip, persists value, reapplies theme, and refreshes progress indicators.
- `getChipActive(container)`: returns the active chip value, falling back to the default chip.
- `applyTheme()`: applies app background/text styling and injects reader content stylesheet rules through epub.js contents.
- `loadFonts()`: injects Google Font stylesheet links into rendered EPUB contents.
- `doFullscreen()`: requests fullscreen using standard, Mozilla, or WebKit APIs.

### Search

- `doSearch(q)`: loads each spine item, uses epub.js `item.find(q)`, unloads the item, and returns flattened results.
- `onSearchClick(event)`: executes search, renders up to 200 results, and wires result clicks.

### Sidebar and Tabs

- `doTab(tab)`: shows the selected sidebar tab and hides the others.
- `onTabClick(tab, event)`: handles tab clicks.
- `doSidebar()`: toggles the sidebar wrapper.

### Dictionary

- `checkDictionary()`: polls selected text inside the epub.js content iframe and schedules a dictionary lookup.
- `doDictionary(word)`: shows/hides dictionary UI and fetches definitions from `https://dict.api.pgaskin.net/word/...`.

## Major Functions in `features/reading-history.js`

- `ReadingHistoryManager(app)`: owns reading session state and reading-history lifecycle.
- `attach(book, rendition)`: attaches the manager to the current book/rendition when valid `readerContext` exists.
- `setMetadata(metadata)`: receives EPUB title and author from `onBookMetadataLoaded`.
- `onRelocated(location)`: finalizes the previous visible location and starts certification for the new location.
- `finalizeCurrentView()`: certifies a location as read when visible time and word-count rules pass.
- `getVisibleText(location)`: extracts visible text using the current start/end CFI range.
- `payload()`: builds the reading-history payload.
- `ReadingHistoryStorage`: persists session and unsynced queue records in localStorage.
- `ReadingHistorySync`: POST sync boundary for a future configured API URL.

## Major Functions in `features/speech.js`

- `document.body.onload`: initializes speech logging, feature detection, EasySpeech, voices, controls, speech actions, and EasySpeech event logging.
- `createLog()`: connects EasySpeech debug logging to `debug()`.
- `debug(arg)`: logs speech debug output to the console.
- `appendFeatures(detected)`: logs EasySpeech feature detection output.
- `init()`: calls `EasySpeech.init()` and updates the speech status header.
- `populateVoices(initialized)`: gets EasySpeech voices, builds language options, filters voices by selected language, and stores selected voice.
- `initInputs(initialized)`: enables volume/rate/pitch/text inputs and stores changed values.
- `getValues()`: returns a shallow copy of current speech settings.
- `initSpeak(initialized)`: wires start, stop, pause, and resume controls to EasySpeech.
- `initEvents(initialized)`: registers EasySpeech global event logging.
- `textNode(text, parent)`: helper to create an element with a text node.

Speech state in `features/speech.js`:

- `filteredVoices`: currently available voices after language filtering.
- `values`: selected voice, rate, pitch, volume, and text values.
- `inputs`: DOM references for volume, rate, pitch, hidden text input, language select, and voice select.

## Event Listeners

### Application DOM Events

- `document.body` `keyup`: reader keyboard navigation.
- `.tab-list .item` `click`: sidebar tab switching.
- `.search-box` `keydown`: Enter triggers search.
- `.search-button` `click`: search.
- `.sidebar-wrapper` `click`: hides sidebar when clicking wrapper.
- `.chip[data-value]` `click`: updates settings chips.
- `button.prev` `click`: calls `rendition.prev()`.
- `button.next` `click`: marks next as clicked, calls `rendition.next()`, and prepares current speech text.
- `button.open` `click`: calls `window.history.back()`.
- `.bar .loc` `click`: prompts for a location number and displays the corresponding CFI.
- TOC item `click`: displays TOC href.
- Search result `click`: displays result CFI.
- Progress bar `click`: stops location prompt propagation.
- Progress range `change`: displays CFI from selected generated location.
- Progress markers `click`: display CFI for generated spine markers.
- Rendered EPUB document `touchstart` / `touchend`: swipe navigation.

### Speech DOM Events

- `#volume-input` `change`: updates speech volume.
- `#rate-input` `change`: updates speech rate.
- `#pitch-input` `change`: updates speech pitch.
- `#lang-select` `change`: repopulates voice options.
- `#voice-select` `change`: stores selected voice.
- `.speak-btn` `click`: starts EasySpeech reading current `window.globalVariable.epubText`.
- `.stop-btn` `click`: calls `EasySpeech.cancel()`.
- `.pause-btn` `click`: calls `EasySpeech.pause()`.
- `.resume-btn` `click`: calls `EasySpeech.resume()`.
- `.next` `click`: added during speech start to stop speech on trusted next-page clicks.
- `.open` `click`: added during speech start to stop speech when going back.

### epub.js Events and Hooks

- `rendition.hooks.content.register(applyTheme)`: applies theme styles to rendered contents.
- `rendition.hooks.content.register(loadFonts)`: injects font stylesheets into rendered contents.
- `rendition.on("relocated", onRenditionRelocated)`: active TOC and dictionary reset.
- `rendition.on("relocated", onRenditionRelocatedUpdateIndicators)`: progress display.
- `rendition.on("relocated", onRenditionRelocatedSavePos)`: reading position persistence.
- `rendition.on("relocated", onRenditionUpdateCurrentPos)`: current text export for speech, attached in some navigation flows.
- `rendition.on("relocated", onFirstRenditionUpdateCurrentPos)`: first current text export for speech, attached when no saved position exists.
- `rendition.on("relocated", checkLastChapter)`: last-chapter logging, attached in current-position flows.
- `rendition.on("click", onRenditionClick)`: click/tap navigation inside EPUB content.
- `rendition.on("keyup", onKeyUp)`: keyboard navigation from EPUB content.
- `rendition.on("displayed", onRenditionDisplayedTouchSwipe)`: touch navigation setup.
- `rendition.on("started", onRenditionStartedRestorePos)`: saved position restore.
- `rendition.on("displayError", fatal)`: rendering error handling.

### EasySpeech Events

Per-call callbacks in `EasySpeech.speak()`:

- `boundary`: updates `window.globalVariableTag.epubBodyTag.innerText` with highlighted boundary text.
- `start`: attaches stop-on-navigation handlers.
- `end`: auto-clicks next and schedules another speech start.

Global EasySpeech event logging:

- `boundary`
- `start`
- `end`
- `error`

## epub.js Integration Points

- `ePub(url, opts)`: creates the book.
- `book.renderTo(this.qs(".book"), {})`: creates the rendition.
- `rendition.display()`: initial render.
- `rendition.display(hrefOrCfi)`: TOC, search result, progress, and restored-position navigation.
- `rendition.prev()` / `rendition.next()`: page navigation.
- `book.ready`: triggers location generation and current position restore.
- `book.loaded.spine`: loads spine items to export body text/tag for speech globals.
- `book.loaded.navigation`: builds TOC.
- `book.loaded.metadata`: fills metadata UI.
- `book.loaded.cover`: fills cover UI.
- `book.locations.generate(chars)`: generates location data.
- `book.locations.save()` / `book.locations.load(stored)`: serializes/restores locations.
- `book.locations.cfiFromLocation(location)`: progress bar and go-to-location navigation.
- `book.locations.percentageFromLocation(location)`: progress marker placement.
- `book.locations.percentageFromCfi(cfi)`: search result progress bars.
- `book.getRange(rangeCfi)`: extracts text for the current visible range.
- `new ePub.CFI()`: parses and builds CFIs.
- `book.canonical(href)`: matches TOC items against current location.
- `book.archive.createUrl(url)`: creates cover blob/object URL for archived books.
- `spineItem.load(book.load.bind(book))`, `spineItem.find(q)`, `spineItem.unload()`: search.

## epub.js Customizations

Known local customizations are documented in `docs/KNOWN_EPUBJS_CUSTOMIZATIONS.md` and `libs/epub.js.diff`.

Documented customization:

- `Path(pathString)` URL handling uses a guarded `new URL(pathString).pathname` conversion so invalid URLs do not prevent some EPUBs from opening.

Diff-recorded customizations:

- Content padding was changed from shorthand padding to explicit `padding-left` and `padding-right`.
- Packaging metadata parsing includes `calibre:series` and `calibre:series_index`.
- `getMetaContent(xml, name)` was added to read OPF meta `content` attributes.
- Some line-ending/no-newline differences are present in the generated vendor build.

Vendor files are protected. Any future epub.js change should compare `libs/epub.js` with `libs/epub.orig.js` and preserve these local fixes.

## Speech Integration Points

`script.js` prepares text for speech in two ways:

- During `doBook()`, every spine item body is loaded and assigned to `window.globalVariable.epubText`; the corresponding body element is assigned to `window.globalVariableTag.epubBodyTag`.
- During current-position restore/relocation, `book.getRange(makeRangeCfi(start, end))` updates `window.globalVariable.epubText` with visible range text.

`features/speech.js` reads:

- `window.globalVariable.epubText` as the text passed to `EasySpeech.speak()`.
- `window.globalVariableTag.epubBodyTag` as the target for boundary highlighting.

`features/speech.js` also controls reader navigation indirectly:

- On speech end, it programmatically clicks `.next`.
- After a delay, it programmatically clicks `.speak-btn` to continue reading.
- During speech start, it attaches handlers to `.next` and `.open` to cancel speech when navigation occurs.

## iframe Communication Points

The reader is intended to run inside a parent application iframe.

Current direct iframe integration points:

- No active `window.parent.postMessage()` calls are present.
- No active `message` event listener is present.
- The back button uses `window.history.back()` instead of parent-state access.
- The book URL can be provided through `location.search` or `location.hash`.
- `getReaderContext()` parses `bookUrl`, `bookId`, `genre`, and `hideOpenButton` from the iframe URL and stores them on `window.readerContext`.
- `bookId` and `genre` are used for reading history and are not appended to the EPUB fetch URL.
- If the URL/hash starts with `!`, the open/back button is hidden.

Future parent communication should use `window.parent.postMessage()` and should not assume direct access to parent application state.

## Storage Mechanisms

### localStorage

Reader preferences:

- `ePubViewer:theme`
- `ePubViewer:font`
- `ePubViewer:font-size`
- `ePubViewer:line-spacing`
- `ePubViewer:margin`
- `ePubViewer:progress`

Book-specific data:

- `${book.key()}:locations-${chars}`: serialized epub.js locations, with `chars` currently `1650`.
- `${book.key()}:pos`: saved start CFI.
- `${book.key()}:posend`: saved end CFI.
- `ePubViewer:${bookId}:reading-history:session`: local reading-history session cache.
- `ePubViewer:${bookId}:reading-history:queue`: unsynced reading-history payload queue.

Reset:

- The Reset All link in `index.html` calls `localStorage.clear()` and reloads the page.

### File and Network Inputs

- Local EPUB import uses `FileReader.readAsArrayBuffer()`.
- Remote EPUB loading uses a URL from `location.search` or `location.hash`.
- Remote URL existence is checked with `fetch(ufn)` before/during `doBook(ufn)`.
- Dictionary lookup uses `fetch("https://dict.api.pgaskin.net/word/...")`.

### Disabled/Commented Storage Features

- A service worker registration block is present but commented out.
- Cache inspection through `window.caches.keys()` is present but commented out.

## Navigation Flow

### Initial URL Load

1. `script.js` creates `ePubViewer = new App(...)`.
2. `App` wires UI events, loads preferences, applies theme, and opens the TOC tab.
3. Startup reads book URL from `location.search` or `location.hash`.
4. If present, it optionally hides the open button when prefixed with `!`.
5. `doBook(ufn)` creates the epub.js book/rendition and displays it.
6. `book.ready` loads/generates locations and attempts to restore reading position.
7. epub.js events update TOC, progress, saved position, and speech text globals.

### Next/Previous Navigation

- Bottom previous button calls `rendition.prev()`.
- Bottom next button calls `rendition.next()`, marks the button as clicked, and triggers current-position text setup.
- Left/right keyboard events call `rendition.prev()` and `rendition.next()`.
- EPUB content clicks navigate by screen thirds.
- EPUB content swipe gestures call `rendition.prev()` or `rendition.next()`.
 
 ## Page Turn vs Text Selection Rule

The reader supports click zones:

- Left side click = previous page
- Right side click = next page

However, page turning must be disabled when the user is selecting text.

A text selection gesture must not trigger page navigation, even if the gesture starts or ends inside the left/right click zone.

### TOC Navigation

1. `onNavigationLoaded()` builds `.toc-list`.
2. Clicking a TOC item calls `rendition.display(item.href)`.
3. Relocation updates the active TOC item.

### Search Navigation

1. Search input or button calls `onSearchClick()`.
2. `doSearch()` searches all spine items.
3. Results are rendered with result CFI links.
4. Clicking a result calls `rendition.display(result.cfi)`.

### Location Navigation

1. Clicking `.bar .loc` prompts for a numeric location.
2. The value is converted with `book.locations.cfiFromLocation()`.
3. The rendition displays that CFI.

When progress display is set to `bar`, `.bar .loc` is replaced with a range input and markers. Changing the range displays the corresponding generated CFI.

### Speech Auto-Advance Flow

1. User clicks `.speak-btn`.
2. `features/speech.js` reads `window.globalVariable.epubText`.
3. `EasySpeech.speak()` begins.
4. Boundary events attempt to highlight spoken text.
5. On speech end, `.next` is clicked.
6. After a fixed delay, `.speak-btn` is clicked again.

## External Services and CDN Dependencies

- Google Fonts and Material Icons are loaded from Google CDN.
- Raven is loaded from `https://cdn.ravenjs.com/...`.
- EasySpeech is loaded from `https://cdn.jsdelivr.net/npm/easy-speech/dist/EasySpeech.iife.js`.
- Dictionary lookups call `https://dict.api.pgaskin.net/word/...`.
- Optional remote EPUB URL loading uses the URL passed in the page query/hash.

## Notable Coupling

- `features/speech.js` depends on globals written by `script.js`, especially `window.globalVariable` and `window.globalVariableTag`.
- `script.js` assumes epub.js globals are already loaded.
- `features/speech.js` assumes EasySpeech is already loaded from the CDN.
- Settings chips in `index.html` are coupled to `script.js` through `data-chips`, `data-value`, and `data-default`.
- The reader is iframe-compatible by architecture, but no active parent-window messaging currently exists.


## Feature Folder Rule

All reader features must live inside the `features/` folder.

Examples:

- `features/highlights.js`
- `features/reading-history.js`
- `features/speech.js`
- `features/analytics.js`
- `features/leaderboard.js`

Do not add new feature files directly to the project root.
The project root should remain reserved for `index.html`, `style.css`, `script.js`, vendor libraries, static assets, and project documentation.
