/**
 * Process-local MCP mutation accounting for the bounded restored-workspace
 * restart. GUI activity is validated separately by the restoration snapshot.
 */

const READ_ONLY_OPERATIONS = new Set([
    'inspect_colab_environment_preflight',
    'list_colab_terminals',
    'get_colab_environment_preparation',
    'inspect_notebooks',
    'read_cells',
    'get_kernel_info',
    'get_kernel_setup',
    'list_setup_kernels',
    'list_kernels',
    'read_cell_outputs',
    'search_cells',
    'read_notebook',
    'export_notebook',
    'get_execution'
]);

let activeMutations = 0;
let restartOwner: symbol | undefined;

export class OperationGateError extends Error {
    constructor(readonly code: 'restart_in_progress' | 'mutation_in_progress' | 'restart_exclusion_lost', message: string) {
        super(message);
    }
}

export interface RestartExclusion {
    assertHeld(): void;
    release(): void;
}

/** Begin one routed operation before its first await. */
export function beginLocalOperation(operation: string, args: Record<string, unknown>): () => void {
    if (READ_ONLY_OPERATIONS.has(operation)) return () => undefined;
    // The manager acquires the stronger, durable exclusion synchronously.
    if (operation === 'prepare_colab_environment' && args.restartMode === 'restore-clean-workspace') return () => undefined;
    if (restartOwner) {
        throw new OperationGateError('restart_in_progress', 'A restored-workspace restart is pending; mutating MCP operations are disabled until its receipt is ready or failed.');
    }
    activeMutations++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        activeMutations = Math.max(0, activeMutations - 1);
    };
}

/** Acquire the restart exclusion synchronously, before any restoration await. */
export function acquireRestartExclusion(): RestartExclusion {
    if (restartOwner) throw new OperationGateError('restart_in_progress', 'Another restored-workspace restart is already pending.');
    if (activeMutations) throw new OperationGateError('mutation_in_progress', 'A mutating MCP operation is still in flight; restored-workspace restart was not armed.');
    const owner = Symbol('restored-workspace-restart');
    restartOwner = owner;
    let released = false;
    return {
        assertHeld() {
            if (released || restartOwner !== owner) throw new OperationGateError('restart_exclusion_lost', 'The restored-workspace restart exclusion is no longer held.');
        },
        release() {
            if (released) return;
            released = true;
            if (restartOwner === owner) restartOwner = undefined;
        }
    };
}

export function assertMutationAllowed(): void {
    if (restartOwner) throw new OperationGateError('restart_in_progress', 'A restored-workspace restart is pending; mutating MCP operations are disabled.');
}

export function operationGateStateForTest(): { activeMutations: number; restartPending: boolean } {
    return { activeMutations, restartPending: Boolean(restartOwner) };
}

