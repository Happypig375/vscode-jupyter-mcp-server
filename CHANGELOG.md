# Changelog

## 0.2.0

- Bound notebook output responses and avoid decoding binary images or duplicating rich display representations.
- Added output detail controls and nonblocking cell execution; execution wait timeouts no longer interrupt or report a kernel failure.
- Made notebook edits non-executing by default, preserved cell metadata, and corrected `TOP`/`BOTTOM` insertion positions.
- Made cell anchors read-only and corrected markdown execution-state reporting.
- Open notebooks visibly in the editor and report only notebooks routable by the current server window.
- Isolated integration tests on ephemeral ports to prevent collisions with a running production server.
- Reduced the status bar item to the notebook icon and `MCP`, with the server URL in its hover text.
