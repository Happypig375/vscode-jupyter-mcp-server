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
                'Provide the notebook URI and an array of 0-based cell indices (or cell ids).',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices (or ids) to clear outputs from.' }
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
            description: 'Run the Jupyter provider-owned setup workflow for a notebook. The provider may show picker, authentication, consent, selection, or startup UI and controls the resulting runtime state.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {
                notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' }
            }, required: ['notebookRef'] })
        }, async (args) => {
            const a = (args ?? {}) as { notebookRef?: string };
            if (!a.notebookRef) throw new Error('notebookRef is required');
            const text = await router.invokeNotebook('configure_kernel', a.notebookRef, a as Record<string, unknown>);
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
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Restrict search to these cell indices/ids (default: all).' }
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
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Optional cell indices/ids to read (default: all).' },
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
                                cellId: { type: ['string', 'number'], description: '0-based cell index, or TOP/BOTTOM for insert.' },
                                editType: { type: 'string', enum: ['insert', 'edit', 'delete', 'replace'] },
                                newCode: { type: 'string', description: 'New cell content (required for insert/edit/replace).' },
                                oldText: { type: 'string', description: 'For replace, exact non-empty text to replace once.' },
                                language: { type: 'string', description: 'Cell language, e.g. python or markdown.' },
                                metadata: { type: 'object', additionalProperties: true, description: 'Optional cell metadata to set (e.g. { "tags": ["parameters"] }).' },
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
                    'Provide the notebook URI and an array of 0-based cell indices. Select a kernel separately with an exact id before running. ' +
                    'Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                        cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices (or cell ids) to run.' },
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
                description: 'Request a kernel restart for one or more open notebooks. The provider may require confirmation and completion cannot be confirmed by this tool. Provide an array of notebook URIs. Requires the Jupyter extension.',
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
                'Provide the notebook URI, the 0-based cell indices to move (in current order), and toIndex (where the ' +
                'first moved cell should land).',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    notebookRef: { type: 'string', description: 'Notebook URI or notebookRef from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices to move.' },
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
        overwrite: z.boolean().optional().describe('Replace an existing destination (default false).'),
        maxBytes: z.number().int().positive().optional().describe('Positive transfer size limit in bytes (default 64 MiB).')
    }).strict();
    server.registerTool('upload_file', {
        description: 'Upload one host file to the filesystem of the current active idle Python kernel through the public Jupyter executeCode API. Does not start or select a kernel. Enforces maxBytes, verifies byte count and SHA-256 before atomic promotion, and defaults to no overwrite.',
        inputSchema: fileSchema
    }, async (args) => {
        const a = (args ?? {}) as { notebookRef?: string; hostPath?: string; kernelPath?: string; overwrite?: boolean; maxBytes?: number };
        if (!a.notebookRef || !a.hostPath || !a.kernelPath) throw new Error('notebookRef, hostPath, and kernelPath are required');
        const text = await router.invokeNotebook('upload_file', a.notebookRef, a as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text }] };
    });
    server.registerTool('download_file', {
        description: 'Download one file from the current active idle Python kernel filesystem to the VS Code extension host through the public Jupyter executeCode API. Does not start or select a kernel. Enforces maxBytes before file output, verifies byte count and SHA-256 before atomic promotion, and defaults to no overwrite.',
        inputSchema: fileSchema
    }, async (args) => {
        const a = (args ?? {}) as { notebookRef?: string; hostPath?: string; kernelPath?: string; overwrite?: boolean; maxBytes?: number };
        if (!a.notebookRef || !a.hostPath || !a.kernelPath) throw new Error('notebookRef, hostPath, and kernelPath are required');
        const text = await router.invokeNotebook('download_file', a.notebookRef, a as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text }] };
    });
    }
}
