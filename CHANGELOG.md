# Changelog

## 0.2.1

- Added a single-port multi-window broker with private peer endpoints and heartbeat registration.
- Added automatic broker takeover on the same external port when the owner window closes.
- Added `notebookId` routing and explicit conflicts when the same URI is open in multiple windows.
- Grouped multi-notebook operations into one internal batch per owning window.
- Renamed public tools for clearer semantics: `get_notebooks` → `list_notebooks`, `get_cells` → `inspect_notebooks`, `get_cells_source` → `read_cells`, `get_cells_output` → `read_cell_outputs`, `clear_outputs` → `clear_cell_outputs`, and `restart_notebooks` → `restart_kernels`.
- Added dedicated tests for election, aggregation, duplicate disambiguation, cross-window routing, batching, and failover.

## 0.2.0

- Bound notebook output responses and avoid decoding binary images or duplicating rich display representations.
- Added output detail controls and nonblocking cell execution; execution wait timeouts no longer interrupt or report a kernel failure.
- Made notebook edits non-executing by default, preserved cell metadata, and corrected `TOP`/`BOTTOM` insertion positions.
- Made cell anchors read-only and corrected markdown execution-state reporting.
- Open notebooks visibly in the editor and report only notebooks routable by the current server window.
- Isolated integration tests on ephemeral ports to prevent collisions with a running production server.
- Reduced the status bar item to the notebook icon and `MCP`, with the server URL in its hover text.
