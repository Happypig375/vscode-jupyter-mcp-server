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

### Final cold run under 0.4.5

The final live sequence used the same notebook reference. `restart_kernels` returned an observed `restarting` status while explicitly withholding completion; a subsequent `get_kernel_info` observation reported the kernel active and idle. The setup cell then completed as execution 1, followed by all remaining 82 code cells in notebook order as executions 2 through 83.

The resulting notebook has 155 cells, 83 code cells, zero recorded errors, and 36 figures. All 36 figure bytes match the first cold run. All nine new public result sections reproduce exactly, and all prior numerical objects match; the retained parity record separately identifies the final-support protocol/key-label update and the added `late_growth` result without treating those labels as numerical changes.

The 680,836-byte compressed public aggregate transferred through the bounded kernel-execution route with SHA-256 `4580d800d33c3adee56fd7799f1171466725caab32f4c629e09ca44db68c428f`. Its 7,412,029-byte decompressed JSON has SHA-256 `8143366225794a1e93fa10751aaf581516a1f7a44f9b60101df61c1d61be9eb7`.

The supporting HKUST-repository receipts are `cold_v2_restart_01_response.json`, `cold_v2_kernel_info_02_response.json`, `cold_v2_setup_observe_01_response.json`, `cold_v2_observe_05_response.json`, `cold_notebook_v2_verification.json`, `cold_v2_transfer_verification.json`, and the public `analysis/decision_followthrough_2026_10_18/cold_run_v2_parity.json`. The earlier failed restart and stalled local configure helper remain preserved in that record and are not reclassified as 0.4.5 successes. The extension has not been published to Marketplace.
