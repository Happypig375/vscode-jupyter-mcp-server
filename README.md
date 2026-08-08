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
- **Jupyter-optional** — kernel tools (`run_cells`, `restart_notebooks`, `interrupt_kernels`) are only exposed when the Jupyter extension is installed; all document tools (create, read, edit, move, open, save) work with VS Code's native notebook support alone, even in an **empty window with no workspace**.
- **Deterministic, CI-friendly testing** — a shim-based MCP test suite with enforced coverage thresholds runs identically on every platform (no GUI, no VS Code download).

### How this compares to similar projects

| Extension | Approach | Objective | Notable features |
|---|---|---|---|
| [Notebook MCP for VS Code](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) | Daemon + per-window bridge workers, URI routing, operation-streaming | In-editor notebook agents (VS Code/Copilot ecosystem) | 19 tools; daemon routing; operation streaming; **source of the whole-notebook read, cell anchors, and export we adopted** |
| [Native Jupyter Notebook MCP Server](https://marketplace.visualstudio.com/items?itemName=olavovieiradecarvalho.notebook-mcp-server) ([repo](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp)) | In-extension MCP server, active-editor based | Same-space agents (Cursor/Claude) | 15 tools; output-capturing run; **source of our execution-wait + output-return pattern** |
| [Agentic Jupyter (MCP)](https://marketplace.visualstudio.com/items?itemName=koyo922.agentic-jupyter-mcp) ([repo](https://github.com/koyo922/agentic-jupyter-mcp)) | In-extension MCP server, stdio transport, active-tab based | IDE-sidebar agents (Cursor/Windsurf/Antigravity) | 4 tools (list/edit/insert/delete/run cell); stdio-only; targets the IDE's built-in agent sidebar rather than external harnesses |
| [mcp-jupyter-complete](https://github.com/tofunori/mcp-jupyter-complete) | File-based `.ipynb` editing + VS Code reload | File editing only | **Cannot execute** |
| [Jupyter MCP Server](https://github.com/datalayer/jupyter-mcp-server) | Standalone Jupyter Server API | Remote JupyterLab/JupyterHub | Separate server; second source of truth |
| **Jupyter MCP Server (this extension)** | In-extension MCP server + multi-window registry | **External agentic harness driving the user's live notebook** | Jupyter-optional; empty-window create; deterministic coverage-gated CI; 17 tools incl. output-capturing run, whole-notebook read, search, kernel info, cell anchors, export |

We have deliberately **adopted the best ideas** from the closest projects — [output-capturing execution](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp), [whole-notebook reads and stable `cell_id` anchors](https://github.com/vatsapatel/vscode-inmemory-notebook-mcp) — while keeping our distinct objective: serving an **external** harness against the **user's live notebook**, with **no Copilot/Cursor dependency** and **Jupyter-optional** operation.

The VS Code Marketplace also lists generic "VS Code as an MCP server" extensions (e.g. [`juehang/vscode-mcp-server`](https://github.com/juehang/vscode-mcp-server), [`acomagu/vscode-as-mcp-server`](https://github.com/acomagu/vscode-as-mcp-server)) that expose file/shell/diagnostics tools for plain code editing. They are **not notebook-aware**: they treat `.ipynb` files as opaque JSON, have no cell/kernel/execution model, and cannot run or capture notebook cells — so they are out of scope for this comparison.

## Tools

All tools are **multi-capable** (they take arrays; a single operation is a 1-element array) — no separate singular/plural variants.

| Tool | Category | Description |
|---|---|---|
| `create_notebook` | Create | Create a new notebook (file in a workspace, or **untitled in an empty window**) and open it |
| `get_notebooks` | Read | List open notebooks **across all VS Code windows** (`windowId`/`windowLabel` for disambiguation) |
| `read_notebook` | Read | **Whole-notebook read** in one call: cell index, stable `cell_id` anchor, kind, language, source, execution state, optional outputs |
| `get_cells` | Read | **Metadata** for one or more notebooks (cell kind, language, lines, execution state, output mime types) — no content |
| `get_cells_source` | Read | Read the **source** of cells (by index or `cell_id` anchor, or all) |
| `get_cells_output` | Read | Read saved **outputs** of cells (all items, decoded) |
| `search_cells` | Read | **Search** a notebook's cells (source + output text) for a query, with per-cell match locations; case-insensitive by default |
| `get_kernel_info` | Read | Get the active **kernel label** for a notebook (best-effort via the Jupyter extension) |
| `edit_cells` | Write | Insert/edit/delete cells in order; optional per-edit metadata; optional re-run |
| `move_cells` | Write | Move one or more cells to a new position (preserves content/outputs/metadata) |
| `clear_outputs` | Write | Clear saved **outputs** (and execution state) from one or more cells |
| `run_cells` | Execute | Run one or more cells **headlessly**, in order, **waiting for completion and returning parsed outputs** (text/error/image); optional `kernel` to select before running |
| `restart_notebooks` | Manage | Restart the kernel of one or more notebooks |
| `interrupt_kernels` | Manage | **Interrupt** (stop) running execution in one or more notebooks |
| `open_notebooks` | Manage | Open existing notebooks from disk (file: URIs) |
| `save_notebooks` | Manage | Persist dirty notebooks to disk |
| `export_notebook` | Manage | Export a notebook to **markdown / python / html** |

### Jupyter-extension guard

Tools that require a **kernel** — `run_cells`, `restart_notebooks`, and `interrupt_kernels` — are only exposed when the **Jupyter extension** (`ms-toolsai.jupyter`) is installed. The remaining tools work with VS Code's **native notebook support alone**, so an **empty VS Code window with no workspace and no Jupyter extension can still create a notebook from scratch** and edit/read it. Install the Jupyter extension to unlock kernel-backed execution.

## Recommended flow

1. `get_notebooks` → pick the notebook URI
2. `read_notebook` (or `get_cells` metadata) → see the notebook's structure/state
3. `edit_cells` → write/change cells
4. `run_cells` → execute cells **headlessly** and get outputs back
5. `get_cells_output` (or `read_notebook` with outputs) → read results
6. `save_notebooks` → persist; `export_notebook` → share

## Why a VS Code extension?

Notebook execution, kernels, and the Jupyter extension's tools exist only inside the VS Code extension host. A standalone MCP process can't reach them. This extension is the bridge that lives inside VS Code and exposes them over MCP.

## Why native tools instead of forwarding Copilot's?

The VS Code notebook API covers all the functionality natively — cell execution (`notebook.execute`), reading cells/outputs (`cell.outputs`, `executionSummary`), kernel restart (`notebook.restartKernel`) — so the server implements everything itself. This avoids the problems with forwarding Copilot's tools via `vscode.lm.invokeTool`:
- **Tool-approval dialogs** for execution tools invoked outside a live chat session (`chat.tools.autoApprove` doesn't suppress these — [microsoft/vscode#319094](https://github.com/microsoft/vscode/issues/319094))
- **Stream requirements** for interactive tools (edit/create need a chat stream)
- **Coupling** to Copilot Chat's tool contributions and their schemas

The native implementation is fully headless, self-contained, and works even if Copilot Chat's tools change.

## Multi-window merge

Multiple VS Code windows running this extension with the same `port` setting **merge into one MCP server**:

- The first window binds the port and serves; later windows detect `EADDRINUSE` and **merge** (register in a shared registry, serve nothing locally).
- `get_notebooks` returns notebooks from the owning window **plus** all registered windows (with `windowId`/`windowLabel`).
- **When the same file is open in multiple windows**, the model should disambiguate (e.g. ask which window) before targeting operations; cell operations run in the window that owns the notebook.
- When the owning window closes, the registry heartbeat lets another window take over on its next attempt.

## Install & run

1. **Install** the extension:
   - **Marketplace:** search for **Jupyter MCP Server** (publisher `Happypig375`) in the Extensions view, or [open the marketplace page](https://marketplace.visualstudio.com/items?itemName=Happypig375.vscode-jupyter-mcp-server), or run `code --install-extension Happypig375.vscode-jupyter-mcp-server`. (Note: `datalayer` publishes a [similarly-named standalone Jupyter Server MCP](https://github.com/datalayer/jupyter-mcp-server) — this is the *VS Code in-extension* one.)
   - **Local build:** press **F5** in this repo for an Extension Development Host (works alongside the Jupyter extension `ms-toolsai.jupyter`).
2. **Check the output channel** `Jupyter MCP Server` for the URL, e.g. `MCP server listening on http://127.0.0.1:51303/mcp`.
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
| `jupyterMcp.port` | `51303` | Fixed port; multiple windows sharing it merge into one server |
| `jupyterMcp.saveBeforeExecute` | `true` | Save dirty notebooks before run/edit |

## Testing

`npm test` runs **two deterministic MCP integration suites** (`src/test/mcp.test.js` + `src/test/mcp.jupyter.test.js`): they load the compiled extension bundle with a `vscode` shim and exercise every tool over a **real MCP HTTP connection** (connect → `tools/list` → `tools/call`). The first suite models an **empty window** (no workspace, no Jupyter) and asserts the tool set (kernel tools absent) plus every document operation; the second models **Jupyter present** and covers `run_cells` (output capture), `read_notebook`, `export_notebook`, `search_cells`, `clear_outputs`, `get_kernel_info`, `interrupt_kernels`, and `cell_id` anchors.

`npm run coverage` additionally measures coverage with **c8** (sourcemap-remapped to `src/**`, merged across both suites) and enforces thresholds (statements/lines ≥75%, branches ≥55%, functions ≥85%) via `src/test/checkCoverage.js`. Both are wired into **GitHub Actions CI** (`.github/workflows/ci.yml`, matrix: ubuntu/windows/macos).

## Notes / limitations

- Notebooks must be **open in VS Code** to be listed/read/edited (`get_notebooks` lists open ones). Creating a new notebook works from the workspace (or as an untitled notebook in an empty window).
- Requires the **Jupyter extension** (`ms-toolsai.jupyter`) for kernel-backed execution; `run_cells` uses the notebook's current kernel.
- Cell references use 0-based indices (`cellIds`) — after an edit, re-fetch `get_cells` for fresh indices.
- Workspace-trust / tool-approval dialogs do **not** apply to these native tools (they use the VS Code notebook API, not `invokeTool`).

## License

MIT
