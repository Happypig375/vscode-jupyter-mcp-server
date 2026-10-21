import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonSchemaToZod } from './schema';
import { NotebookRouter } from './broker';
import { OutputMode } from './notebookOps';
import { LocalOperation } from './localOperations';
import { z } from 'zod';
async function invokeMany(router: NotebookRouter, operation: LocalOperation, notebookRefs: string[]): Promise<string> {
    return router.invokeNotebooks(operation, notebookRefs);
}
/** Register the notebook MCP server's tools on a given McpServer. */
export function registerNotebookTools(server: McpServer, router: NotebookRouter, hasJupyter: boolean): void {
    server.registerTool('inspect_colab_environment_preflight', {
        description: 'Read a bounded, app-wide Colab environment preflight across connected VS Code peers. Reports only counts, boolean state, sanitized process/install/version corroboration, loopback native-listener candidates, blocker codes, and the currently supported next operation. It never exposes document contents, terminal commands/history/environment, broad launch arguments, authentication state, or exact peer-to-app-window mapping; it does not save, close, focus, reload, restart, or select a runtime.',
        inputSchema: jsonSchemaToZod({ type: 'object', properties: {} })
    }, async () => {
        return { content: [{ type: 'text' as const, text: await router.inspectColabEnvironmentPreflight() }] };
    });
    server.registerTool('list_colab_terminals', {
        description: 'Inspect integrated terminals in one VS Code window before Colab environment preparation. Returns short-lived opaque references and bounded metadata, never commands, history or environment. This cannot establish that a shell is idle or owned by the caller. No terminal is closed.',
        inputSchema: jsonSchemaToZod({ type: 'object', properties: {
            windowId: { type: 'string', description: 'Optional destination windowId from list_notebooks.' }
        } })
    }, async (args) => {
        const a = (args ?? {}) as { windowId?: string };
        const text = await router.invokeWindow('list_colab_terminals', {}, a.windowId);
        return { content: [{ type: 'text' as const, text }] };
    });
    server.registerTool('close_colab_terminals', {
        description: 'Close only explicitly selected terminals from the latest list_colab_terminals inventory in the same window. Closing may terminate commands and discard terminal scrollback: use only for terminals whose closure is authorized. This never infers idleness or ownership, and never closes all terminals implicitly. Stale or changed targets fail before closure; the result preserves partial or uncertain closure. Retry prepare_colab_environment only after confirmed closure.',
        inputSchema: jsonSchemaToZod({ type: 'object', properties: {
            inventoryId: { type: 'string', description: 'Exact inventoryId from the latest list_colab_terminals result (expires after 60 seconds).' },
            terminalRefs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32, uniqueItems: true, description: 'Explicit terminal references from that inventory, whose closure is authorized.' },
            windowId: { type: 'string', description: 'Destination windowId used for the inventory.' }
        }, required: ['inventoryId', 'terminalRefs'] })
    }, async (args) => {
        const a = args as { inventoryId: string; terminalRefs: string[]; windowId?: string };
        const text = await router.invokeWindow('close_colab_terminals', { inventoryId: a.inventoryId, terminalRefs: a.terminalRefs }, a.windowId);
        return { content: [{ type: 'text' as const, text }] };
    });
    server.registerTool('prepare_colab_environment', {
        description: 'Prepare a local VS Code desktop window for native Colab setup before opening a notebook. The default path retains the clean-empty-window workflow. Optional restartMode restore-clean-workspace handles exactly one clean, trusted, configured local Workspace on the pinned default Windows build; an actual normal-quit restore additionally requires disconnected kernels and no active work. It snapshots only resource identities and bounded registry metadata, never content, and does not close, save or discard work. This prepares only the desktop environment, never a kernel.',
        inputSchema: jsonSchemaToZod({ type: 'object', properties: {
            windowId: { type: 'string', description: 'Optional destination windowId from list_notebooks.' },
            folderUri: { type: 'string', description: 'Optional file URI of an existing local project folder. In restored mode it must match an existing Workspace root and never causes conversion.' },
            restartMode: { type: 'string', enum: ['restore-clean-workspace'], description: 'Optional configured-Workspace recovery mode. Omit to preserve the existing empty-window route.' }
        } })
    }, async (args) => {
        const a = (args ?? {}) as { windowId?: string; folderUri?: string; restartMode?: 'restore-clean-workspace' };
        const text = await router.invokeWindow('prepare_colab_environment', { folderUri: a.folderUri, restartMode: a.restartMode }, a.windowId);
        return { content: [{ type: 'text' as const, text }] };
    });
    server.registerTool('get_colab_environment_preparation', {
        description: 'Read a durable Colab desktop preparation receipt, including after an app restart. Route to the exact workspace/window identified by the receipt. Readiness requires that workspace and a fresh native connection check; runtimeReady remains false until configure_kernel/check_colab verifies Colab.',
        inputSchema: jsonSchemaToZod({ type: 'object', properties: {
            preparationId: { type: 'string', description: 'Exact preparationId returned by prepare_colab_environment.' },
            windowId: { type: 'string', description: 'Optional destination windowId from list_notebooks.' }
        }, required: ['preparationId'] })
    }, async (args) => {
        const a = args as { preparationId: string; windowId?: string };
        const text = await router.invokeWindow('get_colab_environment_preparation', { preparationId: a.preparationId }, a.windowId);
        return { content: [{ type: 'text' as const, text }] };
    });
    // All tools are multi-capable (arrays); single-use is a 1-element array.
    // Document and execution operations use the native VS Code notebook API.
    //
    // Tools that require a kernel (run, restart) are only registered when the
    // Jupyter extension (ms-toolsai.jupyter) is installed; the rest work with
    // VS Code's native notebook support alone (e.g. an empty window creating a
    // notebook from scratch).
    // ---- Create ----
    server.registerTool(
        'create_notebook',
        {
            description:
                'Create a new Jupyter notebook and open it in a connected VS Code window. ' +
                'By default the broker window is used; pass a windowId from list_notebooks to choose another window.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Notebook title.' },
                    windowId: { type: 'string', description: 'Optional destination windowId from list_notebooks.' }
                },
                required: ['title']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { title?: string; windowId?: string };
            const msg = await router.invokeWindow('create_notebook', { title: a.title ?? 'New notebook' }, a.windowId);
            return { content: [{ type: 'text' as const, text: msg }] };
        }
    );
    // ---- Get notebooks ----
    server.registerTool(
        'list_notebooks',
        {
            description:
                'List notebooks grouped by connected VS Code window. Each group includes windowId and windowLabel once, ' +
                'and notebooks containing uri plus a short opaque notebookRef. Empty connected windows are included. ' +
                'Use notebookRef for stable routing when the same URI is open in more than one window.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {} })
        },
        async () => {
            return { content: [{ type: 'text' as const, text: JSON.stringify(await router.listNotebooks()) }] };
        }
    );
    // ---- Clear outputs ----
    server.registerTool(
        'clear_cell_outputs',
        {
            description:
                'Clear the saved OUTPUT of one or more cells in a notebook (removes outputs and execution state). ' +
                'Provide the notebook URI and an array of 0-based numeric indices or exact string cell IDs.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based numeric indices or exact string cell IDs; numeric strings fall back to indices when no ID matches.' }
                },
                required: ['notebookRef', 'cellIds']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; cellIds?: Array<string | number> };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
            const text = await router.invokeNotebook('clear_cell_outputs', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
    // ---- Get kernel info ----
    server.registerTool(
        'get_kernel_info',
        {
            description:
                'Get active kernel runtime information via the public Jupyter API; unavailable identity and unchecked file-transfer access are reported explicitly. ' +
                'Use list_kernels for exact ids accepted by select_kernel; run_cells has no kernel hint.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' }
                },
                required: ['notebookRef']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            const text = await router.invokeNotebook('get_kernel_info', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
    // ---- List/select kernels (requires Jupyter) ----
    if (hasJupyter) {
        server.registerTool(
            'list_kernels',
            {
                description:
                    'List the exact kernel/controller ids currently available to a notebook. This operation is read-only. ' +
                    'Use configure_kernel for Jupyter provider setup; providers such as Colab may show normal UI. ' +
                    'Pass one returned id to select_kernel.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },

                    },
                    required: ['notebookRef']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { notebookRef?: string };
                if (!a.notebookRef) throw new Error('notebookRef is required');
                const text = await router.invokeNotebook('list_kernels', a.notebookRef, a as Record<string, unknown>);
                return { content: [{ type: 'text' as const, text }] };
            }
        );

        server.registerTool('configure_kernel', {
            description: 'Set up the exact notebook. runtime colab uses the bounded local VS Code Chromium adapter to request a Standard CPU server, or selects one exact prior MCP serverAlias without creating another server, then pauses for an explicit list_setup_kernels and select_setup_kernel choice. After exact VS Code selection it runs/removes a temporary pass cell, mounts its filesystem, and verifies both surfaces with a fresh nonce. An already active verified matching runtime is reused. Poll get_kernel_setup or cancel_kernel_setup. No automatic kernel choice, alias fallback, local/GPU/paid-upgrade fallback, or caller-side click. The generic default invokes Jupyter setup without claiming runtime readiness.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {
                notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                runtime: { type: 'string', enum: ['generic', 'colab'], description: 'Requested runtime. Use colab for automatic Colab setup; generic is the compatibility default.' },
                serverAlias: { type: 'string', description: 'Colab only: optional exact prior MCP-generated alias matching m followed by eight lowercase hexadecimal characters. Selects that existing server and never creates a fallback.' },
                waitMs: { type: 'number', description: 'Colab only: wait 0–60000 ms for a setup receipt (default 1000). The bounded background setup continues after this request returns.' }
            }, required: ['notebookRef'] })
        }, async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; runtime?: 'generic' | 'colab'; serverAlias?: string; waitMs?: number };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            const text = await router.invokeNotebook('configure_kernel', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        });

        server.registerTool('mount_colab_server', {
            description: 'Recover filesystem mounting for an already selected active idle Python Colab kernel. Accepts only an exact MCP-generated serverAlias from a prior setup receipt, mounts that exact existing server without selecting or starting a kernel or creating a server, and requires fresh same-kernel filesystem verification. Poll or cancel the returned setupId with get_kernel_setup/cancel_kernel_setup.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {
                notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                serverAlias: { type: 'string', description: 'Exact prior MCP-generated alias matching m followed by eight lowercase hexadecimal characters.' },
                waitMs: { type: 'number', description: 'How long to wait for a receipt (default 1000, maximum 60000); mounting continues in the tracked setup.' }
            }, required: ['notebookRef', 'serverAlias'] })
        }, async (args) => {
            const a = args as { notebookRef: string; serverAlias: string; waitMs?: number };
            const text = await router.invokeNotebook('mount_colab_server', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        });

        for (const operation of ['get_kernel_setup', 'cancel_kernel_setup'] as const) server.registerTool(operation, {
            description: operation === 'get_kernel_setup'
                ? 'Read the current or specified Colab setup receipt without dispatching setup. Readiness is point-in-time evidence from its completed nonce check.'
                : 'Cancel an in-progress Colab setup and close its owned picker. Does not delete an assigned server or interrupt scientific cells. Non-cancellable provider assignment may still finish; the receipt reports retained startup cells or pending cleanup.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {
                notebookRef: { type: 'string' }, setupId: { type: 'string', description: 'Optional exact setupId; otherwise most recent setup for this notebook.' },
                waitMs: { type: 'number', description: 'Wait 0–60000 ms for the receipt (default 0).' }
            }, required: ['notebookRef'] })
        }, async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; setupId?: string; waitMs?: number };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            return { content: [{ type: 'text' as const, text: await router.invokeNotebook(operation, a.notebookRef, a as Record<string, unknown>) }] };
        });

        server.registerTool('list_setup_kernels', {
            description: 'List the bounded kernel choices currently shown by one exact Colab setup after its owned CPU server is created. This is read-only UI observation tied to setupId. It is separate from list_kernels, which lists already registered VS Code controllers. A fresh call invalidates ids from an earlier setup-choice listing.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {
                notebookRef: { type: 'string', description: 'Exact notebook URI or notebookRef owned by the setup.' },
                setupId: { type: 'string', description: 'Exact active setupId returned by configure_kernel.' }
            }, required: ['notebookRef', 'setupId'] })
        }, async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; setupId?: string };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            if (!a.setupId) throw new Error('setupId is required');
            return { content: [{ type: 'text' as const, text: await router.invokeNotebook('list_setup_kernels', a.notebookRef, a as Record<string, unknown>) }] };
        });

        server.registerTool('select_setup_kernel', {
            description: 'Select one exact kernelChoiceId from the latest list_setup_kernels result for the same notebook and setupId. No default is selected. The setup then requires VS Code to confirm selection before its owned startup cell, mount, and nonce verification continue. This is separate from select_kernel for already registered controller ids.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {
                notebookRef: { type: 'string', description: 'Exact notebook URI or notebookRef owned by the setup.' },
                setupId: { type: 'string', description: 'Exact active setupId returned by configure_kernel.' },
                kernelChoiceId: { type: 'string', description: 'Exact id from the latest list_setup_kernels call for this setup.' },
                waitMs: { type: 'number', description: 'Wait 0–60000 ms for a later setup receipt (default 1000). The bounded setup continues after this request returns.' }
            }, required: ['notebookRef', 'setupId', 'kernelChoiceId'] })
        }, async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; setupId?: string; kernelChoiceId?: string; waitMs?: number };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            if (!a.setupId) throw new Error('setupId is required');
            if (!a.kernelChoiceId) throw new Error('kernelChoiceId is required');
            return { content: [{ type: 'text' as const, text: await router.invokeNotebook('select_setup_kernel', a.notebookRef, a as Record<string, unknown>) }] };
        });

        server.registerTool('check_colab', {
            description: 'Verify the current active idle Python kernel against Colab\'s native filesystem with a fresh nonce and a bounded runtime probe. Creates and removes one tiny temporary file; does not select or start a kernel, edit notebook cells, install packages, or read user data. A label, installed module or mounted folder alone cannot pass. Verification is for this call only.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {
                notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                colabFileUri: { type: 'string', description: 'Optional exact colab://server/ root with no query or fragment. Otherwise one mounted/open Colab root is required. The root must match a fresh nonce in the selected kernel.' }
            }, required: ['notebookRef'] })
        }, async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; colabFileUri?: string };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            const text = await router.invokeNotebook('check_colab', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        });

        server.registerTool(
            'select_kernel',
            {
                description:
                    'Select an exact kernel id returned by list_kernels for a notebook. Provider setup is handled separately by configure_kernel. ' +
                    'Fails instead of falling back when the id is unavailable or selection is rejected.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                        kernelId: { type: 'string', description: 'Exact id returned by list_kernels.' }
                    },
                    required: ['notebookRef', 'kernelId']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { notebookRef?: string; kernelId?: string };
                if (!a.notebookRef) throw new Error('notebookRef is required');
                if (!a.kernelId) throw new Error('kernelId is required');
                const text = await router.invokeNotebook('select_kernel', a.notebookRef, a as Record<string, unknown>);
                return { content: [{ type: 'text' as const, text }] };
            }
        );
    }
    // ---- Search cells ----
    server.registerTool(
        'search_cells',
        {
            description:
                'Search a notebook\'s cells (source and output text) for a query. Returns per-cell matches with ' +
                'source line numbers and/or output locations. Case-insensitive by default.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    query: { type: 'string', description: 'Text to search for (source or output).' },
                    caseSensitive: { type: 'boolean', description: 'Match case (default false).' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Restrict search to 0-based numeric indices or exact string cell IDs (default: all); numeric strings fall back to indices when no ID matches.' }
                },
                required: ['notebookRef', 'query']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; query?: string; caseSensitive?: boolean; cellIds?: Array<string | number> };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            const text = await router.invokeNotebook('search_cells', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
    // ---- Read notebook (whole) ----
    server.registerTool(
        'read_notebook',
        {
            description:
                'Read a notebook using the outline view by default, or select source, outputs, or all. Outline returns cell identity and metadata without source/output content; other views apply their explicit bounds.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Optional 0-based numeric indices or exact string cell IDs (default: all); numeric strings fall back to indices when no ID matches.' },
                    view: { type: 'string', enum: ['outline', 'source', 'outputs', 'all'], description: 'View to return (default outline).' },
                    startLine: { type: 'number', description: '1-based inclusive source start line.' },
                    endLine: { type: 'number', description: '1-based inclusive source end line.' },
                    maxSourceChars: { type: 'number', description: 'Source bound; 0 opts into the full source.' },
                    outputMode: { type: 'string', enum: ['summary', 'text', 'full'], description: 'Output detail when included: summary, preferred text (default), or all text representations.' },
                    maxOutputChars: { type: 'number', description: 'Maximum output characters per cell (default 12000; clamped to 1000..100000).' }
                },
                required: ['notebookRef']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; cellIds?: Array<string | number>; view?: 'outline' | 'source' | 'outputs' | 'all'; startLine?: number; endLine?: number; maxSourceChars?: number; outputMode?: OutputMode; maxOutputChars?: number };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            const text = await router.invokeNotebook('read_notebook', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
    // ---- Export notebook ----
    server.registerTool(
        'export_notebook',
        {
            description:
                'Export a notebook to markdown, python (with # %% cell markers), or html. Provide the notebook URI and a format.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    format: { type: 'string', enum: ['markdown', 'python', 'html'], description: 'Export format.' }
                },
required: ['notebookRef', 'format']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; format?: string };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            if (!a.format || !['markdown', 'python', 'html'].includes(a.format)) {
                throw new Error('format must be one of: markdown, python, html');
            }
            const text = await router.invokeNotebook('export_notebook', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
    // ---- Edit cells ----
    server.registerTool(
        'edit_cells',
        {
            description:
                'Apply one or more edits to a notebook in order: insert, edit, or delete cells. ' +
                'Provide the notebook URI and an array of { cellId, editType, newCode?, language?, run? } edits. ' +
                'For insert, cellId is an anchor and the new cell is placed after it; TOP and BOTTOM select the notebook boundaries. ' +
                'run (default false) explicitly re-executes an edited code cell after applying.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    edits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                cellId: { type: ['string', 'number'], description: 'Exact cell ID string or 0-based numeric index; numeric strings fall back to indices when no ID matches. For insert, this is the anchor after which the new cell is placed; TOP inserts first and BOTTOM inserts last.' },
                                editType: { type: 'string', enum: ['insert', 'edit', 'delete', 'replace'] },
                                newCode: { type: 'string', description: 'New cell content (required for insert/edit/replace).' },
                                oldText: { type: 'string', description: 'For replace, exact non-empty text to replace once.' },
                                language: { type: 'string', description: 'Cell language, e.g. python or markdown.' },
                                metadata: { type: 'object', additionalProperties: true, description: 'Optional nbformat cell metadata to merge (e.g. { "tags": ["parameters"] }); preserves native cell identity and attachments.' },
                                run: { type: 'boolean', description: 'Re-run the edited cell (default false).' }
                            },
                            required: ['cellId', 'editType']
                        }
                    }
                },
required: ['notebookRef', 'edits']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; edits?: Array<{ cellId?: string | number; editType?: string; oldText?: string; newCode?: string; language?: string; metadata?: Record<string, unknown>; run?: boolean }> };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            if (!Array.isArray(a.edits) || a.edits.length === 0) throw new Error('edits must be a non-empty array');
            const mapped = a.edits.map((e) => {
                if (!e.editType || !['insert', 'edit', 'delete', 'replace'].includes(e.editType)) {
                    throw new Error('each edit needs editType in: insert, edit, delete, replace');
                }
                return { cellId: e.cellId, editType: e.editType as 'insert' | 'edit' | 'delete' | 'replace', oldText: e.oldText, newCode: e.newCode, language: e.language, metadata: e.metadata, run: e.run };
            });
            const text = await router.invokeNotebook('edit_cells', a.notebookRef, { notebookRef: a.notebookRef, edits: mapped });
            return { content: [{ type: 'text' as const, text }] };
        }
    );
    // ---- Run cells (requires Jupyter for a kernel) ----
    if (hasJupyter) {
        server.registerTool(
            'run_cells',
            {
                description:
                    'Run one or more cells headlessly. Creates a tracked execution and waits up to waitMs (default 1000) for a bounded receipt; the sequential background runner continues after the request returns. ' +
                    'Provide the notebook URI and an array of 0-based numeric indices or exact string cell IDs. Select a kernel separately with an exact id before running. ' +
                    'Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                        cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based numeric indices or exact string cell IDs; numeric strings fall back to indices when no ID matches.' },
                    waitMs: { type: 'number', description: 'How long this request waits for the tracked receipt (default 1000); execution continues independently.' },
                        includeOutputs: { type: 'boolean', description: 'Include compact saved outputs for completed cells (default true).' },
                        outputMode: { type: 'string', enum: ['summary', 'text', 'full'], description: 'Output detail: summary, preferred text (default), or all text representations.' },
                        maxOutputChars: { type: 'number', description: 'Requested output formatting bound; tracked receipts retain at most 12000 characters per cell.' }
                    },
                    required: ['notebookRef', 'cellIds']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { notebookRef?: string; cellIds?: Array<string | number>; waitMs?: number; includeOutputs?: boolean; outputMode?: OutputMode; maxOutputChars?: number };
                if (!a.notebookRef) throw new Error('notebookRef is required');
                if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
                if (a.waitMs !== undefined && (!Number.isSafeInteger(a.waitMs) || a.waitMs < 0)) throw new Error('waitMs must be a non-negative safe integer');
                const text = await router.invokeNotebook('run_cells', a.notebookRef, a as Record<string, unknown>);
                return { content: [{ type: 'text' as const, text }] };
            }
        );
    }
    // ---- Tracked execution status (read-only) ----
    server.registerTool(
        'get_execution',
        {
            description: 'Read a tracked run_cells execution. Omit executionId to recover the most recent run for this notebook; waitMs waits for completion or budget expiry and never dispatches or interrupts execution.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    executionId: { type: 'string', description: 'Opaque execution id returned by run_cells.' },
                    waitMs: { type: 'number', description: 'How long to wait for completion before returning the current receipt (default 0).' },
                    includeOutputs: { type: 'boolean', description: 'Include bounded captured outputs (default false).' },
                    outputMode: { type: 'string', enum: ['summary', 'text', 'full'] },
                    maxOutputChars: { type: 'number', description: 'Requested output formatting bound; the immutable snapshot retains at most 12000 characters per cell.' }
                },
                required: ['notebookRef']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; executionId?: string; waitMs?: number; includeOutputs?: boolean; outputMode?: OutputMode; maxOutputChars?: number };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            if (a.waitMs !== undefined && (!Number.isSafeInteger(a.waitMs) || a.waitMs < 0)) throw new Error('waitMs must be a non-negative safe integer');
            const text = await router.invokeNotebook('get_execution', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
    // ---- Restart notebooks (kernel) (requires Jupyter) ----
    if (hasJupyter) {
        server.registerTool(
            'restart_kernels',
            {
                description: 'Request a restart for active notebook kernels without selecting or starting another kernel. Refuses when the public Jupyter API explicitly reports no active kernel; provider failures are errors, and command return does not confirm completion. Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: { notebookRefs: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs or notebookRefs from list_notebooks.' } },
                required: ['notebookRefs']
                })
            },
            async (args) => {
const a = (args ?? {}) as { notebookRefs?: string[] };
                if (!Array.isArray(a.notebookRefs) || a.notebookRefs.length === 0) throw new Error('notebookRefs must be a non-empty array');
                return { content: [{ type: 'text' as const, text: await invokeMany(router, 'restart_kernels', a.notebookRefs) }] };
            }
        );
    }
    // ---- Interrupt notebooks (kernel) (requires Jupyter) ----
    if (hasJupyter) {
        server.registerTool(
            'interrupt_kernels',
            {
                description: 'Request an interrupt for one or more open notebooks. The provider may acknowledge before execution stops, so completion cannot be confirmed by this tool. Provide an array of notebook URIs. Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: { notebookRefs: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs or notebookRefs from list_notebooks.' } },
                required: ['notebookRefs']
                })
            },
            async (args) => {
const a = (args ?? {}) as { notebookRefs?: string[] };
                if (!Array.isArray(a.notebookRefs) || a.notebookRefs.length === 0) throw new Error('notebookRefs must be a non-empty array');
                const text = await invokeMany(router, 'interrupt_kernels', a.notebookRefs);
                return { content: [{ type: 'text' as const, text }] };
            }
        );
    }
    // ---- Move cells ----
    server.registerTool(
        'move_cells',
        {
            description:
                'Move one or more cells to a new position in a notebook, preserving content, outputs, and metadata. ' +
                'Provide the notebook URI, the numeric indices or exact string cell IDs to move (in current order), and toIndex (where the ' +
                'first moved cell should land).',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based numeric indices or exact string cell IDs; numeric strings fall back to indices when no ID matches.' },
                    toIndex: { type: 'number', description: 'Index where the first moved cell should land.' }
                },
required: ['notebookRef', 'cellIds', 'toIndex']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { notebookRef?: string; cellIds?: Array<string | number>; toIndex?: number };
if (!a.notebookRef) throw new Error('notebookRef is required');
            if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
            if (typeof a.toIndex !== 'number') throw new Error('toIndex must be a number');
            const text = await router.invokeNotebook('move_cells', a.notebookRef, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Open notebooks ----
    server.registerTool(
        'open_notebooks',
        {
            description:
                'Open existing notebooks from disk in a connected VS Code window. If a URI is already open, reveal ' +
                'and preserve that live document instead of reloading it. Provide file: URIs and optionally a destination ' +
                'windowId from list_notebooks; otherwise the broker window is used.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    uris: { type: 'array', items: { type: 'string' }, description: 'file: URIs of notebooks to open.' },
                    windowId: { type: 'string', description: 'Optional destination windowId from list_notebooks.' }
                },
                required: ['uris']
            })
        },
        async (args) => {
                const a = (args ?? {}) as { uris?: string[]; windowId?: string };
                if (!Array.isArray(a.uris) || a.uris.length === 0) throw new Error('uris must be a non-empty array');
                const text = await router.invokeWindow('open_notebooks', { uris: a.uris }, a.windowId);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Save notebooks ----
    server.registerTool(
        'save_notebooks',
        {
            description:
                'Force-save one or more open file-backed notebooks, including remote-kernel outputs and execution state ' +
                'when VS Code does not mark the notebook dirty. Provide notebook URIs or notebookRefs from list_notebooks.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: { notebookRefs: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs or notebookRefs from list_notebooks.' } },
required: ['notebookRefs']
            })
        },
        async (args) => {
const a = (args ?? {}) as { notebookRefs?: string[] };
            if (!Array.isArray(a.notebookRefs) || a.notebookRefs.length === 0) throw new Error('notebookRefs must be a non-empty array');
            const text = await invokeMany(router, 'save_notebooks', a.notebookRefs);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    if (hasJupyter) {
    const fileSchema = z.object({
        notebookRef: z.string().describe('Open notebook URI or notebookRef from list_notebooks.'),
        hostPath: z.string().describe('Explicit file path on the VS Code extension host.'),
        kernelPath: z.string().describe('Explicit absolute path in the current active Python kernel filesystem.'),
        colabFileUri: z.string().optional().describe('Optional exact colab://server/absolute/path URI matching kernelPath. Selects native Contents API transfer; the server must pass a nonce check against the selected kernel. Large transfers otherwise discover mounted/open Colab roots.'),
        overwrite: z.boolean().optional().describe('Replace an existing destination (default false).'),
        maxBytes: z.number().int().positive().optional().describe('Positive transfer size limit in bytes (default 64 MiB).')
    }).strict();
    server.registerTool('upload_file', {
        description: 'Upload one host file to the current active idle Python kernel filesystem. Files above 4 MiB require the native Colab Contents filesystem (64 MiB cap); smaller files use bounded kernel chunks unless colabFileUri is supplied. Native routes must match a kernel nonce before payload transfer. Does not start/select a kernel. Verifies size and SHA-256 before atomic promotion; no overwrite by default.',
        inputSchema: fileSchema
    }, async (args) => {
        const a = (args ?? {}) as { notebookRef?: string; hostPath?: string; kernelPath?: string; colabFileUri?: string; overwrite?: boolean; maxBytes?: number };
        if (!a.notebookRef || !a.hostPath || !a.kernelPath) throw new Error('notebookRef, hostPath, and kernelPath are required');
        const text = await router.invokeNotebook('upload_file', a.notebookRef, a as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text }] };
    });
    server.registerTool('download_file', {
        description: 'Download one file from the current active idle Python kernel filesystem. Files above 4 MiB require the native Colab Contents filesystem (64 MiB cap); smaller files use bounded kernel chunks unless colabFileUri is supplied. Native routes must match a kernel nonce before payload transfer. Does not start/select a kernel. Verifies size and SHA-256 before atomic promotion; no overwrite by default.',
        inputSchema: fileSchema
    }, async (args) => {
        const a = (args ?? {}) as { notebookRef?: string; hostPath?: string; kernelPath?: string; colabFileUri?: string; overwrite?: boolean; maxBytes?: number };
        if (!a.notebookRef || !a.hostPath || !a.kernelPath) throw new Error('notebookRef, hostPath, and kernelPath are required');
        const text = await router.invokeNotebook('download_file', a.notebookRef, a as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text }] };
    });
    }
}
