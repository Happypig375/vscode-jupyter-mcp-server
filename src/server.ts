import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonSchemaToZod } from './schema';
import { createNotebook, listOpenNotebooks, getCells, getCellsOutput, getNotebooksSummary, editNotebookCells, runNotebookCells, restartKernel, saveNotebooks, moveCells, openNotebooks, readNotebook, exportNotebook, interruptKernels, getKernelInfo, clearOutputs, searchCells } from './notebookOps';
import { listWindows, windowLabel } from './registry';

/** Register the notebook MCP server's tools on a given McpServer. */
export function registerNotebookTools(server: McpServer, port: number, instanceId: string, hasJupyter: boolean): void {
    // All tools are multi-capable (arrays); single-use is a 1-element array.
    // All are implemented natively via the VS Code notebook API — no invokeTool,
    // no approval dialogs, headless.
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
                'Create a new Jupyter notebook in the current workspace and open it in the editor. ' +
                'Provide a natural-language query used as the notebook title and a placeholder code cell.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: { query: { type: 'string', description: 'What the notebook should contain (used as title).' } },
                required: ['query']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { query?: string };
            const msg = await createNotebook(a.query ?? 'New notebook');
            return { content: [{ type: 'text' as const, text: msg }] };
        }
    );

    // ---- Get notebooks ----
    server.registerTool(
        'get_notebooks',
        {
            description:
                'List the Jupyter notebooks currently open across ALL editor windows registered with this server. ' +
                'Returns an array of { uri, windowId, windowLabel }. Pass windowId back to disambiguate when the same ' +
                'file is open in multiple windows.',
            inputSchema: jsonSchemaToZod({ type: 'object', properties: {} })
        },
        async () => {
            const windows = listWindows(port);
            const out: Array<{ uri: string; windowId: string; windowLabel: string }> = [];
            for (const uri of listOpenNotebooks()) {
                out.push({ uri, windowId: instanceId, windowLabel: windowLabel() });
            }
            // Other windows: surface the topology so the model can route/ask.
            for (const w of windows) {
                if (w.id !== instanceId) {
                    out.push({ uri: '', windowId: w.id, windowLabel: w.label });
                }
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
        }
    );

    // ---- Get cells (metadata) ----
    server.registerTool(
        'get_cells',
        {
            description:
                'Get METADATA for one or more notebooks: per cell, the index, kind, language, line count, ' +
                'execution state, and output mime types. Does not include cell source or output content — ' +
                'use get_cells_source for source and get_cells_output for outputs.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs from get_notebooks.' } },
                required: ['filePaths']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePaths?: string[] };
            if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
            const text = await getNotebooksSummary(a.filePaths);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Get cells source ----
    server.registerTool(
        'get_cells_source',
        {
            description:
                'Read the SOURCE of cells in a notebook. Provide the notebook URI and optionally an array of ' +
                '0-based cell indices (omit to read all cells). Returns index, kind, language, and source text per cell.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices to read (omit for all).' }
                },
                required: ['filePath']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number> };
            if (!a.filePath) throw new Error('filePath is required');
            const text = await getCells(a.filePath, a.cellIds);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Clear outputs ----
    server.registerTool(
        'clear_outputs',
        {
            description:
                'Clear the saved OUTPUT of one or more cells in a notebook (removes outputs and execution state). ' +
                'Provide the notebook URI and an array of 0-based cell indices (or cell ids).',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices (or ids) to clear outputs from.' }
                },
                required: ['filePath', 'cellIds']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number> };
            if (!a.filePath) throw new Error('filePath is required');
            if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
            const text = await clearOutputs(a.filePath, a.cellIds);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Get kernel info ----
    server.registerTool(
        'get_kernel_info',
        {
            description:
                'Get the active kernel label for a notebook (best-effort via the Jupyter extension; "unknown" if unavailable). ' +
                'Useful for picking a `kernel` argument for run_cells.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' }
                },
                required: ['filePath']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string };
            if (!a.filePath) throw new Error('filePath is required');
            const text = await getKernelInfo(a.filePath);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Get cells output ----
    server.registerTool(
        'get_cells_output',
        {
            description:
                'Read the saved OUTPUT of cells in a notebook. Provide the notebook URI and an array of ' +
                '0-based cell indices. Returns all output items (decoded) per cell.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices to read output from.' }
                },
                required: ['filePath', 'cellIds']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number> };
            if (!a.filePath) throw new Error('filePath is required');
            if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
            const text = await getCellsOutput(a.filePath, a.cellIds);
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
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
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
            const text = searchCells(a.filePath, a.query ?? '', a.caseSensitive === true, a.cellIds);
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
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
                    cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: 'Optional cell indices/ids to read (default: all).' },
                    includeOutputs: { type: 'boolean', description: 'Include cell outputs (default false).' }
                },
                required: ['filePath']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number>; includeOutputs?: boolean };
            if (!a.filePath) throw new Error('filePath is required');
            const text = await readNotebook(a.filePath, { includeOutputs: a.includeOutputs === true, cellIds: a.cellIds });
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
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
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
            const text = await exportNotebook(a.filePath, a.format as 'markdown' | 'python' | 'html');
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
                'run (default true) re-executes edited code cells after applying.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
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
                                run: { type: 'boolean', description: 'Re-run the edited cell (default true).' }
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
            const text = await editNotebookCells(a.filePath, mapped);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Run cells (requires Jupyter for a kernel) ----
    if (hasJupyter) {
        server.registerTool(
            'run_cells',
            {
                description:
                    'Run one or more cells in a notebook headlessly (no approval dialog), in order, and WAIT for ' +
                    'completion, returning each cell\'s status and parsed outputs (text/error/image). ' +
                    'Provide the notebook URI and an array of 0-based cell indices. Optionally provide a kernel name/id ' +
                    'to select before running (e.g. "Python 3.12.2"; best-effort, falls back to the current kernel if not found). ' +
                    'Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: {
                        filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
                        cellIds: { type: 'array', items: { type: ['string', 'number'] }, description: '0-based cell indices (or cell ids) to run.' },
                        kernel: { type: 'string', description: 'Optional kernel name/id to select before running.' },
                        timeoutMs: { type: 'number', description: 'Max ms to wait per cell (default 60000).' }
                    },
                    required: ['filePath', 'cellIds']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePath?: string; cellIds?: Array<string | number>; kernel?: string; timeoutMs?: number };
                if (!a.filePath) throw new Error('filePath is required');
                if (!Array.isArray(a.cellIds) || a.cellIds.length === 0) throw new Error('cellIds must be a non-empty array');
                const text = await runNotebookCells(a.filePath, a.cellIds, a.kernel, a.timeoutMs ?? 60000);
                return { content: [{ type: 'text' as const, text }] };
            }
        );
    }

    // ---- Restart notebooks (kernel) (requires Jupyter) ----
    if (hasJupyter) {
        server.registerTool(
            'restart_notebooks',
            {
                description: 'Restart the kernel of one or more open notebooks. Provide an array of notebook URIs. Requires the Jupyter extension.',
                inputSchema: jsonSchemaToZod({
                    type: 'object',
                    properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs from get_notebooks.' } },
                    required: ['filePaths']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePaths?: string[] };
                if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
                const lines: string[] = [];
                for (const fp of a.filePaths) {
                    lines.push(await restartKernel(fp));
                }
                return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
                    properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs from get_notebooks.' } },
                    required: ['filePaths']
                })
            },
            async (args) => {
                const a = (args ?? {}) as { filePaths?: string[] };
                if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
                const text = await interruptKernels(a.filePaths);
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
                    filePath: { type: 'string', description: 'Notebook URI from get_notebooks.' },
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
            const text = await moveCells(a.filePath, a.cellIds, a.toIndex);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Open notebooks ----
    server.registerTool(
        'open_notebooks',
        {
            description:
                'Open one or more existing notebooks from disk in the editor. Provide file: URIs of notebooks on disk. ' +
                'After opening, they appear in get_notebooks and can be read/edited/run.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'file: URIs of notebooks to open.' } },
                required: ['filePaths']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePaths?: string[] };
            if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
            const text = await openNotebooks(a.filePaths);
            return { content: [{ type: 'text' as const, text }] };
        }
    );

    // ---- Save notebooks ----
    server.registerTool(
        'save_notebooks',
        {
            description: 'Save one or more open notebooks (persist dirty changes to disk). Provide an array of notebook URIs.',
            inputSchema: jsonSchemaToZod({
                type: 'object',
                properties: { filePaths: { type: 'array', items: { type: 'string' }, description: 'Notebook URIs from get_notebooks.' } },
                required: ['filePaths']
            })
        },
        async (args) => {
            const a = (args ?? {}) as { filePaths?: string[] };
            if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) throw new Error('filePaths must be a non-empty array');
            const text = await saveNotebooks(a.filePaths);
            return { content: [{ type: 'text' as const, text }] };
        }
    );
}

