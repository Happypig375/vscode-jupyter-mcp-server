# 0.4.5 cell-reference and kernel-reporting repair

Implementation commit `dc4c8e6` on branch `fix/cell-id-restart-reporting` is under review in draft [PR #2](https://github.com/Happypig375/vscode-jupyter-mcp-server/pull/2).

The repair gives JSON string cell references exact-ID precedence before the compatible numeric-string index fallback; JSON numbers remain indices. It documents the existing insert-after-anchor behavior. Kernel restart now refuses an explicitly absent active kernel, exposes bounded URL-redacted provider-command failures, and reports the current observation without claiming asynchronous completion or selecting another kernel. Empty provider error payloads receive an explicit explanation.

## Worker software validation

The repair worker completed these isolated source checks before installation:

- `npm run typecheck`
- `npm test`: 36 no-Jupyter checks, 41 Jupyter checks, three broker checks, metadata checks, 65,568,700-byte synthetic and real-Python native round trips, and a 1,420,000-byte real-Python kernel-route round trip
- `npm run coverage`: 95.02% statements, 76.61% branches, 95.27% functions, and 95.02% lines
- `git diff --check`

The locally packaged `vscode-jupyter-mcp-server-0.4.5.vsix` is 307,388 bytes with SHA-256 `084a30dcab80f5a7d610ff1d8a07fdc6bf8cda19ae6de2ee0cc1effdbba08097`; its package and manifest versions are both 0.4.5. The worker did not install, publish, or live-test the VSIX.

## Parent live verification — 18 October 2026

The parent subsequently installed that exact VSIX, reloaded VS Code, and confirmed `happypig375.vscode-jupyter-mcp-server@0.4.5` through the extension CLI. Immediately after reload, the public Jupyter API reported no active kernel. The parent then used VS Code's native kernel picker to select Colab, the existing Colab CPU runtime, and the starred existing Python 3 session for `Charging_Insights.ipynb`; MCP did not select or start a replacement kernel. New definition and computation executions 83 and 84 accessed globals from the prior process, providing bounded continuity evidence for that restored session.

A live 0.4.5 `read_notebook` request using string cell ID `"40025805"` returned the exact cell with `cell_id` `"40025805"` at index 120. The supporting receipts are `AGENTS/local/insight_mining_20261018/mcp_045*` and `mcp_reload_action.json` in the HKUST analysis repository. This verifies the numeric-only ID fix on the installed extension; it does not independently exercise every cell-consuming tool or the restart failure branches.

The final cold notebook run under 0.4.5 remains pending. The extension has not been published to Marketplace, and no cold-run completion is claimed here.
