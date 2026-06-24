# Architecture

## Reader Flow

MyLibroBooks
        │
        ▼
iframe
        │
        ▼
reada.mylibribooks.com
        │
        ▼
index.html
        │
        ├── script.js
        │      ├── Book Loading
        │      ├── Navigation
        │      ├── Search
        │      ├── Themes
        │      └── Settings
        │
        ├── features/speech.js
        │      ├── EasySpeech
        │      ├── Voice Selection
        │      ├── Read Aloud
        │      └── Pause / Resume
        │
        └── epub.js
               ├── Rendering
               ├── Locations
               ├── CFI
               └── EPUB Parsing
