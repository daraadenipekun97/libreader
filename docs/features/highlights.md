# Highlights Feature

## Goal

Allow readers to highlight selected text, choose a highlight color, view all highlights in a list, and jump back to the exact highlighted location in the EPUB.

## User Flow

1. User selects text inside the EPUB reader.
2. A highlight toolbar appears.
3. User chooses a highlight color.
4. The selected text is highlighted.
5. The highlight is saved with its EPUB CFI location.
6. User opens the highlights panel.
7. User sees a list of highlighted text.
8. User clicks a highlight item.
9. Reader jumps to the exact EPUB location using the saved CFI.

## Requirements

### Highlight Creation

* Detect selected text inside the EPUB rendition.
* Capture the selected text.
* Capture the EPUB CFI range for the selection.
* Allow the user to choose a highlight color.
* Apply the highlight using epub.js annotations.
* Save the highlight locally.

## Selection Rule

The highlight feature must only activate when the user selects a group of text.

A single word selection should not trigger the highlight toolbar or create a highlight.

### Minimum Selection Requirement

 * A valid highlight selection must contain at least **3 words**.


### Highlight Colors

Supported colors:

* Yellow
* Green
* Blue
* Pink
* Purple

Each highlight record must store its selected color.

### Highlight Storage

Each highlight should be stored with:

```js
{
  id: "unique-highlight-id",
  bookId: "current-book-id",
  text: "selected highlighted text",
  cfiRange: "epubcfi(...)",
  color: "yellow",
  createdAt: "ISO date string"
}
```

Storage should be grouped per book so highlights from one book do not appear in another book.

### Highlight List

The reader must provide a highlights panel or sidebar.

Each item should show:

* Highlighted text
* Highlight color indicator
* Date created
* Delete option

When the user clicks a highlight item:

```js
rendition.display(highlight.cfiRange)
```

should move the reader back to the highlighted location.

### Highlight Rendering

When a book is opened or restored:

* Load saved highlights for the current book.
* Re-apply each highlight using epub.js annotations.
* Preserve the selected color.

### Delete Highlight

User should be able to delete a highlight.

Deleting should:

1. Remove the annotation from the EPUB view.
2. Remove the highlight from storage.
3. Remove it from the highlights list.

## Architecture Rules

* Do not modify `libs/epub.js`.
* Use epub.js annotations instead.
* Keep highlight logic separate from speech logic.
* Do not change `features/speech.js`.
* Do not introduce React, TypeScript, Vue, Angular, Vite, or Webpack.
* Preserve iframe compatibility.
* Preserve existing reader navigation and CFI behavior.
* All feature-specific JavaScript files must live inside `features/`.

## Suggested File Changes

Likely files:

* `script.js`
* `style.css`
* `index.html`
* `features/highlights.js`

Optional new file:

* `features/highlights.js`

Preferred approach:

Create or update `features/highlights.js` for highlight-specific logic. Future feature files, such as reader analytics or leaderboard code, should also live inside `features/`.

## epub.js APIs to Use

Use epub.js selection and annotations APIs where available:

```js
rendition.on("selected", function(cfiRange, contents) {
  // capture selected text
});
```

```js
rendition.annotations.highlight(
  cfiRange,
  {},
  callback,
  "highlight-class"
);
```

To jump to a highlight:

```js
rendition.display(cfiRange);
```

To remove a highlight:

```js
rendition.annotations.remove(cfiRange, "highlight");
```

## Acceptance Criteria

* User can select text.
* User can choose a highlight color.
* Highlight appears visually in the reader.
* Highlight survives page refresh.
* Highlight is restored when reopening the book.
* User can view all highlights for the current book.
* Clicking a highlight jumps to the correct EPUB location.
* User can delete a highlight.
* Existing speech feature still works.
* Existing navigation still works.
* Existing iframe embedding still works.

## Validation Checklist

After implementation, verify:

* EPUB opens normally.
* Text selection works.
* Highlight color selection works.
* Highlights are saved.
* Highlights restore after reload.
* Highlights list shows correct text.
* Clicking highlight jumps to correct page.
* Delete removes highlight.
* Speech still works.
* Reader still works inside iframe.
