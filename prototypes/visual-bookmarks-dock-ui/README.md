# Visual Bookmarks dock UI prototype

Standalone interactive prototype for the next visual-bookmarks interface.

## Included interactions

- Movable folder dock that snaps to the left, right, or bottom edge.
- Ten-item folder previews arranged as two rows by five columns.
- Single-click folder navigation and double-click inline folder rename.
- One-click folder deletion with a six-second undo action.
- New-folder creation and inline naming.
- Hover-only bookmark deletion with a six-second undo action.
- Ctrl/Cmd or Shift multi-select, then drag the selected group into a folder.
- Website domain inside the visual card and bookmark title underneath.
- Website screenshot reveal on hover with favicon fallback.
- Search, appearance settings, and Edge/Chrome bookmark import.

## Verification

Validated in Chrome-compatible Playwright at 1440×900 and 848×643. The flows above were exercised end to end, including hover delete/undo, modifier-key multi-select, group drag/drop, rename, search, import-modal access, hover previews, and all three dock positions.

Open `index.html` directly or serve this directory with any static HTTP server.
