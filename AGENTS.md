# Agent contract

## Ownership

- `src/server.ts`, `src/schema.ts`, `src/localOperations.ts`, `src/extension.ts`, and `src/broker.ts` define the MCP boundary and routing.
- `src/notebookOps.ts` owns VS Code notebook operations.
- `src/test/mcp.test.js` covers the public boundary, `src/test/broker.test.ts` covers multi-window routing, and `src/test/mcp.jupyter.test.js` covers Jupyter-backed integration behavior.

## Authoritative 0.3.0 contract

Existing-notebook tools use `notebookRef` for one target and `notebookRefs` for multiple targets. A ref is a URI or a window-qualified `notebookId` from `list_notebooks`. `open_notebooks` accepts actual file URIs in `uris` and an optional `windowId`. `create_notebook` accepts `title`.

Tool schemas are strict. Unknown or obsolete keys fail validation. `list_kernels` is read-only; provider setup is explicit through `configure_kernel`; `select_kernel` accepts only an exact listed id. `run_cells` has no kernel hint. User supplied runtime selection takes precedence over defaults.

Source line bounds are 1-based and inclusive, and explicit source truncation is reported. Saved outputs can remain stale after edits; execution refreshes observed output state. File transfer uses only the public API of the current active idle Python kernel, is bounded and chunked, and never starts or selects a kernel.

The `notebook.cell.execute` command is invoked with an explicit target editor and selected cell ranges. Runtime selection supplied by the user takes precedence; missing or ambiguous targets fail closed rather than opening or transferring another notebook.

When the README comparison changes, recheck the linked primary sources and record the check date. Keep coverage bounded and do not repeat a full survey without a changed question or source.

## Safe development

Run `npm run typecheck` and `npm run compile` for structural checks. `npm test` runs the MCP, Jupyter integration, and compiled broker suites; isolate the broker with `npm run compile:test; node .vscode-test/broker.test.cjs` when needed. Do not dump credentials, raw notebook contents, or account fields. Changes, installs, and releases remain within the user-authorized scope.
