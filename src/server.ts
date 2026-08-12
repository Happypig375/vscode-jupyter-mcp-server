import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonSchemaToZod } from './schema';
import { NotebookRouter } from './broker';
import { OutputMode } from './notebookOps';
import { LocalOperation } from './localOperations';

async function invokeMany(router: NotebookRouter, operation: LocalOperation, filePaths: string[]): Promise<string> {
    return router.invokeNotebooks(operation, filePaths);
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
                    query: { type: 'string', description: 'What the notebook should contain (used as title).' },
                    windowId: { type: 'string', description: 'Optional destination windowId from list_notebooks.' }
                },
                required: ['query']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { query?: string; windowId?: string };
            const msg = await router.invokeWindow('create_notebook', { query: a.query ?? 'New notebook' }, a.windowId);
            return { content: [{ type: 'text' as const, text: msg }] };
        }
    );

    // ---- Get notebooks ----
    server.registerTool(
        'list_notebooks',
        {
            description:
                'List notebooks across all connected VS Code windows. Returns uri, windowId, windowLabel, and notebookId. ' +
                'Use notebookId as filePath when the same URI is open in more than one window.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {} })
        },
        async () => {
            return { content: [{ type: 'text' as const, text: JSON.stringify(await router.listNotebooks()) }] };
        }
    );

    // ---- Get cells (metadata) ----
    server.registerTool(
        'inspect_notebooks',
        {
            description:
                'Get METADATA for one or more notebooks: per cell, the index, kind, language, line count, ' +
                'best available cell anchor, execution state, and output mime types. Does not include cell source or output content — ' +
                'use read_cells for source and read_cell_outputs for outputs.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs or notebookIds from list_notebooks.' } },
                required: ['filePaths']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePaths?: string[] };
            if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
            const text = await invokeMany(router, 'inspect_notebooks', a.filePaths);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Get cells source ----
    server.registerTool(
        'read_cells',
        {
            description:
                'Read the SOURCE of cells in a notebook. Provide the notebook URI and optionally an array of ' +
                '0-based cell indices (omit to read all cells). Returns index, kind, language, and source text per cell.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices to read (omit for all).' }
                },
                required: ['filePath']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number> };
            if (!a.filePath) throw new Error('filePath is required');
            const text = await router.invokeNotebook('read_cells', a.filePath, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
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
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices (or ids) to clear outputs from.' }
                },
                required: ['filePath', 'cellIds']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number> };
            if (!a.filePath) throw new Error('filePath is required');
            if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
            const text = await router.invokeNotebook('clear_cell_outputs', a.filePath, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Get kernel info ----
    server.registerTool(
        'get_kernel_info',
        {
            description:
                'Get active kernel information for a notebook (best-effort via the Jupyter extension; "unknown" if unavailable). ' +
                'Use list_kernels for exact ids accepted by select_kernel; run_cells.kernel remains a legacy best-effort hint.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' }
                },
                required: ['filePath']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string };
            if (!a.filePath) throw new Error('filePath is required');
            const text = await router.invokeNotebook('get_kernel_info', a.filePath, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- List/select kernels (requires Jupyter) ----
    if (hasJupyter) {
        server.registerTool(
            'list_kernels',
            {
                description:
                    'List the exact kernel/controller ids currently available to a notebook. By default this is read-only. ' +
                    'Set configure=true to first run Jupyter\'s provider-neutral configuration workflow, then return the ' +
                    'configuration status and refreshed controllers. Providers such as Colab may show normal UI. ' +
                    'Pass one returned id to select_kernel.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                        configure: { type: 'boolean', description: 'Configure providers before enumeration (default false/read-only).' }
                    },
                    required: ['filePath']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePath?: string; configure?: boolean };
                if (!a.filePath) throw new Error('filePath is required');
                const text = await router.invokeNotebook('list_kernels', a.filePath, a as Record<string, unknown>);
                return { content: [{ type: 'text' as const, text }] };
            }
        );

        server.registerTool(
            'select_kernel',
            {
                description:
                    'Select an exact kernel id returned by list_kernels for a notebook. Set start=true to ask the Jupyter ' +
                    'extension to start that selected kernel; remote providers may require their normal sign-in/confirmation UI. ' +
                    'Fails instead of falling back when the id is unavailable or selection is rejected.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                        kernelId: { type: 'string', description: 'Exact id returned by list_kernels.' },
                        start: { type: 'boolean', description: 'Start the selected kernel via Jupyter (default false).' }
                    },
                    required: ['filePath', 'kernelId']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePath?: string; kernelId?: string; start?: boolean };
                if (!a.filePath) throw new Error('filePath is required');
                if (!a.kernelId) throw new Error('kernelId is required');
                const text = await router.invokeNotebook('select_kernel', a.filePath, a as Record<string, unknown>);
                return { content: [{ type: 'text' as const, text }] };
            }
        );
    }

    // ---- Get cells output ----
    server.registerTool(
        'read_cell_outputs',
        {
            description:
                'Read the saved OUTPUT of cells in a notebook. Provide the notebook URI and an array of ' +
                'cell indices/ids. Text mode returns one preferred text representation, never decodes binary images, ' +
                'and bounds each cell response. Use summary for MIME types/sizes or full for all textual representations.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Cell indices/ids to read output from.' },
                    outputMode: { type: 'string', enum: ['summary', 'text', 'full'], description: 'Output detail: summary, preferred text (default), or all text representations.' },
                    maxOutputChars: { type: 'number', description: 'Maximum output characters per cell (default 12000; clamped to 1000..100000).' }
                },
                required: ['filePath', 'cellIds']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number>; outputMode?: OutputMode; maxOutputChars?: number };
            if (!a.filePath) throw new Error('filePath is required');
            if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
            const text = await router.invokeNotebook('read_cell_outputs', a.filePath, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

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
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    query: { type: 'string', description: 'Text to search for (source or output).' },
                    caseSensitive: { type: 'boolean', description: 'Match case (default false).' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Restrict search to these cell indices/ids (default: all).' }
                },
                required: ['filePath', 'query']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; query?: string; caseSensitive?: boolean; cellIds?: Array<string | number> };
            if (!a.filePath) throw new Error('filePath is required');
            const text = await router.invokeNotebook('search_cells', a.filePath, a as Record<string, unknown>);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Read notebook (whole) ----
    server.registerTool(
        'read_notebook',
        {
            description:
                'Read a whole notebook in one call: per cell, the index, stable cell_id anchor, kind, language, ' +
                'source, execution state, and (optionally) outputs. Provide the notebook URI; optionally restrict ' +
                'to specific cell indices/ids and include outputs.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Optional cell indices/ids to read (default: all).' },
                    includeOutputs: { type: 'boolean', description: 'Include compact cell outputs (default false).' },
                    outputMode: { type: 'string', enum: ['summary', 'text', 'full'], description: 'Output detail when included: summary, preferred text (default), or all text representations.' },
                    maxOutputChars: { type: 'number', description: 'Maximum output characters per cell (default 12000; clamped to 1000..100000).' }
                },
                required: ['filePath']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number>; includeOutputs?: boolean; outputMode?: OutputMode; maxOutputChars?: number };
            if (!a.filePath) throw new Error('filePath is required');
            const text = await router.invokeNotebook('read_notebook', a.filePath, a as Record<string, unknown>);
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
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    format: { type: 'string', enum: ['markdown', 'python', 'html'], description: 'Export format.' }
                },
                required: ['filePath', 'format']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; format?: string };
            if (!a.filePath) throw new Error('filePath is required');
            if (!a.format || !['markdown', 'python', 'html'].includes(a.format)) {
                throw new Error('format must be one of: markdown, python, html');
            }
            const text = await router.invokeNotebook('export_notebook', a.filePath, a as Record<string, unknown>);
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
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    edits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                cellId: { type: ['string', 'number'], description: '0-based cell index, or TOP/BOTTOM for insert.' },
                                editType: { type: 'string', enum: ['insert', 'edit', 'delete'] },
                                newCode: { type: 'string', description: 'New cell content (required for insert/edit).' },
                                language: { type: 'string', description: 'Cell language, e.g. python or markdown.' },
                                metadata: { type: 'object', description: 'Optional cell metadata to set (e.g. { "tags": ["parameters"] }).' },
                                run: { type: 'boolean', description: 'Re-run the edited cell (default false).' }
                            },
                            required: ['cellId', 'editType']
                        }
                    }
                },
                required: ['filePath', 'edits']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; edits?: Array<{ cellId?: string | number; editType?: string; newCode?: string; language?: string; metadata?: Record<string, unknown>; run?: boolean }> };
            if (!a.filePath) throw new Error('filePath is required');
            if (!Array.isArray(a.edits) || a.edits.length === 0) throw new Error('edits must be a non-empty array');
            const mapped = a.edits.map((e) => {
                if (!e.editType || !['insert', 'edit', 'delete'].includes(e.editType)) {
                    throw new Error('each edit needs editType in: insert, edit, delete');
                }
                return { cellId: e.cellId, editType: e.editType as 'insert' | 'edit' | 'delete', newCode: e.newCode, language: e.language, metadata: e.metadata, run: e.run };
            });
            const text = await router.invokeNotebook('edit_cells', a.filePath, { filePath: a.filePath, edits: mapped });
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Run cells (requires Jupyter for a kernel) ----
    if (hasJupyter) {
        server.registerTool(
            'run_cells',
            {
                description:
                    'Run one or more cells headlessly. By default, run in order and wait for completion, returning bounded text outputs; ' +
                    'a timeout reports that execution is still running and does not interrupt the kernel. Set wait=false to queue all selected cells and return immediately. ' +
                    'Provide the notebook URI and an array of 0-based cell indices. The optional kernel label/id hint uses ' +
                    'legacy best-effort selection and falls back to the current kernel. For exact fail-closed selection, call ' +
                    'select_kernel first and then call run_cells without kernel. ' +
                    'Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                        cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices (or cell ids) to run.' },
                        kernel: { type: 'string', description: 'Legacy optional kernel label/id hint selected best-effort before running.' },
                        timeoutMs: { type: 'number', description: 'Max ms to wait per cell (default 60000); does not interrupt on timeout.' },
                        wait: { type: 'boolean', description: 'Wait for each result (default true). False queues all selected cells and returns immediately.' },
                        includeOutputs: { type: 'boolean', description: 'Include compact saved outputs for completed cells (default true).' },
                        outputMode: { type: 'string', enum: ['summary', 'text', 'full'], description: 'Output detail: summary, preferred text (default), or all text representations.' },
                        maxOutputChars: { type: 'number', description: 'Maximum output characters per cell (default 12000; clamped to 1000..100000).' }
                    },
                    required: ['filePath', 'cellIds']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number>; kernel?: string; timeoutMs?: number; wait?: boolean; includeOutputs?: boolean; outputMode?: OutputMode; maxOutputChars?: number };
                if (!a.filePath) throw new Error('filePath is required');
                if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
                const text = await router.invokeNotebook('run_cells', a.filePath, a as Record<string, unknown>);
                return { content: [{ type: 'text' as const, text }] };
            }
        );
    }

    // ---- Restart notebooks (kernel) (requires Jupyter) ----
    if (hasJupyter) {
        server.registerTool(
            'restart_kernels',
            {
                description: 'Restart the kernel of one or more open notebooks. Provide an array of notebook URIs. Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs or notebookIds from list_notebooks.' } },
                    required: ['filePaths']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePaths?: string[] };
                if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
                return { content: [{ type: 'text' as const, text: await invokeMany(router, 'restart_kernels', a.filePaths) }] };
            }
        );
    }

    // ---- Interrupt notebooks (kernel) (requires Jupyter) ----
    if (hasJupyter) {
        server.registerTool(
            'interrupt_kernels',
            {
                description: 'Interrupt (stop) the running execution of one or more open notebooks. Provide an array of notebook URIs. Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs or notebookIds from list_notebooks.' } },
                    required: ['filePaths']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePaths?: string[] };
                if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
                const text = await invokeMany(router, 'interrupt_kernels', a.filePaths);
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
                    filePath: { type: 'string', description: 'Notebook URI or notebookId from list_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices to move.' },
                    toIndex: { type: 'number', description: 'Index where the first moved cell should land.' }
                },
                required: ['filePath', 'cellIds', 'toIndex']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number>; toIndex?: number };
            if (!a.filePath) throw new Error('filePath is required');
            if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
            if (typeof a.toIndex !== 'number') throw new Error('toIndex must be a number');
            const text = await router.invokeNotebook('move_cells', a.filePath, a as Record<string, unknown>);
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
                    filePaths: { type: 'array', items: { type: 'string' }, description: 'file: URIs of notebooks to open.' },
                    windowId: { type: 'string', description: 'Optional destination windowId from list_notebooks.' }
                },
                required: ['filePaths']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePaths?: string[]; windowId?: string };
            if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
            const text = await router.invokeWindow('open_notebooks', { filePaths: a.filePaths }, a.windowId);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Save notebooks ----
    server.registerTool(
        'save_notebooks',
        {
            description:
                'Force-save one or more open file-backed notebooks, including remote-kernel outputs and execution state ' +
                'when VS Code does not mark the notebook dirty. Provide notebook URIs or notebookIds from list_notebooks.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs or notebookIds from list_notebooks.' } },
                required: ['filePaths']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePaths?: string[] };
            if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
            const text = await invokeMany(router, 'save_notebooks', a.filePaths);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
}
