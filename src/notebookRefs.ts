import * as crypto from 'crypto';

export interface ListedNotebook {
    notebookRef: string;
    uri: string;
}

export interface ListedNotebookGroup {
    windowId: string;
    windowLabel: string;
    notebooks: ListedNotebook[];
}

export function notebookRefFor(windowId: string, uri: string): string {
    const digest = crypto.createHash('sha256').update(JSON.stringify([windowId, uri])).digest('hex');
    return `nb_${digest.slice(0, 24)}`;
}

export function isNotebookRef(value: string): boolean {
    return /^nb_[0-9a-f]{24}$/.test(value);
}
