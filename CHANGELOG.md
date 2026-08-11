# Changelog

## 0.2.3

- Added provider-neutral `configure_kernel` to run Jupyter's configuration workflow before enumeration when a remote provider has not registered a concrete controller yet.

### Breaking changes

- None.

## 0.2.2

- Added `list_kernels` to enumerate exact VS Code notebook-controller ids, including kernels supplied through installed providers such as Colab.
- Added fail-closed `select_kernel` with explicit opt-in startup through Jupyter's notebook configuration tool.
- Preserved the legacy best-effort `run_cells.kernel` hint; callers that need exact fail-closed selection can call `select_kernel` first, then `run_cells` without a kernel hint.

### Breaking changes

- None. Existing `run_cells.kernel` callers retain their prior best-effort behavior; exact kernel selection is an opt-in addition.

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
