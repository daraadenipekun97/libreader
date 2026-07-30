# Reading History Feature

## Goal

Track and save a user's verified reading progress for each book in the EPUB reader.

The reader is hosted at:

- `https://reada.mylibribooks.com`

The parent application is hosted at:

- `https://mylibribooks.com`

The reader runs inside an iframe.

---

## API Endpoint

Reading history is saved with `fetch()` through the shared reader API helper.

```txt
POST https://beta.mylibribooks.com/api/user/reading/sessions
```

Use `readerFetch()` from `features/auth.js` so local development uses a Bearer token from `postMessage` and production uses the HttpOnly session cookie.

Do not introduce Axios or another HTTP client.

---

## Payload

The API payload is cumulative for the current reading session.

```js
{
  bookId: "string",
  title: "string",
  author: "string",
  genre: "string",
  pagesRead: 0,
  startedAt: "2026-04-19T09:15:00Z",
  finishedAt: "2026-04-22T18:45:00Z",
  minutesRead: 0,
  sessions: 1,
  isCompleted: false,
  completionPercentage: 0,
  highestPageRead: 325
}
```

`pageContent` is not part of the API payload. It is stored locally only for debugging.

---

## Data Sources

### bookId and genre

`bookId` and `genre` must come from the parent MyLibriBooks application through the iframe URL context.

Example:

```txt
https://reada.mylibribooks.com/#bookUrl&bookId=123&genre=fiction
```

`bookUrl` is used only for:

- `fetch(bookUrl)`
- `ePubViewer.doBook(bookUrl)`

`bookId` is used only for:

- reading history
- analytics
- leaderboard
- achievements

`genre` is used only for:

- reading history
- analytics
- recommendations

`bookId` and `genre` must never be appended to the EPUB fetch URL.

### title and author

`title` and `author` come from EPUB metadata in `onBookMetadataLoaded`.

---

## Session Rules

A session starts when:

- The book opens successfully.
- The reader receives valid `bookId` and `genre`.
- The reading-history manager attaches to the current EPUB book and rendition.

For each reader open event, send:

```js
sessions: 1
```

The backend can aggregate total sessions per user and book.

---

## Page Lifecycle

Reading progress is certified only when the user leaves a page/location.

When the user enters a page:

1. Resolve a stable page/location identifier from EPUB.js location data, falling back to CFI when needed.
2. Start tracking active reading time for that location.
3. Extract visible text from the current start/end CFI range.
4. Store the word count, page content preview, minimum allowed seconds, and maximum allowed seconds on the transient page view.

While the page remains current, count time only when:

- `document.visibilityState === "visible"`
- the reader is active or recently interacted with
- the EPUB view is still the current rendered location

When the user turns to another page:

1. Capture the previous page state.
2. Stop the previous page timer.
3. Finalize and validate the previous page.
4. Save certified cumulative progress locally.
5. Queue the newest cumulative API payload.
6. Attempt API synchronization immediately.
7. Initialize tracking for the new page.

Opening a page does not change certified progress. Reaching the minimum reading threshold does not certify the page before page exit.

---

## Page Read Certification Algorithm

EPUB pagination changes with screen size, font size, line height, margins, and device orientation. Static page numbers are unreliable, so the reader certifies visible EPUB locations based on text and active dwell time.

### 1. Dynamic Visible Word Count

For each entered page/location:

1. Build a range CFI from the EPUB.js relocated start/end CFI.
2. Extract the visible text with `book.getRange(rangeCfi)`.
3. Normalize whitespace.
4. Count visible words.

Example:

```js
const words = visibleText
  .trim()
  .replace(/\s+/g, " ")
  .split(" ")
  .filter(Boolean);

const wordCount = words.length;
```

### 2. Adaptive Reading Speed Window

Constants:

```js
const MIN_READING_WPM = 100;
const MAX_READING_WPM = 500;
```

For a visible page with `W` words:

```js
minimumAllowedSeconds = (W / MAX_READING_WPM) * 60;
maximumAllowedSeconds = (W / MIN_READING_WPM) * 60;
```

A page is certified only if the active dwell time is at least `minimumAllowedSeconds`.

If the user stays beyond `maximumAllowedSeconds`, the counted reading time is capped at `maximumAllowedSeconds` to avoid counting idle time.

### 3. Rejection Rules

A page must not be certified when:

- It has no measurable visible text.
- It has already been certified in the current session.
- The active dwell time is below the adaptive minimum.
- The user rapidly navigated through it.
- The tab was hidden or idle time dominated the dwell period.

Rejected pages do not update `pagesRead`, `highestPageRead`, `verifiedReadingSeconds`, `minutesRead`, or the API queue.

---

## Verified Metrics

### pagesRead

`pagesRead` is the number of unique certified reading locations/pages.

The same page/location must not be counted twice.

### verifiedReadingSeconds

`verifiedReadingSeconds` is accumulated only from certified page exits.

For each certified page:

```js
secondsAdded = Math.min(activeDwellSeconds, maximumAllowedSeconds);
verifiedReadingSeconds += secondsAdded;
```

### minutesRead

`minutesRead` is derived only from cumulative `verifiedReadingSeconds`.

Do not calculate `minutesRead` from:

```js
finishedAt - startedAt
```

Use:

```js
minutesRead = Math.round(verifiedReadingSeconds / 60);
```

### highestPageRead

`highestPageRead` is the highest certified page/location the user has reached.

Do not update `highestPageRead` merely because the user navigated or skipped to a page. Update it only after the page/location passes certification.

If EPUB.js does not provide a stable page number, use the certified EPUB location index/page index.

### completionPercentage

Completion percentage is based on certified read locations, not simple navigation progress.

```js
completionPercentage =
  (certifiedReadLocations / totalReadableLocations) * 100;
```

Round to the nearest whole number.

### isCompleted

A book is completed only when both conditions are true:

1. `completionPercentage >= 85`
2. The final readable section has been reached and certified.

```js
isCompleted = completionPercentage >= 85 && finalAnchorCertified;
```

---

## Synchronization Model

The API must not wait for a fixed five-minute interval before sending newly certified progress.

The API also must not fire for every page turn unconditionally.

Synchronize immediately only when the page being exited is successfully certified.

Example sequence:

- First qualifying page turn sends `pagesRead: 1`, cumulative `minutesRead`.
- Second qualifying page turn sends `pagesRead: 2`, cumulative `minutesRead`.
- A failed page turn sends nothing.
- The next qualifying page turn sends `pagesRead: 3`, cumulative `minutesRead`.

Do not send only the current page's reading time.

Do not reset cumulative session metrics after a successful API request.

---

## Sync Deduplication

Use progress-version and payload-hash deduplication.

Track:

- `progressVersion`
- `lastSyncedProgressVersion`
- `lastSuccessfulPayloadHash`
- `syncInProgress`

Only attempt sync when certified cumulative progress changed.

Prevent:

- overlapping API calls
- duplicate page certification
- duplicate queue entries
- repeated API requests with unchanged cumulative progress

If another qualifying page is finalized while a request is in progress, preserve the newest cumulative payload and send it after the current request completes.

---

## Fallback Sync

A five-minute timer may remain only as a fallback retry mechanism.

The fallback timer must not:

- certify the current unfinished page
- add partial dwell time
- send unchanged progress
- duplicate a page-turn request

Lifecycle events such as tab hidden, before unload, back to book, completion, and authentication recovery may retry queued progress. They must not certify the current page unless the user has actually left that page through the centralized page-finalization path.

---

## Failure Handling

If the API request fails:

1. Keep the newest cumulative payload in localStorage.
2. Do not roll back locally certified progress.
3. Do not mark the progress version as synchronized.
4. Retry on the next qualifying page turn.
5. Retry on supported lifecycle events.
6. Prefer sending the newest cumulative state instead of multiple stale snapshots.

Queue example:

```js
{
  synced: false,
  payload: { ... },
  pageContent: "First 20 chars...",
  progressVersion: 3,
  payloadHash: "...",
  reason: "qualifying-page-turn",
  queuedAt: "2026-04-19T09:20:00Z"
}
```

---

## Local Storage

### Session

Stored at:

```txt
ePubViewer:{bookId}:reading-history:session
```

The session is saved immediately after a page is successfully certified.

It should not update certified metrics merely because:

- a page was opened
- a timer started
- the minimum threshold was reached while the user was still reading
- a fallback interval elapsed
- an API request was attempted

### Queue

Stored at:

```txt
ePubViewer:{bookId}:reading-history:queue
```

The queue stores the newest unsynced cumulative payload and local debugging metadata.

### Debug pageContent

`pageContent` is stored only in:

- `reading-history:session`
- `reading-history:queue`

Formatting:

1. Get visible text from the certified page/location.
2. Trim leading and trailing whitespace.
3. Collapse multiple spaces/newlines into one space.
4. Store only the first 20 visible characters.

`pageContent` must not be sent to the backend and must not be used to calculate `pagesRead`, `minutesRead`, `completionPercentage`, or restore reading location.

---

## Diagnostic Logs

Temporary structured logs should be emitted during development:

- `PAGE_ENTERED`
- `PAGE_FINALIZING`
- `PAGE_CERTIFIED`
- `PAGE_REJECTED`
- `SESSION_SAVED`
- `SYNC_STARTED`
- `SYNC_SKIPPED`
- `SYNC_SUCCEEDED`
- `SYNC_FAILED`

These logs should include enough information to inspect location key, CFI, word count, dwell time, allowed reading window, rejection reason, cumulative metrics, progress version, and sync outcome.

---

## Source of Truth

The backend database is the long-term source of truth.

localStorage is a temporary cache and recovery mechanism for:

- preventing data loss during poor network conditions
- retrying failed syncs
- recovering unsynced progress after refresh
- debugging certified page/location state

The backend should be considered authoritative for:

- reading history
- completion tracking
- leaderboards
- achievements
- reading streaks

---

## Architecture Rules

- Keep reading-history logic inside `features/reading-history.js`.
- Do not modify `libs/epub.js`.
- Do not modify `features/speech.js`.
- Do not mix reading-history logic with highlight logic.
- Preserve iframe compatibility.
- Use iframe URL params for parent app data.
- Do not mark skipped pages as read.
- Do not count idle time as reading time.
- Do not create reader feature files outside `features/`.

---

## Acceptance Criteria

- Reader receives `bookId` from parent app.
- Reader receives `genre` from parent app.
- Reader gets `title` from EPUB metadata.
- Reader gets `author` from EPUB metadata.
- Reader tracks active reading time per rendered page/location.
- Opening a page does not immediately change certified progress.
- Reaching the minimum threshold does not certify the page before page exit.
- A page that satisfies the reading criteria is finalized when the user turns the page.
- A certified page adds verified time exactly once.
- `reading-history:session` updates immediately after certification.
- Cumulative API sync is attempted immediately after a qualifying page turn.
- A page that fails validation does not trigger an API request.
- Repeated relocation events do not double-count a page.
- Rapid navigation does not lose the previous page state.
- Failed API requests remain queued.
- Successful requests do not reset cumulative session totals.
- Fallback syncing does not create duplicate or unchanged requests.
- All navigation methods rely on EPUB relocation and the same finalization path.
