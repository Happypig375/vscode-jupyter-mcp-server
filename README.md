# Jupyter MCP Server

[![Marketplace version](https://vsmarketplacebadges.dev/version/Happypig375.vscode-jupyter-mcp-server.svg)](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs/Happypig375.vscode-jupyter-mcp-server.svg)](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server)
[![GitHub repository](https://img.shields.io/badge/GitHub-repo-blue.svg)](https://github.com/Happypig375/vscode-jupyter-mcp-server)

A **notebook-specific MCP server** that runs inside VS Code and lets an **external agentic harness** (Command Code CLI/desktop, Claude, etc.) **run, edit, create, and manage the Jupyter notebook the user is actively editing** — headlessly, with no approval dialogs, and no Copilot/Cursor dependency.

## The objective (and how it differs from similar projects)

This extension is built for one specific workflow: **an outside agent drives the notebook the human is looking at.** The agent connects over MCP, operates on the same in-memory `NotebookDocument` the user sees in the editor, and every change appears instantly with full undo/redo.

That objective drives every design choice:

- **External, harness-agnostic** — any MCP client works; nothing is tied to VS Code's Copilot Chat or Cursor agents. The tools use the VS Code notebook API directly — **no `vscode.lm.invokeTool`**, no Copilot-tool contributions, no approval dialogs, no chat-stream requirements ([microsoft/vscode#319094](https://github.com/microsoft/vscode/issues/319094) is why).
- **User-editing notebook as the source of truth** — tools target open `NotebookDocument`s, not `.ipynb` files on disk, so kernel state and unsaved edits are never out of sync.
- **Jupyter-optional** — kernel tools (`run_cells`, `restart_kernels`, `interrupt_kernels`) are only exposed when the Jupyter extension is installed; all document tools work with VS Code's native notebook support alone.
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

Batch-oriented tools accept arrays and are grouped by owning window; cell-oriented tools target one notebook URI or `notebookId` per call.

| Tool | Category | Description |
|---|---|---|
| `create_notebook` | Create | Create a new notebook (file in a workspace, or **untitled in an empty window**) and open it |
| `list_notebooks` | Read | List notebooks across connected windows with `uri`, `windowId`, `windowLabel`, and routable `notebookId` |
| `read_notebook` | Read | **Whole-notebook read** in one call: cell index, stable `cell_id` anchor, kind, language, source, execution state, optional outputs |
| `inspect_notebooks` | Read | Inspect cell metadata for one or more notebooks without returning source or output content |
| `read_cells` | Read | Read cell source by index or cell anchor, or read all cells |
| `read_cell_outputs` | Read | Read bounded `summary`, preferred-`text`, or all-text `full` output; binary images are summarized, never decoded |
| `search_cells` | Read | **Search** a notebook's cells (source + output text) for a query, with per-cell match locations; case-insensitive by default |
| `get_kernel_info` | Read | Get the active **kernel label** for a notebook (best-effort via the Jupyter extension) |
| `edit_cells` | Write | Insert/edit/delete cells in order; preserves existing metadata; optional explicit re-run (off by default) |
| `move_cells` | Write | Move one or more cells to a new position (preserves content/outputs/metadata) |
| `clear_cell_outputs` | Write | Clear saved outputs and execution state from one or more cells |
| `run_cells` | Execute | Run cells headlessly; wait for bounded text results or set `wait=false` to queue immediately; a wait timeout does not interrupt execution |
| `restart_kernels` | Manage | Restart the kernel of one or more notebooks |
| `interrupt_kernels` | Manage | **Interrupt** (stop) running execution in one or more notebooks |
| `open_notebooks` | Manage | Open existing notebooks from disk (file: URIs) |
| `save_notebooks` | Manage | Persist dirty notebooks to disk |
| `export_notebook` | Manage | Export a notebook to **markdown / python / html** |

### Jupyter-extension guard

Tools that require a **kernel** — `run_cells`, `restart_kernels`, and `interrupt_kernels` — are only exposed when the **Jupyter extension** (`ms-toolsai.jupyter`) is installed. The remaining tools work with VS Code's native notebook support alone.

## Recommended flow

1. `list_notebooks` → pick the notebook URI; use `notebookId` if that URI appears in multiple windows
2. `read_notebook` (or `inspect_notebooks`) → see the notebook's structure/state
3. `edit_cells` → write/change cells
4. `run_cells` → execute cells **headlessly** and get outputs back
5. `read_cell_outputs` (or `read_notebook` with outputs) → read results
6. `save_notebooks` → persist; `export_notebook` → share

## Why a VS Code extension?

Notebook execution, kernels, and the Jupyter extension's tools exist only inside the VS Code extension host. A standalone MCP process can't reach them. This extension is the bridge that lives inside VS Code and exposes them over MCP.

## Why native tools instead of forwarding Copilot's?

The VS Code notebook API covers all the functionality natively — cell execution (`notebook.execute`), reading cells/outputs (`cell.outputs`, `executionSummary`), kernel restart (`notebook.restartKernel`) — so the server implements everything itself. This avoids the problems with forwarding Copilot's tools via `vscode.lm.invokeTool`:
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
- Cell references use 0-based indices (`cellIds`) — after an edit, call `inspect_notebooks` for fresh indices.
- The HTTP transport supports multi-window routing; stdio remains scoped to the extension host that owns its process.
- Workspace-trust / tool-approval dialogs do **not** apply to these native tools (they use the VS Code notebook API, not `invokeTool`).

## License

MIT
