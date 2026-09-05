# Jupyter MCP Server

[![Marketplace version](https://vsmarketplacebadges.dev/version/Happypig375.vscode-jupyter-mcp-server.svg)](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/Happypig375.vscode-jupyter-mcp-server.svg)](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server)
[![GitHub repository](https://img.shields.io/badge/GitHub-repo-blue.svg)](https://github.com/Happypig375/vscode-jupyter-mcp-server)

A **notebook-specific MCP server** that runs inside VS Code and lets an **external agentic harness** (Command Code CLI/desktop, Claude, etc.) **run, edit, create, and manage the Jupyter notebook the user is actively editing** — headlessly, with no approval dialogs, and no Copilot/Cursor dependency.

## The objective (and how it differs from similar projects)

This extension is built for one specific workflow: **an outside agent drives the notebook the human is looking at.** The agent connects over MCP, operates on the same in-memory `NotebookDocument` the user sees in the editor, and every change appears instantly with full undo/redo.

That objective drives every design choice:

- **External, harness-agnostic** — any MCP client works; nothing is tied to VS Code's Copilot Chat or Cursor agents. Document editing and cell execution use the VS Code notebook API directly. Only explicit kernel configuration (`configure_kernel`) invokes Jupyter's contributed configuration tool.
- **User-editing notebook as the source of truth** — tools target open `NotebookDocument`s, not `.ipynb` files on disk, so tools operate on the live document. Saved outputs may remain stale until execution refreshes them.
- **Jupyter-backed** — the packaged extension declares `ms-toolsai.jupyter` as an extension dependency. Kernel tools are exposed when its runtime APIs are available; document tools use VS Code's native notebook support.
- **Deterministic, CI-friendly testing** — a shim-based MCP test suite with enforced coverage thresholds runs identically on every platform (no GUI, no VS Code download).

### How this compares to similar projects

| Extension | Approach | Objective | Notable features |
|---|---|---|---|
| [Notebook MCP for VS Code](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) | Daemon + per-window bridge workers, URI routing, operation-streaming | In-editor notebook agents (VS Code/Copilot ecosystem) | 19 tools; daemon routing; operation streaming; **source of the whole-notebook read, cell anchors, and export we adopted** |
| [Native Jupyter Notebook MCP Server](https://marketplace.visualstudio.com/items?itemName=olavovieiradecarvalho.notebook-mcp-server) ([repo](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp)) | In-extension MCP server, active-editor based | Same-space agents (Cursor/Claude) | 15 tools; output-capturing run; **source of our execution-wait + output-return pattern** |
| [Agentic Jupyter (MCP)](https://marketplace.visualstudio.com/items?itemName=koyo922.agentic-jupyter-mcp) ([repo](https://github.com/koyo922/agentic-jupyter-mcp)) | In-extension MCP server, stdio transport, active-tab based | IDE-sidebar agents (Cursor/Windsurf/Antigravity) | 4 tools (list/edit/insert/delete/run cell); stdio-only; targets the IDE's built-in agent sidebar rather than external harnesses |
| [mcp-jupyter-complete](https://github.com/tofunori/mcp-jupyter-complete) | File-based `.ipynb` editing + VS Code reload | File editing only | **Cannot execute** |
| [Jupyter MCP Server](https://github.com/datalayer/jupyter-mcp-server) | Standalone Jupyter Server API | Remote JupyterLab/JupyterHub | Separate server; second source of truth |
| **Jupyter MCP Server (this extension)** | In-extension single-port broker with per-window peers | **External agentic harness driving the user's live notebooks** | Automatic broker takeover; cross-window routing; duplicate-file disambiguation; bounded output-capturing run; deterministic coverage-gated CI |

We have deliberately **adopted the best ideas** from the closest projects — [output-capturing execution](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp), [whole-notebook reads and stable `cell_id` anchors](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) — while keeping our distinct objective: serving an **external** harness against the **user's live notebook**, with **no Copilot/Cursor dependency** and **Jupyter-optional** operation.

The VS Code Marketplace also lists generic "VS Code as an MCP server" extensions (e.g. [`juehang/vscode-mcp-server`](https://github.com/juehang/vscode-mcp-server), [`acomagu/vscode-as-mcp-server`](https://github.com/acomagu/vscode-as-mcp-server)) that expose file/shell/diagnostics tools for plain code editing. They are **not notebook-aware**: they treat `.ipynb` files as opaque JSON, have no cell/kernel/execution model, and cannot run or capture notebook cells — so they are out of scope for this comparison.

## Tools

Batch-oriented tools accept arrays and are grouped by owning window. Existing-notebook tools use `notebookRef` or `notebookRefs`, each accepting a URI or a window-qualified `notebookId` from `list_notebooks`. `open_notebooks` takes file URIs in `uris` plus an optional `windowId`; `create_notebook` takes `title`.

| Tool | Category | Description |
|---|---|---|
| `create_notebook` | Create | Create a new notebook (file in a workspace, or **untitled in an empty window**) and open it |
| `list_notebooks` | Read | List notebooks across connected windows with `uri`, `windowId`, `windowLabel`, and routable `notebookId` |
| `read_notebook` | Read | **Whole-notebook read** in one call: cell index, stable `cell_id` anchor, kind, language, source, execution state, optional outputs |
| `inspect_notebooks` | Read | Inspect cell metadata for one or more notebooks without returning source or output content |
| `read_cells` | Read | Read cell source by index or cell anchor, with optional 1-based inclusive `startLine`/`endLine` and `maxSourceChars` |
| `read_cell_outputs` | Read | Read bounded `summary`, preferred-`text`, or all-text `full` output; binary images are summarized, never decoded |
| `search_cells` | Read | **Search** a notebook's cells (source + output text) for a query, with per-cell match locations; case-insensitive by default |
| `get_kernel_info` | Read | Get active kernel label or language/status (best-effort via the Jupyter extension) |
| `list_kernels` | Read | List exact available kernel/controller ids; never configures providers |
| `configure_kernel` | Manage | Explicitly invoke provider configuration, which may require normal UI |
| `edit_cells` | Write | Insert/edit/delete cells in order, plus unique exact-text `replace`; preserves existing metadata; optional explicit re-run (off by default) |
| `move_cells` | Write | Move one or more cells to a new position (preserves content/outputs/metadata) |
| `clear_cell_outputs` | Write | Clear saved outputs and execution state from one or more cells |
| `run_cells` | Execute | Run cells headlessly; wait for bounded text results or set `wait=false` to dispatch immediately; dispatch does not guarantee queue admission; a wait timeout does not interrupt execution |
| `select_kernel` | Manage | Select only an exact id from `list_kernels` |
| `restart_kernels` | Manage | Restart the kernel of one or more notebooks |
| `interrupt_kernels` | Manage | **Interrupt** (stop) running execution in one or more notebooks |
| `open_notebooks` | Manage | Open file URIs; reveal and preserve the live model when already open |
| `save_notebooks` | Manage | Force-persist file-backed notebooks, including remote execution state |
| `upload_file` / `download_file` | Kernel transfer | Chunked, hashed transfer between the VS Code host and the current active idle Python kernel filesystem |
| `export_notebook` | Manage | Export a notebook to **markdown / python / html** |

### Jupyter-extension guard

Tools that require a **kernel** — `list_kernels`, `configure_kernel`, `select_kernel`, `run_cells`, `restart_kernels`, `interrupt_kernels`, `upload_file`, and `download_file` — are only exposed when the **Jupyter extension** (`ms-toolsai.jupyter`) is installed. The remaining tools work with VS Code's native notebook support alone.

### Optional provider integrations

The optional Google Colab VS Code extension (for example, locally installed `google.colab` 0.9.3) can contribute controllers through Jupyter. `upload_file` and `download_file` use only the public Jupyter kernel API and the filesystem belonging to the currently active idle Python kernel; they do not infer a remote provider, start a kernel, select a kernel, or provide dedicated Colab APIs. The kernel API may display a one-time authorization UI. `configure_kernel` may open the provider's normal UI. On 6 September 2026, live checks in an existing Colab Python session verified targeted cell execution, clearing two nonadjacent cells while preserving their sources and stable IDs, and a 524,425-byte MCP upload/download round trip with matching SHA-256 hashes. Initial provider discovery still required the normal Colab picker after a window reload.

After an extension upgrade, reconnect or refresh the MCP client's tool catalog if it still shows obsolete tool names or parameters. The server's current `tools/list` response is authoritative.

### Adjacent projects (checked 2026-09-06)

This bounded source comparison records documented interfaces; no competitor was installed or behaviorally tested. The [Microsoft Jupyter Extension API](https://github.com/microsoft/vscode-jupyter/wiki/Extension-API) and [kernel execution sample](https://github.com/microsoft/vscode-extension-samples/tree/main/jupyter-kernel-execution-sample) document kernel execution and server-provider integration. The [Colab VS Code guide](https://github.com/googlecolab/colab-vscode/wiki/User-Guide) documents remote providers, server lifecycle, resources, Drive, and context upload; this project consumes controllers through Jupyter rather than implementing those Colab management APIs.

The closest in-editor comparison is [vscode-inmemory-notebook-mcp](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp), which documents live multi-window URI routing, cell/range/all execution, and operation IDs with polling or streaming. [vscode-runtime-notebook-mcp](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp) embeds a VS Code Jupyter runtime for cell edits, execution, and outputs. [Agentic Jupyter MCP](https://marketplace.visualstudio.com/items?itemName=koyo922.agentic-jupyter-mcp) documents live IDE IPython operations and per-window routing. [mcp-jupyter-complete](https://github.com/tofunori/mcp-jupyter-complete) documents position-based edits and VS Code reload integration. The separate [Datalayer Jupyter MCP server](https://github.com/datalayer/jupyter-mcp-server) targets standalone Python/Jupyter Server workflows, including documented optional Colab sandbox support.

Adjacent Google projects take different boundaries: [Colab MCP](https://github.com/googlecolab/colab-mcp) targets browser Colab sessions and a local MCP client, while [Google Colab CLI](https://github.com/googlecolab/google-colab-cli) documents runtime, file, and execution CLI workflows. Generic [vscode-mcp-server](https://github.com/juehang/vscode-mcp-server) and [vscode-as-mcp-server](https://github.com/acomagu/vscode-as-mcp-server) document editor/file features; this comparison found no verified notebook/kernel contract for them. Future gaps here include operation IDs/polling/streaming and provider-specific management APIs.

## Recommended flow

1. `list_notebooks` → pick the notebook URI; use `notebookId` if that URI appears in multiple windows
2. `read_notebook` (or `inspect_notebooks`) → see the notebook's structure/state
3. `edit_cells` → write/change cells
4. `list_kernels` → enumerate exact ids read-only
5. `configure_kernel` → explicitly configure a provider when needed; `select_kernel` → choose an exact listed kernel id
6. `run_cells` → execute cells **headlessly**, get outputs back, and persist completed remote execution state
7. `read_cell_outputs` (or `read_notebook` with outputs) → read results
8. `save_notebooks` → persist file state; saved outputs can remain stale after edits until execution refreshes them; `export_notebook` → share

## Why a VS Code extension?

Notebook execution, kernels, and the Jupyter extension's tools exist only inside the VS Code extension host. A standalone MCP process can't reach them. This extension is the bridge that lives inside VS Code and exposes them over MCP.

## Why native tools instead of forwarding Copilot's?

The VS Code notebook API covers targeted cell execution (`notebook.cell.execute` with an explicit target editor and selected ranges), reading cells/outputs (`cell.outputs`, `executionSummary`), and kernel restart (`notebook.restartKernel`). Provider configuration delegates only the explicit `configure_kernel` call to Jupyter's contributed `configure_notebook` tool. Ambiguous targets fail closed.
- **Tool-approval dialogs** for execution tools invoked outside a live chat session (`chat.tools.autoApprove` doesn't suppress these — [microsoft/vscode#319094](https://github.com/microsoft/vscode/issues/319094))
- **Stream requirements** for interactive tools (edit/create need a chat stream)
- **Coupling** to Copilot Chat's tool contributions and their schemas

The native implementation is fully headless, self-contained, and works even if Copilot Chat's tools change.

## Multi-window broker and takeover

All VS Code windows on the machine share one externally visible HTTP URL. The first window to bind `jupyterMcp.port` becomes the broker; other windows register private loopback peer endpoints and send heartbeats. The broker aggregates their open notebooks and forwards operations to the owning extension host.

When the broker window closes, the surviving peers race safely for the same configured port. One becomes the replacement broker and the others reconnect. The external URL remains unchanged, although an MCP client with an existing connection may need to reconnect after the listener changes.

If the same notebook URI is open in two windows, `list_notebooks` returns two entries with distinct `notebookId` values. Passing the plain URI produces an explicit ambiguity error; passing a `notebookId` routes to the selected window. Multi-notebook operations are grouped into one internal batch per owning window.

## Install & run

1. **Install** the extension:
   - **Marketplace:** search for **Jupyter MCP Server** (publisher `Happypig375`) in the Extensions view, or [open the marketplace page](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server), or run `code --install-extension Happypig375.vscode-jupyter-mcp-server`. (Note: `datalayer` publishes a [similarly-named standalone Jupyter Server MCP](https://github.com/datalayer/jupyter-mcp-server) — this is the *VS Code in-extension* one.)
   - **Local build:** press **F5** in this repo for an Extension Development Host (works alongside the Jupyter extension `ms-toolsai.jupyter`).
2. **Check the `$(notebook) MCP` status item** (hover to see the URL; click to copy it) or the `Jupyter MCP Server` output channel, e.g. `MCP server listening on http://127.0.0.1:51303/mcp`.
3. **Add to Command Code**:
   ```bash
   cmdc mcp add --transport http jupyter http://127.0.0.1:51303/mcp
   ```
   (or stdio: set `jupyterMcp.transport` to `stdio` and `cmdc mcp add jupyter -- node <extension>/dist/extension.js`)

## Configuration

| Setting | Default | Description |
|---|---|---|
| `jupyterMcp.enabled` | `true` | Enable the MCP server |
| `jupyterMcp.transport` | `http` | `http` (Streamable HTTP on 127.0.0.1) or `stdio` |
| `jupyterMcp.port` | `51303` | Single loopback broker port shared by all local VS Code windows; machine-scoped and not synchronized by Settings Sync |
| `jupyterMcp.saveBeforeExecute` | `true` | Save dirty notebooks before run/edit |

## Testing

`npm test` runs two deterministic MCP integration suites plus a dedicated multi-window broker suite. The MCP suites exercise the exact public tool surface over real Streamable HTTP connections. The broker suite starts three independent window coordinators and verifies aggregation, duplicate-file conflicts, `notebookId` routing, per-window batching, and takeover of the same external port after the owner stops.

`npm run coverage` additionally measures coverage with **c8** (sourcemap-remapped to `src/**`, merged across both suites) and enforces thresholds (statements/lines ≥75%, branches ≥55%, functions ≥85%) via `src/test/checkCoverage.js`. Both are wired into **GitHub Actions CI** (`.github/workflows/ci.yml`, matrix: ubuntu/windows/macos).

## Notes / limitations

- Notebooks must be open in VS Code to be listed/read/edited (`list_notebooks` lists open ones).
- Requires the **Jupyter extension** (`ms-toolsai.jupyter`) for kernel-backed execution; `run_cells` uses the notebook's current kernel.
- `select_kernel.kernelId` requires an exact id returned by `list_kernels` and never falls back. `run_cells` has no kernel hint; select an exact id with `select_kernel` first.
- `configure_kernel` may require provider UI for server picker, authentication, consent, or runtime allocation. `list_kernels` remains read-only and `select_kernel` requires an exact listed id.
- Cell references use 0-based indices (`cellIds`) — after an edit, call `inspect_notebooks` for fresh indices.
- The HTTP transport supports multi-window routing; stdio remains scoped to the extension host that owns its process.
- Workspace-trust / tool-approval dialogs do **not** apply to these native tools (they use the VS Code notebook API, not `invokeTool`).

## License

MIT
