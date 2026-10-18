# 0.4.5 cell-reference and kernel-reporting repair

Implementation commit `dc4c8e6` on branch `fix/cell-id-restart-reporting` is under review in draft [PR #2](https://github.com/Happypig375/vscode-jupyter-mcp-server/pull/2).

The repair gives JSON string cell references exact-ID precedence before the compatible numeric-string index fallback; JSON numbers remain indices. It documents the existing insert-after-anchor behavior. Kernel restart now refuses an explicitly absent active kernel, exposes bounded URL-redacted provider-command failures, and reports the current observation without claiming asynchronous completion or selecting another kernel. Empty provider error payloads receive an explicit explanation.

Final source checks passed:

- `npm run typecheck`
- `npm test`: 36 no-Jupyter checks, 41 Jupyter checks, three broker checks, metadata checks, 65,568,700-byte synthetic and real-Python native round trips, and a 1,420,000-byte real-Python kernel-route round trip
- `npm run coverage`: 95.02% statements, 76.61% branches, 95.27% functions, and 95.02% lines
- `git diff --check`

The locally packaged `vscode-jupyter-mcp-server-0.4.5.vsix` is 307,388 bytes with SHA-256 `084a30dcab80f5a7d610ff1d8a07fdc6bf8cda19ae6de2ee0cc1effdbba08097`; its package and manifest versions are both 0.4.5. The ignored VSIX was not installed or published, the extension was not reloaded, and this revision has not touched a live notebook or kernel. Installation and live smoke checks remain separate acceptance steps.
