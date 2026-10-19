# Changelog

## 0.5.0

- Detect failed Colab extension activation before opening its picker, including a cached failure in an extension reported as active. Return a sanitized activation blocker with normal recovery guidance.

- Add `mount_colab_server` recovery for a previously generated Colab alias when its Python kernel is already active but the filesystem was not mounted. The tracked operation neither starts/selects a kernel nor runs cells or creates servers, and requires an exact new or uniquely named existing mount plus fresh same-kernel verification. Setup receipts retain the generated alias after later failures.

- Bind the uniquely identified VS Code owner window and recheck its marker before opening the first Colab picker. Native input actions validate and submit in that exact renderer without depending on operating-system foreground focus.

- Add Colab initialization with `configure_kernel({ notebookRef, runtime: "colab" })`: create a standard CPU server through the installed Colab 0.9.7 picker, pause for an explicit kernel choice, run/remove an owned temporary startup cell, mount the same server and verify runtime/filesystem identity. An already active verified Colab runtime is reused.
- Use VS Code's native Chromium/smoke-test driver without Orca. Require an explicitly configured loopback debugging port (or `JUPYTER_MCP_NATIVE_DEBUG_PORT` supplied at app launch), bind the exact window marker and picker, and fail safely on unavailable or unsupported UI. The app must have started with the debugging port; a window reload cannot enable it.
- Add `list_setup_kernels` and `select_setup_kernel`. Listing observes actual choices from the exact setup-owned picker without selecting a default. Selection accepts only one ID from the latest listing, rechecks the picker, and requires VS Code's kernel-selection acknowledgement before startup. Cancellation and a closed provider picker cannot silently continue setup.
- Add tracked `get_kernel_setup` and `cancel_kernel_setup`, bounded waits/deadline, exact-window marker binding, cross-window desktop exclusion, and explicit retained-cell/server/cleanup status. Normal sign-in/consent/MFA and unsupported UI remain blockers; no authentication bypass or private credential access.
- Add `check_colab`: verify the current idle Python kernel against the active Colab filesystem using a fresh private nonce, validate Linux/Python/Colab module diagnostics, and confirm cleanup through both surfaces. Missing, ambiguous, stale, busy, replaced, or unresponsive runtimes fail without a verified result. Verification applies only at the time of the call.
- Response format change: generic `configure_kernel` now returns structured JSON observations instead of provider prose. Text claiming successful startup no longer becomes a success claim when the public API exposes no active kernel. An observed kernel still requires a responsiveness/provider check.
- Select exact controller IDs through the public `notebook.selectKernel` command with the actual target editor, avoiding selection in a different active notebook.

## 0.4.5

- Resolve string cell references as stable IDs before retaining the numeric-string index fallback. Numeric-only native IDs such as `"40025805"` now work consistently in editing, reading, execution, search, output clearing, and movement; JSON numbers remain 0-based indices.
- Document the existing `edit_cells` insertion contract: numeric indices and stable IDs are anchors after which the new cell is inserted, while `TOP` and `BOTTOM` select the boundaries.
- Refuse `restart_kernels` when the public Jupyter API explicitly reports no active kernel, surface provider command failures (including bounded, URL-redacted status details), and report the post-command active-kernel observation without claiming completion or selecting another kernel.
- Replace empty notebook-provider error payloads such as `Error: :` with an explicit bounded explanation.

## 0.4.4

- Stop kernel-route transfers from growing kernel memory. IPython caches the source of every executed request in `linecache` for the kernel's lifetime, even outside history; with the previous triple encoding each 256 KiB upload chunk left about 622 KB there (12.4 MB after 20 chunks in IPython 8.24 and 9.16). Every transfer request now starts with a tag and removes earlier tagged sources, including IPython 7's `_ipython_cache`; a real-Python replay through IPython retains 0 bytes.
- Send each upload chunk's payload once as a base64 literal instead of nesting it in base64-encoded JSON inside base64-encoded source (about 1.33x instead of 2.4x), and zlib-compress chunks in both directions when that saves at least 10% (CSV-like chunks shrink roughly twelvefold).
- Refuse further chunk transfers on a kernel object after 64 MiB of chunk traffic, before dispatch, with guidance to use the native Colab file service or restart the kernel. Live Colab runtimes were lost after roughly 90-150 MB of chunk traffic.
- Report kernel-side exceptions (for example a missing destination directory) by exception class instead of a generic receipt failure.

## 0.4.3

- Route files above 4 MiB through Colab's registered Contents filesystem, with a 64 MiB cap, instead of encoding their payload into repeated kernel executions. Both upload and download support the optional exact `colabFileUri`; otherwise large transfers discover mounted/open Colab roots.
- Prove each native route against a random file created in the selected kernel before transferring payloads. Keep kernel-side SHA-256 verification, atomic promotion, no-overwrite defaults and kernel replacement checks.
- Bound native filesystem waits to two minutes and quarantine unfinished I/O. Failed native binding never falls back to large kernel execution. `get_kernel_info` exposes unverified Colab root candidates without connecting or executing.
- Add a 65,568,700-byte synthetic round trip and real-Python/local-filesystem regression covering checksum rejection, destination preservation and URI mismatch. Subsequent 14 October live Colab validation passed at this size in both directions, plus a 62,572,000-byte upload, with the same process remaining responsive. These checks do not establish the cause of the earlier runtime loss or reliability across every runtime/network.

## 0.4.2

- Fixed `edit_cells` metadata persistence: nbformat cell metadata is written inside VS Code's native metadata envelope so presentation fields, tags, and source-hiding settings survive notebook serialization. Existing cell IDs, attachments, and execution counts remain separate.

- Bound file-transfer kernel lookups/executions to 60 seconds and remote cleanup to five seconds; stalled iterators no longer keep the tool request pending indefinitely.
- Revalidate the original active idle kernel before every transfer execution, reject competing transfers, cap receipt output, and quarantine unfinished kernel executions until their iterators close.
- Preserve uncertain upload outcomes and skip remote cleanup when execution has not settled. MCP client cancellation forwarding remains a separate routing limitation.

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
