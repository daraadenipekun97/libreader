# Reading History Feature

## Goal

Track and save a user’s reading history for each book in the EPUB reader.

The reader is hosted at:

* `reada.mylibribooks.com`

The parent application is hosted at:

* `mylibribooks.com`

The reader runs inside an iframe.

---

## API Type

Reading history is saved using a `POST` request.

The reader should locally track reading activity during a session, then send a reading history payload to the backend at safe intervals and/or when the session ends.

---

## Payload

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
  completionPercentage: 0
}
```

---

## Data Sources

### bookId

`bookId` and `genre`  must come from the parent MyLibriBooks application.

Preferred methods:

1. Pass book data through the iframe URL 

Here is an example of the reader iframe URL `https://reada.mylibribooks.com/#bookUrl&bookId=123&genre=fiction`

bookUrl is used only for:

- fetch(bookUrl)
- ePubViewer.doBook(bookUrl)

bookId is used only for:

- reading history
- analytics
- leaderboard
- achievements

genre is used only for:

- reading history
- analytics
- recommendations

bookId and genre must never be appended to the fetch URL.

### title

Get from EPUB metadata in `onBookMetadataLoaded`.

### author

Get from EPUB metadata creator field in `onBookMetadataLoaded`.

### genre

Get from the parent application through iframe context.

---

## Session Rules

A session starts when:

* The book opens successfully.
* The reader receives valid book context.
* The user begins interacting with the reader.

For each reader open event, send:

```js
sessions: 1
```

The backend can aggregate total sessions per user and book.

---

## startedAt and finishedAt

### startedAt

Set when the reading session begins.

Example:

```js
startedAt = new Date().toISOString();
```

### finishedAt

Set when the session is saved, closed, or periodically synced.

Example:

```js
finishedAt = new Date().toISOString();
```

---

## minutesRead

Do not calculate `minutesRead` as:

```txt
finishedAt - startedAt
```

because this includes idle time.

Instead, calculate `minutesRead` from active verified reading time.

Only count time when:

* Reader tab is visible.
* Reader iframe is focused or recently interacted with.
* User remains on a location long enough for the page word count.
* User has not jumped/skipped through pages too quickly.

---

# Page Read Certification Algorithm

## Problem

EPUB pagination changes depending on:

* Screen size
* Font size
* Theme
* Line height
* Device orientation

Therefore, a static page count is unreliable.

The reader must certify pages based on visible reading locations and time spent.

---

## 1. Dynamic Visible Word Count

When `rendition.on("relocated")` fires:

1. Get the current location.
2. Identify the currently visible content.
3. Extract visible text from the iframe document.
4. Count words in the visible text.

Example:

```js
const words = visibleText
  .trim()
  .replace(/\s+/g, " ")
  .split(" ")
  .filter(Boolean);

const wordCount = words.length;
```

---

## 2. Adaptive Reading Speed Window

Use a reading-speed window to decide whether a page was reasonably read.

Constants:

```js
const MIN_READING_WPM = 100;
const MAX_READING_WPM = 500;
```

For a visible page with `W` words:

```js
minimumTimeSeconds = (W / MAX_READING_WPM) * 60;
maximumTimeSeconds = (W / MIN_READING_WPM) * 60;
```

A page should be certified as read only if the user stays on that page for at least `minimumTimeSeconds`.

If the user remains far beyond `maximumTimeSeconds`, cap the counted reading time to avoid counting idle time.

---

## 3. Active Viewport Verification

Only count reading time if:

* `document.visibilityState === "visible"`
* The reader iframe is active or recently interacted with.
* The EPUB view is currently displayed.
* The user has not rapidly skipped through multiple locations.

Do not count reading time when:

* Browser tab is hidden.
* User is idle for too long.
* User jumps rapidly through pages.
* User opens the table of contents and skips large sections.

---

## 4. Jump Detection

If the user jumps several pages or locations ahead instantly, skipped pages must not be marked as read.

Rules:

* A page is read only if its timer was completed.
* Navigating through a page without enough time does not count.
* TOC jumps should move location but not certify skipped pages.

---

## pagesRead

`pagesRead` should be the number of certified reading locations/pages.

A page/location is certified when:

1. It was visible.
2. It had measurable text.
3. User spent enough active time on it.
4. It passed the reading speed validation window.

---

## completionPercentage

Completion percentage should be based on certified read locations, not simple navigation progress.

Recommended formula:

```js
completionPercentage =
  (certifiedReadLocations / totalReadableLocations) * 100;
```

Round to nearest whole number.

Example:

```js
completionPercentage: 50
```

means the user has certified roughly 50% of readable book locations.

---

## Excluded Sections

Some book sections may be skipped without preventing completion.

Examples:

* Cover
* Copyright
* Dedication
* Acknowledgement
* Appendix
* Blank pages

The system should allow a completion buffer.

---

## Completion Rule

A book should be marked as completed only when both conditions are true:

### 1. Content Coverage

The user has certified at least 85% of readable locations.

```js
completionPercentage >= 85
```

### 2. Final Anchor Trigger

The user has actively reached and certified the final readable section of the book.

This prevents a user from reading only the beginning of a book and still being marked as complete.

---

## isCompleted

```js
isCompleted = completionPercentage >= 85 && finalAnchorCertified;
```

---

## Local Storage vs API

Use both.

### Local Storage

Use localStorage as a temporary cache.

Benefits:

* Prevents data loss during poor network conditions.
* Allows retry if API request fails.
* Supports immediate local recovery after refresh.

### API

Use the backend API as the permanent source of truth.

Benefits:

* Reading history follows the user across devices.
* Supports leaderboard.
* Supports reading analytics.
* Supports achievements and streaks.

Recommended flow:

1. Track reading locally.
2. Save session state to localStorage.
3. Send POST request to backend.
4. If request succeeds, clear synced local queue.
5. If request fails, keep local data and retry later.

---

## Suggested Files

Create:

```txt
features/analytics/
  reading-history.js
  reading-history-storage.js
  reading-history-api.js
```

Do not place analytics code directly in the root folder.

---

## Architecture Rules

* Do not modify `libs/epub.js`.
* Do not modify `features/speech/speech.js`.
* Do not mix analytics logic with highlight logic.
* Keep reading history inside `features/analytics/`.
* Preserve iframe compatibility.
* Use `postMessage` or iframe URL params for parent app data.
* Do not mark skipped pages as read.
* Do not count idle time as reading time.

---

## Acceptance Criteria

* Reader receives `bookId` from parent app.
* Reader receives `genre` from parent app.
* Reader gets `title` from EPUB metadata.
* Reader gets `author` from EPUB metadata.
* Reader tracks active reading time.
* Reader calculates certified pages read.
* Reader calculates completion percentage.
* Reader detects completed books.
* Reader saves reading history through POST request.
* Reader uses localStorage as fallback cache.
* Refreshing the page does not lose unsynced reading history.
* Skipped pages are not counted as read.
* Idle time is not counted as reading time.
