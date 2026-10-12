import * as assert from 'assert';
import * as fs from 'fs';
import { createRequire } from 'module';
import { editNotebook } from '../notebookOps';
import { jsonSchemaToZod } from '../schema';
import * as stub from './notebookMetadataStub';

function serializer(): (data: stub.NotebookData) => string {
    const bundlePath = process.env.NOTEBOOK_SERIALIZER_BUNDLE;
    if (!bundlePath) return stub.serializeFixture;
    // Optional local check runs the installed serializer's pure conversion function;
    // never calls activate(), registers an extension, or accesses the live VS Code app.
    const source = fs.readFileSync(bundlePath, 'utf8');
    const functionName = source.match(/exportNotebook:\w+=>Promise\.resolve\((\w+)\(\w+\)\)/)?.[1];
    assert.ok(functionName, 'installed serializer export function must be identifiable');
    const isolated = { exports: {} as any }, nativeRequire = createRequire(bundlePath);
    new Function('require', 'module', 'exports', `${source}\n;module.exports.__serialize=${functionName};`)(
        (name: string) => name === 'vscode' ? stub : nativeRequire(name), isolated, isolated.exports
    );
    return isolated.exports.__serialize;
}
async function main() {
    const serialize = serializer();
    const raw = { nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells: [
        { cell_type: 'markdown', id: 'cover-cell', source: ['# Old cover'], metadata: { presentation_id: 'cover', retained: true }, attachments: { 'image.png': { 'image/png': 'c3ludGhldGlj' } } },
        { cell_type: 'code', id: 'setup-cell', source: ['print("unique")'], metadata: { tags: ['old'], retained: 'code' }, execution_count: 7, outputs: [{ output_type: 'stream', name: 'stdout', text: ['synthetic output\n'] }] }
    ] };
    const data = stub.deserializeFixture(JSON.stringify(raw));
    const uri = { fsPath: '/metadata-fixture.ipynb', toString: () => 'file:///metadata-fixture.ipynb' };
    const document = { uri, notebookType: 'jupyter-notebook', cells: data.cells, isDirty: false, isUntitled: true,
        get cellCount() { return this.cells.length; },
        cellAt(index: number) { const cell = this.cells[index]; return { kind: cell.kind, metadata: cell.metadata, outputs: cell.outputs, document: { getText: () => cell.value, languageId: cell.languageId } }; }
    };
    stub.workspace.notebookDocuments.push(document);
    const input = { filePath: uri.toString(), run: false };
    const incoming = { presentation_number: 1, presentation_id: 'revised-cover', tags: ['presentation'] };
    const originalMetadata = data.cells[0].metadata, originalEnvelope = JSON.stringify(originalMetadata);
    await editNotebook({ ...input, cellId: 0, editType: 'edit', newCode: '# New cover', metadata: incoming });
    assert.strictEqual(JSON.stringify(incoming), JSON.stringify({ presentation_number: 1, presentation_id: 'revised-cover', tags: ['presentation'] }), 'does not mutate request metadata');
    assert.strictEqual(JSON.stringify(originalMetadata), originalEnvelope, 'does not mutate original native metadata');
    let saved = JSON.parse(serialize(data));
    assert.deepStrictEqual(saved.cells[0].metadata, { presentation_id: 'revised-cover', retained: true, presentation_number: 1, tags: ['presentation'] });
    assert.strictEqual(saved.cells[0].id, 'cover-cell'); assert.deepStrictEqual(saved.cells[0].attachments, raw.cells[0].attachments);
    const beforeOutputs = document.cells[1].outputs;
    await editNotebook({ ...input, cellId: 1, editType: 'replace', oldText: 'unique', newCode: 'updated', metadata: { tags: ['setup'], jupyter: { source_hidden: true }, id: 'metadata-id', execution_count: 999 } });
    saved = JSON.parse(serialize(data));
    assert.deepStrictEqual(saved.cells[1].metadata, { tags: ['setup'], retained: 'code', jupyter: { source_hidden: true }, id: 'metadata-id', execution_count: 999 });
    assert.strictEqual(saved.cells[1].id, 'setup-cell'); assert.strictEqual(saved.cells[1].execution_count, 7);
    assert.deepStrictEqual(saved.cells[1].outputs, raw.cells[1].outputs); assert.deepStrictEqual(document.cells[1].outputs, beforeOutputs);
    await editNotebook({ ...input, cellId: 'BOTTOM', editType: 'insert', language: 'markdown', newCode: '# Inserted', metadata: { presentation_id: 'inserted', presentation_number: 2 } });
    saved = JSON.parse(serialize(data));
    assert.deepStrictEqual(saved.cells[2].metadata, { presentation_id: 'inserted', presentation_number: 2 });
    await editNotebook({ ...input, cellId: 0, editType: 'edit', newCode: '# Preserve metadata' });
    assert.deepStrictEqual(JSON.parse(serialize(data)).cells[0].metadata, saved.cells[0].metadata);
    const reopened = stub.deserializeFixture(serialize(data));
    assert.deepStrictEqual(reopened.cells[0].metadata.metadata, saved.cells[0].metadata);
    assert.deepStrictEqual(reopened.cells[1].metadata.metadata, saved.cells[1].metadata);
    assert.deepStrictEqual(reopened.cells[2].metadata.metadata, saved.cells[2].metadata);
    const strict = jsonSchemaToZod({ type: 'object', properties: { metadata: { type: 'object', additionalProperties: true } } });
    assert.deepStrictEqual(strict.parse({ metadata: incoming }), { metadata: incoming });
    assert.throws(() => strict.parse({ metadata: incoming, typo: true }));
    console.log(`notebook metadata roundtrip tests passed (${process.env.NOTEBOOK_SERIALIZER_BUNDLE ? 'installed ipynb serializer' : 'bounded serializer fixture'})`);
}
void main().catch((error) => { console.error(error); process.exit(1); });
