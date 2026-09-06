# Jupyter MCP Server

[![Marketplace version](https://vsmarketplacebadges.dev/version/Happypig375.vscode-jupyter-mcp-server.svg)](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/Happypig375.vscode-jupyter-mcp-server.svg)](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server)
[![GitHub repository](https://img.shields.io/badge/GitHub-repo-blue.svg)](https://github.com/Happypig375/vscode-jupyter-mcp-server)

A notebook-specific MCP server that runs inside VS Code. An external MCP client can inspect, edit, execute, create, export, and manage notebooks open in the VS Code windows the user is working in. It has no dependency on Copilot Chat or Cursor. Notebook document operations use VS Code's native API; kernel operations require the installed `ms-toolsai.jupyter` extension.

## Install and connect

1. Install **Jupyter MCP Server** (publisher `Happypig375`) from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server), or run `code --install-extension Happypig375.vscode-jupyter-mcp-server`.
2. Check the `$(notebook) MCP` status item and copy its URL, or use the output channel. The default endpoint is `http://127.0.0.1:51303/mcp`.
3. Configure the external client to use Streamable HTTP and that copied endpoint.

The tool contract below describes 0.4.0; see the [changelog](CHANGELOG.md) for earlier versions. After an upgrade, refresh or reconnect the client's MCP tool catalog if it still advertises old parameters. The connected server's `tools/list` response is authoritative.

## How this project differs

The design is an in-extension broker over the user's live, shared in-memory `NotebookDocument`. Windows register as peers, duplicate URIs are disambiguated with short opaque `notebookRef` handles, and one broker port is taken over safely if its owner closes. The decisions below explain which documented ideas we adopted and which remain outside this project's boundary.

| Design or workflow | This project's decision, benefit, and tradeoff | Relevant comparison |
|---|---|---|
| Shared live notebook document | **Adopted.** Read and edit VS Code's current document, including unsaved changes. The agent and user share notebook state; the notebook must be open in VS Code. | [vscode-inmemory-notebook-mcp](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) also supports live notebooks and external clients. [mcp-jupyter-complete](https://github.com/tofunori/mcp-jupyter-complete) uses file edits and reloads; [Datalayer](https://github.com/datalayer/jupyter-mcp-server) supports standalone Jupyter Server workflows. |
| Window routing | **Implemented inside the extension host.** One window owns the broker, peers can take over its port, and short refs distinguish the same URI in different windows. This avoids a separate daemon process. | [vscode-inmemory-notebook-mcp](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) uses a daemon with per-window bridge workers. |
| Long-running execution | **Adopted for 0.4.0.** `run_cells` returns an `executionId`; `get_execution` follows that same run after a wait budget expires or `waitMs: 0` returns immediately. | The operation-ID and polling pattern comes from [vscode-inmemory-notebook-mcp](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp). |
| Pushed output streaming | **Not implemented.** Bounded polling serves request/response clients. Pushed events would add client notification support and event-history management that this workflow does not require. | [vscode-inmemory-notebook-mcp](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) documents polling and streaming. |
| Cell locking | **Not implemented.** The server checks explicit targets and execution freshness without imposing an edit-ownership policy on the user and agent. Locking would require a separate coordination policy. | [vscode-inmemory-notebook-mcp](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) exposes cell-lock tools. |
| Per-run interruption | **Not implemented as an isolated cancellation tool.** `interrupt_kernels` explicitly requests a kernel-wide interrupt; stopping observation of a run does not prove its code stopped. | This server's [interrupt implementation](src/notebookOps.ts) uses the notebook kernel command. |
| Provider startup and administration | **Generic Jupyter integration; no dedicated Colab adapter.** Reuse registered controllers and normal provider setup. The checked Colab extension exposes no public connect/start API for an adapter to call. Dedicated provisioning, Drive, terminal, and resource-management tools are not implemented. | [Google Colab MCP](https://github.com/googlecolab/colab-mcp) bridges browser sessions; [Colab CLI](https://github.com/googlecolab/google-colab-cli) manages runtimes and files. The [Colab VS Code guide](https://github.com/googlecolab/colab-vscode/wiki/User-Guide) documents its own setup and administration. |

Whole-notebook reads, cell anchors, and export were inspired by [vscode-inmemory-notebook-mcp](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp); the execution-wait and output-capture pattern came from [vscode-runtime-notebook-mcp](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp).

Sources and repository documentation were checked on 2026-09-06. This is a bounded, documentation-scoped comparison; it does not claim competitor installation or behavioral testing.

## Tools

Existing-notebook tools use `notebookRef`, or `notebookRefs` for a batch. Prefer the short ref from `list_notebooks`; a plain URI is also accepted when it identifies one open notebook. `open_notebooks` accepts file URIs in `uris` and an optional `windowId`; `create_notebook` accepts `title` and an optional `windowId`.

Cell references accept zero-based indices or the `cell_id` returned by a read. Prefer real cell IDs; an `index:N` fallback can change after insertion, deletion, or movement. Notebook refs remain valid across cell edits and resolve only against currently open notebooks.

| Tool | Category | Description |
|---|---|---|
| `create_notebook` | Create | Create a workspace file or an untitled notebook in an empty window and open it |
| `list_notebooks` | Read | List grouped connected windows, including empty windows, with `windowId`, `windowLabel`, URI, and routable `notebookRef` |
| `read_notebook` | Read | Read an `outline` by default, or select `source`, `outputs`, or `all`; optionally target `cellIds` |
| `search_cells` | Read | Search cell source and output text with match locations |
| `get_kernel_info` | Read | Report observed active runtime fields and explicit unavailable reasons |
| `get_execution` | Read | Inspect a tracked `executionId`, or recover the notebook's latest run; optionally wait for its result |
| `list_kernels` | Read | List exact registered kernel/controller IDs; read-only |
| `configure_kernel` | Manage | Invoke Jupyter's provider configuration tool; normal picker/auth/consent UI may appear |
| `edit_cells` | Write | Insert, edit, delete, or exact-text replace cells; optional explicit rerun |
| `move_cells` | Write | Move cells while preserving content, outputs, and metadata |
| `clear_cell_outputs` | Write | Clear outputs and execution state |
| `run_cells` | Execute | Start a tracked, ordered run; `waitMs` bounds the caller's wait, and observation continues independently |
| `select_kernel` | Manage | Select an exact ID from `list_kernels`; no fallback or start |
| `restart_kernels` | Manage | Request notebook-kernel restarts; provider confirmation may be required |
| `interrupt_kernels` | Manage | Request kernel interrupts; completion cannot be confirmed |
| `open_notebooks` | Manage | Open file URIs, preserving an existing live model |
| `save_notebooks` | Manage | Persist file-backed notebooks, including remote execution state |
| `upload_file` / `download_file` | Kernel transfer | Chunked, hashed transfer between `hostPath` on the VS Code host and `kernelPath` in the active idle Python kernel |
| `export_notebook` | Manage | Export as markdown, Python, or HTML |

### Reading without excess output

`read_notebook` returns notebook and cell metadata in every view. `source` adds source text, `outputs` adds saved output, and `all` adds both within the requested limits. Source slicing uses 1-based inclusive `startLine` and `endLine`; `maxSourceChars` defaults to 12,000 per cell, with `0` requesting unbounded source explicitly. Truncation is reported.

For outputs, `outputMode` selects `summary`, preferred `text`, or `full` textual representations. `maxOutputChars` bounds each cell's returned output. Binary images are summarized rather than decoded. Saved output can be stale after an edit; saving does not refresh it.

### Jupyter and providers

The package declares `ms-toolsai.jupyter` as a dependency. Kernel-backed tools (`list_kernels`, `configure_kernel`, `select_kernel`, `run_cells`, restart/interrupt, and file transfer) are registered when that extension is present; presence does not guarantee every runtime API is available. `get_kernel_info` and `get_execution` remain exposed for read-only diagnostics.

`list_kernels` lists currently registered controllers, including those contributed by other extensions; it does not discover every dormant provider. `configure_kernel` explicitly delegates setup to Jupyter and may display a picker, authentication, or consent UI. `select_kernel` requires an exact listed ID. Inspection, listing, and file transfer do not start or select a kernel. File transfer requires the public API of an active idle Python kernel; see Microsoft's [kernel execution and authorization sample](https://github.com/microsoft/vscode-extension-samples/tree/main/jupyter-kernel-execution-sample).

`restart_kernels` and `interrupt_kernels` request state changes through Jupyter's provider commands. A provider can display confirmation UI or acknowledge the command before the kernel state changes, so their responses report requests rather than confirmed completion. Use `get_kernel_info`, `get_execution`, or notebook inspection to observe subsequent state where available.

The optional Colab VS Code extension contributes controllers through Jupyter. On 2026-09-06, MCP server 0.3.0 with `google.colab` 0.9.3 passed live checks for targeted execution, nonadjacent output clearing, and a 524,425-byte upload/download round trip with matching SHA-256 hashes in an existing Colab Python session. Initial discovery used the normal Colab picker. This is evidence for that tested integration, not a claim that every Colab feature is MCP-integrated.

A bootstrap adapter was considered on the same date. The installed 0.9.3 command manifest has no connect/start command; current upstream [activation](https://github.com/googlecolab/colab-vscode/blob/main/src/extension.ts) returns no extension API, and Auto Connect is handled inside the [Jupyter provider](https://github.com/googlecolab/colab-vscode/blob/main/src/jupyter/provider.ts). The browser-focused Colab MCP server does not expose that VS Code provider.

Jupyter's [public API](https://github.com/microsoft/vscode-jupyter/blob/main/src/api.d.ts) lets an extension register its own server collection, but does not expose other extensions' provider instances. Its `kernels.getKernel` returns already-started kernels for open notebooks. The internal [`jupyter.kernel.selectJupyterServerKernel`](https://github.com/microsoft/vscode-jupyter/blob/main/src/notebooks/controllers/kernelSource/kernelSourceCommandHandler.ts) command accepts an extension ID, provider ID, and notebook, then invokes the normal server/kernel selector; it has no argument for choosing a server or provider action. The older [`addRemoteJupyterServer`](https://github.com/microsoft/vscode-jupyter/blob/main/src/standalone/api/unstable/index.ts) API is deprecated and rejects callers outside Codespaces. These routes do not provide unattended Colab bootstrap.

Providers can mark a sole setup command `canBeAutoSelected`, but the checked Colab provider does not use that option. A provider API for listing existing runtimes and connecting to an explicit runtime would justify an optional MCP adapter. Until such a route exists, initial Colab setup can still require user interaction; wrapping its picker would not remove that requirement.

## Recommended flow

1. Call `list_notebooks` and select a `notebookRef`.
2. Read its outline, then request `view: "source"` for the cells needed. Edit cells and refresh indices or fallback anchors after structural changes.
3. If a kernel must be chosen, list its registered controllers and select an exact ID. Configure the provider explicitly when necessary.
4. Call `run_cells`. `waitMs` defaults to 1,000; zero returns immediately, and larger values can wait for long jobs. This is a request wait budget, not an execution time limit. A returned ID or dispatch status does not prove execution started.
5. If the run is unfinished, call `get_execution` with that ID. Its `waitMs` defaults to zero and also supports long waits. A client may impose a shorter request timeout; neither that timeout nor an expired wait budget interrupts execution. Omit the ID to recover the latest tracked run after a lost response.
6. Read results and save edits or export the notebook. Completed background runs persist file-backed outputs, including remote results; untitled notebooks are not force-saved.

Runs submit cells in order and stop after an observed failure. Only one tracked run is active per notebook, with at most 16 active runs per window and 256 cells per run. The registry retains at most 32 notebooks and eight runs per notebook; terminal records expire after one hour and can be evicted earlier at capacity. Active runs have no one-hour expiry. Returned execution output is capped at 12,000 characters per cell and 48,000 per receipt. `run_cells` includes output by default; `get_execution` includes it only with `includeOutputs: true`. Lookup requires an open notebook, and records do not survive an extension reload. `saveBeforeExecute` pre-saves dirty notebooks before edit, move, or run; use `save_notebooks` to persist subsequent edits.

Tracking observes cell identity, source, execution summaries, and restart/interrupt requests made through MCP. Restarts initiated outside those tools are detected only when VS Code exposes corresponding cell or lifecycle changes. An `unavailable` result means completion could not be confirmed; it does not establish that the kernel stopped.

### Updating clients from 0.3.0

- Replace `inspect_notebooks`, `read_cells`, and `read_cell_outputs` with the appropriate `read_notebook` view.
- Replace `run_cells.wait` and `timeoutMs` with the single `waitMs` budget, then follow `executionId` with `get_execution`.
- Replace file transfer's `localPath` with `hostPath`, which names a path on the VS Code extension host.

Obsolete keys and tools are rejected; refresh the client's tool catalog after upgrading.

## Multi-window routing

All windows share the configured loopback HTTP URL. The first window binds the broker; others register private loopback peers. If the broker closes, a peer can take over the same port. A URI that is ambiguous across windows fails; use the listed ref. Multi-notebook operations are grouped by owner.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `jupyterMcp.enabled` | `true` | Enable the server |
| `jupyterMcp.transport` | `http` | Streamable HTTP on loopback; `stdio` is scoped to the extension host and has no standalone Node launcher |
| `jupyterMcp.port` | `51303` | Shared machine-scoped broker port |
| `jupyterMcp.saveBeforeExecute` | `true` | Pre-save dirty notebooks before edit, move, or run |

## Development and testing

Install dependencies with `npm ci`, then run `npm run typecheck` and `npm run compile`. Press **F5** to open an Extension Development Host.

`npm test` compiles the extension and runs the MCP boundary, Jupyter integration, broker, and kernel-file suites. `npm run coverage` merges their c8 coverage and enforces statements/lines >=75%, branches >=55%, and functions >=85%. The tests use shims without downloading VS Code; live provider checks are separate. CI runs on Ubuntu, Windows, and macOS.

## License

MIT
