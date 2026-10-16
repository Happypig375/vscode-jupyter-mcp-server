# Agent contract

## Ownership

- `src/server.ts`, `src/schema.ts`, `src/localOperations.ts`, `src/extension.ts`, and `src/broker.ts` define the MCP boundary and routing.
- `src/notebookOps.ts` owns VS Code notebook operations.
- `src/test/mcp.test.js` covers the public boundary, `src/test/broker.test.ts` covers multi-window routing, and `src/test/mcp.jupyter.test.js` covers Jupyter-backed integration behavior.

## Authoritative 0.4.0 contract

Existing-notebook tools use `notebookRef` for one target and `notebookRefs` for multiple targets. A ref is a direct URI or a short opaque `nb_` handle from `list_notebooks`; handles resolve only against currently open notebooks. `list_notebooks` returns grouped connected windows, including empty groups. `open_notebooks` accepts actual file URIs in `uris` and an optional `windowId`. `create_notebook` accepts `title`.

Tool schemas are strict. Unknown or obsolete keys fail validation. `list_kernels` is read-only; provider setup is explicit through `configure_kernel`; `select_kernel` accepts only an exact listed id. `run_cells` has no kernel hint. User supplied runtime selection takes precedence over defaults.

`edit_cells.edits[].metadata` is nbformat cell metadata. Inserts store it inside VS Code's native `cell.metadata.metadata`; edits/replacements shallow-merge that nested map while preserving the native envelope's cell ID, attachments, execution count, and other fields. Metadata tests must verify serialized `.ipynb` fields, not only successful edits or in-memory values.

Source line bounds are 1-based and inclusive, and explicit source truncation is reported. Saved outputs can remain stale after edits; execution refreshes observed output state. File transfer requires the public API of the current active idle Python kernel and never starts or selects a kernel. Files above 4 MiB use Colab's registered public filesystem provider, with a 64 MiB buffer cap and a kernel-created nonce proving the selected runtime before payload I/O. Smaller files retain bounded kernel chunks unless native transfer is explicitly selected. A chunk request carries its payload once (base64, zlib when it saves at least 10%), and every transfer request purges earlier tagged request sources from IPython's `linecache` (including IPython 7's `_ipython_cache`) so kernel memory does not grow with transferred bytes. Keep the per-kernel 64 MiB chunk-traffic budget; refuse before dispatch rather than risk the runtime. Never fall back to a large kernel transfer when native binding fails. Timeout/cancellation does not prove native filesystem I/O stopped; quarantine pending I/O and preserve uncertainty.

The `notebook.cell.execute` command is invoked with an explicit target editor and selected cell ranges. Runtime selection supplied by the user takes precedence; missing or ambiguous targets fail closed rather than opening or transferring another notebook.

`run_cells` creates a tracked execution before dispatch and returns a JSON receipt containing an opaque `executionId`, `status`, and bounded per-cell state. `waitMs` only bounds the caller's wait and never cancels the sequential background runner; its default is 1000, while `get_execution` defaults to 0 and is read-only. Both accept non-negative safe-integer waits, including hour-scale workflows. A run is retained only for the current extension-window lifetime, with at most one active run per notebook, bounded global active work, and bounded terminal history/retention. Cell identity and source hashes are captured at request time; edits, moves, deletion, closure, MCP-issued kernel restart/interrupt, or unavailable observation stop later submission safely.

When the README comparison changes, recheck the linked primary sources and record the check date. Keep coverage bounded and do not repeat a full survey without a changed question or source.

## Safe development

Run `npm run typecheck` and `npm run compile` for structural checks. `npm test` runs the MCP, Jupyter integration, and compiled broker suites; isolate the broker with `npm run compile:test; node .vscode-test/broker.test.cjs` when needed. Do not dump credentials, raw notebook contents, or account fields. Changes, installs, and releases remain within the user-authorized scope.
