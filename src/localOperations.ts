import {
    clearOutputs,
    createNotebook,
    editNotebookCells,
    exportNotebook,
    getCells,
    getCellsOutput,
    getExecution,
    getKernelInfo,
    configureKernel,
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
import { downloadFile, uploadFile } from './kernelFiles';

export type LocalOperation =
    | 'create_notebook'
    | 'inspect_notebooks'
    | 'read_cells'
    | 'clear_cell_outputs'
    | 'get_kernel_info'
    | 'configure_kernel'
    | 'list_kernels'
    | 'select_kernel'
    | 'read_cell_outputs'
    | 'search_cells'
    | 'read_notebook'
    | 'export_notebook'
    | 'edit_cells'
    | 'run_cells'
    | 'get_execution'
    | 'restart_kernels'
    | 'interrupt_kernels'
    | 'move_cells'
    | 'open_notebooks'
    | 'save_notebooks'
    | 'upload_file'
    | 'download_file';

type Args = Record<string, unknown>;

function notebookRef(args: Args): string {
    if (typeof args.notebookRef !== 'string' || !args.notebookRef) throw new Error('notebookRef is required');
    return args.notebookRef;
}

/** Execute one validated tool operation against notebooks owned by this VS Code window. */
export async function executeLocalOperation(operation: LocalOperation, args: Args): Promise<string> {
    const ids = args.cellIds as Array<string | number> | undefined;
    switch (operation) {
        case 'create_notebook':
            return createNotebook(typeof args.title === 'string' ? args.title : 'New notebook');
        case 'inspect_notebooks':
            return getNotebooksSummary(args.notebookRefs as string[]);
        case 'read_cells':
            return getCells(notebookRef(args), ids, { startLine: args.startLine as number | undefined, endLine: args.endLine as number | undefined, maxSourceChars: args.maxSourceChars as number | undefined });
        case 'clear_cell_outputs':
            return clearOutputs(notebookRef(args), ids ?? []);
        case 'get_kernel_info':
            return getKernelInfo(notebookRef(args));
        case 'configure_kernel':
            return configureKernel(notebookRef(args));
        case 'list_kernels':
            return listKernels(notebookRef(args));
        case 'select_kernel':
            return selectKernel(notebookRef(args), args.kernelId as string);
        case 'read_cell_outputs':
            return getCellsOutput(notebookRef(args), ids ?? [], {
                mode: args.outputMode as OutputMode | undefined,
                maxChars: args.maxOutputChars as number | undefined
            });
        case 'search_cells':
            return searchCells(
                notebookRef(args),
                typeof args.query === 'string' ? args.query : '',
                args.caseSensitive === true,
                ids
            );
        case 'read_notebook':
            return readNotebook(notebookRef(args), {
                view: args.view as 'outline' | 'source' | 'outputs' | 'all' | undefined,
                cellIds: ids,
                startLine: args.startLine as number | undefined,
                endLine: args.endLine as number | undefined,
                maxSourceChars: args.maxSourceChars as number | undefined,
                outputMode: args.outputMode as OutputMode | undefined,
                maxOutputChars: args.maxOutputChars as number | undefined
            });
        case 'export_notebook':
            return exportNotebook(notebookRef(args), args.format as 'markdown' | 'python' | 'html');
        case 'edit_cells':
            return editNotebookCells(notebookRef(args), args.edits as Parameters<typeof editNotebookCells>[1]);
        case 'run_cells':
            return runNotebookCells(notebookRef(args), ids ?? [], {
                waitMs: args.waitMs as number | undefined,
                includeOutputs: args.includeOutputs as boolean | undefined,
                mode: args.outputMode as OutputMode | undefined,
                maxChars: args.maxOutputChars as number | undefined
            });
        case 'get_execution':
            return getExecution(notebookRef(args), {
                executionId: args.executionId as string | undefined,
                waitMs: args.waitMs as number | undefined,
                includeOutputs: args.includeOutputs === true,
                mode: args.outputMode as OutputMode | undefined,
                maxChars: args.maxOutputChars as number | undefined
            });
        case 'restart_kernels':
            return (await Promise.all((args.notebookRefs as string[]).map((path) => restartKernel(path)))).join('\n');
        case 'interrupt_kernels':
            return interruptKernels(args.notebookRefs as string[]);
        case 'move_cells':
            return moveCells(notebookRef(args), ids ?? [], args.toIndex as number);
        case 'open_notebooks':
            return openNotebooks(args.uris as string[]);
        case 'save_notebooks':
            return saveNotebooks(args.notebookRefs as string[]);
        case 'upload_file':
            return uploadFile({ notebookRef: notebookRef(args), hostPath: args.hostPath as string, kernelPath: args.kernelPath as string, overwrite: args.overwrite as boolean | undefined, maxBytes: args.maxBytes as number | undefined });
        case 'download_file':
            return downloadFile({ notebookRef: notebookRef(args), hostPath: args.hostPath as string, kernelPath: args.kernelPath as string, overwrite: args.overwrite as boolean | undefined, maxBytes: args.maxBytes as number | undefined });
        default:
            throw new Error(`Unknown local notebook operation: ${String(operation)}`);
    }
}
