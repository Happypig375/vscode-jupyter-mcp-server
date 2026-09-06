# Changelog

## 0.4.1

- Fixed `restart_kernels` and `interrupt_kernels` to use the Jupyter extension's current command ids and explicit notebook targets; responses now describe requests because provider confirmation or completion may not be observable.

## 0.4.0 (Unreleased)

- Added tracked `run_cells` executions with opaque execution IDs, bounded receipts, sequential background observation, duplicate protection, and safe recovery through the read-only `get_execution` tool.
- Execution status is tied to captured cell identity and source; edits, moves, closure, or unavailable observation stop safely without attributing stale outputs.
- Breaking: `read_notebook` is the sole public notebook reader, with outline/source/outputs/all views; the former inspect/source/output read tools were removed.
- Breaking: kernel file transfer calls the VS Code extension-host path `hostPath` and rejects the obsolete `localPath` field.
- Breaking: `run_cells` replaces `wait`/`timeoutMs` with a caller-only `waitMs` budget; `get_execution` provides read-only recovery, and cross-window operation transport supports hour-scale waits.

## 0.3.0

- Breaking: `list_notebooks` now returns grouped connected windows (including empty windows), with each notebook represented once by its URI and a short opaque deterministic `nb_...` `notebookRef`; the legacy composite `windowId::uri` `notebookId` contract is removed.
- Renamed public notebook targets to `notebookRef`/`notebookRefs`; `open_notebooks` now accepts `uris` and `windowId`.
- Added explicit `configure_kernel`; kernel listing is read-only and selection requires an exact id.
- Removed unsafe implicit kernel/start parameters and made tool validation reject unknown keys.
- Added bounded source reads and `edit_cells` exact-match `replace` edits.
- Added bounded `upload_file` and `download_file` through the public API of an existing idle Python kernel, with chunked transfer, size and SHA-256 verification, atomic promotion, and no-overwrite defaults.
- Reimplemented `clear_cell_outputs` with public notebook edits so clearing preserves cell identity, source, language, and metadata.

## 0.2.5

- Force-save file-backed notebooks on explicit `save_notebooks` calls even when VS Code incorrectly reports a remote-executed notebook as clean.
- Persist completed `run_cells` outputs and execution summaries before returning.
- Preserve and reveal an already-open live notebook when `open_notebooks` receives the same URI, instead of risking a disk-backed replacement.

### Breaking changes

- None.

## 0.2.4

- Added optional `list_kernels({ filePath, configure: true })` provider bootstrap, returning configuration status with the refreshed exact controller list. The default remains read-only.

### Breaking changes

- Removed the standalone `configure_kernel` tool. Migrate `configure_kernel({ filePath })` to `list_kernels({ filePath, configure: true })`.

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
