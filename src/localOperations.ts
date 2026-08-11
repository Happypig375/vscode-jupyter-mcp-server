import {
    clearOutputs,
    configureKernel,
    createNotebook,
    editNotebookCells,
    exportNotebook,
    getCells,
    getCellsOutput,
    getKernelInfo,
    getNotebooksSummary,
    interruptKernels,
    listKernels,
    moveCells,
    openNotebooks,
    OutputMode,
    readNotebook,
    restartKernel,
    runNotebookCells,
    selectKernel,
    saveNotebooks,
    searchCells
} from './notebookOps';

export type LocalOperation =
    | 'create_notebook'
    | 'configure_kernel'
    | 'inspect_notebooks'
    | 'read_cells'
    | 'clear_cell_outputs'
    | 'get_kernel_info'
    | 'list_kernels'
    | 'select_kernel'
    | 'read_cell_outputs'
    | 'search_cells'
    | 'read_notebook'
    | 'export_notebook'
    | 'edit_cells'
    | 'run_cells'
    | 'restart_kernels'
    | 'interrupt_kernels'
    | 'move_cells'
    | 'open_notebooks'
    | 'save_notebooks';

type Args = Record<string, unknown>;

function filePath(args: Args): string {
    if (typeof args.filePath !== 'string' || !args.filePath) throw new Error('filePath is required');
    return args.filePath;
}

/** Execute one validated tool operation against notebooks owned by this VS Code window. */
export async function executeLocalOperation(operation: LocalOperation, args: Args): Promise<string> {
    const ids = args.cellIds as Array<string | number> | undefined;
    switch (operation) {
        case 'create_notebook':
            return createNotebook(typeof args.query === 'string' ? args.query : 'New notebook');
        case 'configure_kernel':
            return configureKernel(filePath(args));
        case 'inspect_notebooks':
            return getNotebooksSummary(args.filePaths as string[]);
        case 'read_cells':
            return getCells(filePath(args), ids);
        case 'clear_cell_outputs':
            return clearOutputs(filePath(args), ids ?? []);
        case 'get_kernel_info':
            return getKernelInfo(filePath(args));
        case 'list_kernels':
            return listKernels(filePath(args));
        case 'select_kernel':
            return selectKernel(filePath(args), args.kernelId as string, args.start === true);
        case 'read_cell_outputs':
            return getCellsOutput(filePath(args), ids ?? [], {
                mode: args.outputMode as OutputMode | undefined,
                maxChars: args.maxOutputChars as number | undefined
            });
        case 'search_cells':
            return searchCells(
                filePath(args),
                typeof args.query === 'string' ? args.query : '',
                args.caseSensitive === true,
                ids
            );
        case 'read_notebook':
            return readNotebook(filePath(args), {
                includeOutputs: args.includeOutputs === true,
                cellIds: ids,
                outputMode: args.outputMode as OutputMode | undefined,
                maxOutputChars: args.maxOutputChars as number | undefined
            });
        case 'export_notebook':
            return exportNotebook(filePath(args), args.format as 'markdown' | 'python' | 'html');
        case 'edit_cells':
            return editNotebookCells(filePath(args), args.edits as Parameters<typeof editNotebookCells>[1]);
        case 'run_cells':
            return runNotebookCells(filePath(args), ids ?? [], {
                kernel: args.kernel as string | undefined,
                timeoutMs: args.timeoutMs as number | undefined,
                wait: args.wait as boolean | undefined,
                includeOutputs: args.includeOutputs as boolean | undefined,
                mode: args.outputMode as OutputMode | undefined,
                maxChars: args.maxOutputChars as number | undefined
            });
        case 'restart_kernels':
            return (await Promise.all((args.filePaths as string[]).map((path) => restartKernel(path)))).join('\n');
        case 'interrupt_kernels':
            return interruptKernels(args.filePaths as string[]);
        case 'move_cells':
            return moveCells(filePath(args), ids ?? [], args.toIndex as number);
        case 'open_notebooks':
            return openNotebooks(args.filePaths as string[]);
        case 'save_notebooks':
            return saveNotebooks(args.filePaths as string[]);
        default:
            throw new Error(`Unknown local notebook operation: ${String(operation)}`);
    }
}
