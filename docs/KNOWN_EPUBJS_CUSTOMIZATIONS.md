# Known EPUB.js Customizations

This project uses a modified version of epub.js.

## Files

* `libs/epub.js` — Active customized version
* `libs/epub.orig.js` — Original vendor version used for comparison

## Purpose

The customized version contains compatibility fixes required for certain EPUB files that fail to load correctly with the original epub.js implementation.

---

## Customization: Path(pathString) URL Handling

### Original Code

```js
protocol = pathString.indexOf("://");
if (protocol > -1) {
    pathString = new URL(pathString).pathname;
}
```

### Modified Code

```js
protocol = pathString.indexOf("://");
if (protocol > -1) {
    try {
        pathString = new URL(pathString).pathname;
    } catch (e) {
        console.error("Invalid URL:", pathString);
    }
}
```

### Reason for Change

Some EPUB books contain malformed or non-standard URL references that cause:

```js
new URL(pathString)
```

to throw an exception.

When this occurs, the original epub.js implementation stops processing and the book fails to open.

The try/catch block prevents the reader from crashing when invalid URLs are encountered and allows the EPUB loading process to continue.

### Observed Behavior

* Original implementation: Certain EPUB books failed to open.
* Modified implementation: The affected books load successfully while invalid URLs are logged to the console.

---

## Rules for Future Updates

Before modifying or replacing `libs/epub.js`:

1. Compare changes against `libs/epub.orig.js`.
2. Preserve all existing compatibility fixes.
3. Test EPUB loading with previously affected books.
4. Verify that valid EPUB files continue to load normally.
5. Document any additional epub.js customizations in this file.

---

## Notes

`libs/epub.js` should not be treated as a standard vendor dependency because it contains project-specific compatibility fixes.
