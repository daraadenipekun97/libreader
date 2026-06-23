# Known EPUB.js Customizations

This project uses a modified epub.js build.

Files:

- libs/epub.js
- libs/epub.orig.js

Purpose:

The modified version contains fixes required for compatibility with certain EPUB files.

Known change:

## Modified Area

`Path(pathString)` URL handling.

Current customization:

```js
protocol = pathString.indexOf("://");
if (protocol > -1) {
  try {
    pathString = new URL(pathString).pathname;
  } catch (e) {
    console.error("Invalid URL:", pathString);
  }
}

Original:

pathString = new URL(pathString).pathname;

Modified:

added a try catch block because some EPUB books failed to open when URL parsing occurred.

Before updating epub.js:

1. Compare against epub.orig.js
2. Preserve custom compatibility fixes
3. Test affected EPUB books