import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import StandardNotesImportPlugin from '../src/main';
import { parseBackup, planImport } from '../src/importer';
import { ImportModal, ReportModal } from '../src/modals';
import { resetPro } from '../src/pro';
import manifest from '../manifest.json';

const note = (uuid = 'n1', title = 'Hello') => ({ uuid, content_type: 'Note', content: { title, text: 'Keep this text' } });
const make = (files: Record<string, string> = {}) => {
 const app = App.createConfigured__({ files });
 return { app, plugin: new StandardNotesImportPlugin(app as never, manifest as never) };
};
afterEach(() => { resetPro(); vi.restoreAllMocks(); });

describe('review regressions', () => {
 it.each([
  [{ 'A notes/todo.txt': 'Text', 'backup.json': '{}' }, 'backup.json'],
  [{ 'A notes/todo.txt': 'Text', 'backup.json': '{}', 'B/Standard Notes Backup and Import File.txt': '{}' }, 'B/Standard Notes Backup and Import File.txt'],
  [{ 'A notes/todo.txt': 'Text', 'b.txt': 'Text' }, 'A notes/todo.txt'],
 ])('selects a likely backup first in the dialog %#', (files, selected) => {
  const { plugin } = make(files);
  const modal = new ImportModal(plugin);
  modal.onOpen();
  expect(modal.contentEl.querySelector<HTMLSelectElement>('select[data-field="backup"]')!.value).toBe(selected);
  modal.onClose();
 });
 it('lists json and txt backups in the dialog and imports the selected txt file', async () => {
  const input = JSON.stringify({ items: [note()] });
  const { app, plugin } = make({ 'backup.json': input, 'native.TXT': input, 'note.md': 'Text', 'archive.zip': 'Zip' });
  const modal = new ImportModal(plugin);
  modal.onOpen();
  const picker = modal.contentEl.querySelector<HTMLSelectElement>('select[data-field="backup"]')!;
  expect([...picker.options].map((o) => o.value)).toEqual(['backup.json', 'native.TXT']);
  picker.value = 'native.TXT';
  picker.dispatchEvent(new Event('change'));
  const report = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
  modal.contentEl.querySelector<HTMLButtonElement>('button[data-action="import"]')!.click();
  await vi.waitFor(() => expect(report).toHaveBeenCalled());
  expect(app.vault.getAbstractFileByPath('Standard Notes/Hello--n1.md')).not.toBeNull();
  expect(await app.vault.read(app.vault.getAbstractFileByPath('native.TXT') as never)).toBe(input);
  modal.onClose();
 });
 it.each(['.private', '..private'])('keeps the imported title %s visible in the vault', (title) => {
  const plan = planImport({ items: [note('n1', title)] });
  expect(plan.notes[0]?.path.split('/').at(-1)).not.toMatch(/^\./);
  expect(plan.notes[0]?.title).toBe(title);
 });
 it('does not use a deleted tag to select a destination', () => {
  const plan = planImport({ items: [note(), { uuid: 't1', content_type: 'Tag', deleted: true, content: { title: 'old', references: [{ uuid: 'n1', content_type: 'Note' }] } }] }, 'Default', [], [], [{ tag: 'old', folder: 'Wrong' }]);
  expect(plan.notes[0]?.path).toBe('Default/Hello--n1.md');
  expect(plan.notes[0]?.tags).toEqual([]);
  expect(plan.issues).toContainEqual({ uuid: 't1', reason: 'Deleted source tag' });
 });
 it.each(['---\nsource_uuid: n1\n---', '\uFEFF---\nsource_uuid: n1\n---\nLocal edit'])('finds a moved note with valid frontmatter %j', async (text) => {
  const { app, plugin } = make({ 'Moved.md': text });
  const create = vi.spyOn(app.vault, 'create');
  const plan = await plugin.importBackup({ items: [note()] }, 'Imported');
  expect(plan.notes).toHaveLength(0);
  expect(create).not.toHaveBeenCalled();
 });
 it('reports the same normalized path that the vault creates', async () => {
  const { app, plugin } = make();
  const plan = await plugin.importBackup({ items: [note('n1', 'Trip\u00a0plan')] }, 'Imported');
  expect(plan.notes[0]?.path).toBe('Imported/Trip plan--n1.md');
  expect(app.vault.getAbstractFileByPath(plan.notes[0]!.path)).not.toBeNull();
 });
 it('finds path conflicts after normalizing a title', async () => {
  const { plugin } = make({ 'Imported/Trip plan--n1.md': 'Keep' });
  const plan = await plugin.inspectBackup({ items: [note('n1', 'Trip\u00a0plan')] }, 'Imported');
  expect(plan.notes).toHaveLength(0);
  expect(plan.issues[0]?.reason).toContain('Path conflict');
 });
 it('joins a large shared tag without scanning its references for each note', () => {
  const count = 2000;
  let reads = 0;
  const refs = Array.from({ length: count }, (_, i) => ({ content_type: 'Note', get uuid() { reads++; return `n${i}`; } }));
  const parsed = parseBackup({ items: [...Array.from({ length: count }, (_, i) => note(`n${i}`)), { uuid: 't1', content_type: 'Tag', content: { title: 'work', references: refs } }] });
  expect(parsed.notes).toHaveLength(count);
  expect(parsed.notes.every((n) => n.tags.join() === 'work')).toBe(true);
  expect(reads).toBeLessThanOrEqual(count * 4);
 });
 it('does not start a timer after unload while waiting for layout', async () => {
  const { app, plugin } = make();
  let ready: (() => unknown) | undefined;
  vi.spyOn(app.workspace, 'onLayoutReady').mockImplementation((callback) => { ready = callback; });
  await plugin.onload();
  plugin.onunload();
  const interval = vi.spyOn(window, 'setInterval').mockReturnValue(1);
  ready?.();
  expect(interval).not.toHaveBeenCalled();
 });
 it('stops a pending import after unload', async () => {
  const { app, plugin } = make({ 'Existing.md': 'Unrelated' });
  let release!: () => void;
  vi.spyOn(app.vault, 'read').mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve('Unrelated'); }));
  const create = vi.spyOn(app.vault, 'create');
  const pending = plugin.importBackup({ items: [note()] }, 'Imported');
  const rejected = expect(pending).rejects.toThrow('unloaded');
  plugin.onunload();
  release();
  await rejected;
  expect(create).not.toHaveBeenCalled();
 });
 it('does not open a late report after unload', () => {
  const { plugin } = make();
  const open = vi.spyOn(ReportModal.prototype, 'open').mockImplementation(() => undefined);
  const openImport = vi.spyOn(ImportModal.prototype, 'open').mockImplementation(() => undefined);
  plugin.onunload();
  plugin.showReport({ notes: [], issues: [], changed: [] });
  plugin.openImport();
  expect(open).not.toHaveBeenCalled();
  expect(openImport).not.toHaveBeenCalled();
 });
 it('keeps an empty backup read only in an empty vault', async () => {
  const { app, plugin } = make();
  expect(await plugin.importBackup({ items: [] }, 'Imported')).toEqual({ notes: [], issues: [], changed: [] });
  expect(app.vault.getFiles()).toHaveLength(0);
 });
});
