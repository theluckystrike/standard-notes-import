import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import StandardNotesImportPlugin, { existingNote, renderNote } from '../src/main';
import { parseBackup, safeFolder, safeTitle, tagValue } from '../src/importer';
import { normalizeSettings, parseRules } from '../src/settings';
import { bindPro, resetPro, SPONSORS } from '../src/pro';
import manifest from '../manifest.json';

const backup = { items: [{ uuid: 'n1', content_type: 'Note', created_at: '2020-01-01', updated_at: '2021-01-01', content: { title: 'Hello', text: 'Hello', references: [] } }] };
const make = (files: Record<string, string> = {}) => {
 const app = App.createConfigured__({ files });
 return { app, plugin: new StandardNotesImportPlugin(app as never, manifest as never) };
};
function pro(value: boolean) { bindPro({ isPro: () => value, onChange: () => () => undefined } as never); }
afterEach(() => resetPro());

describe('vault import', () => {
 it('creates source properties and keeps the source backup', async () => {
  const json = JSON.stringify(backup);
  const { app, plugin } = make({ 'backup.json': json });
  const input = await plugin.readBackup('backup.json');
  const report = await plugin.importBackup(input, 'Imported/Notes');
  expect(report.notes).toHaveLength(1);
  const file = app.vault.getAbstractFileByPath('Imported/Notes/Hello--n1.md')!;
  const text = await app.vault.read(file as never);
  expect(existingNote(file.path, text)?.source).toEqual(parseBackup(backup).notes[0]);
  expect(await app.vault.read(app.vault.getAbstractFileByPath('backup.json') as never)).toBe(json);
 });
 it('repeat import keeps edits in an existing note', async () => {
  const original = renderNote({ uuid: 'n1', title: 'Hello', text: 'My vault edit', tags: [] });
  const { app, plugin } = make({ 'Old.md': original });
  const result = await plugin.importBackup(backup, 'Imported');
  expect(result.notes).toHaveLength(0);
  expect(result.issues[0]?.reason).toContain('Duplicate UUID');
  expect(await app.vault.read(app.vault.getAbstractFileByPath('Old.md') as never)).toBe(original);
 });
 it('keeps a file that occupies the output path', async () => {
  const { app, plugin } = make({ 'Imported/Hello--n1.md': 'Keep me' });
  const result = await plugin.importBackup(backup, 'Imported');
  expect(result.notes).toHaveLength(0);
  expect(result.issues[0]?.reason).toContain('Path conflict');
  expect(await app.vault.read(app.vault.getAbstractFileByPath('Imported/Hello--n1.md') as never)).toBe('Keep me');
 });
 it('reports a file in place of a parent folder', async () => {
  const { plugin } = make({ 'Imported': 'Block' });
  expect((await plugin.importBackup(backup, 'Imported/Notes')).issues[0]?.reason).toContain('Path conflict');
 });
 it('reports write failures and releases the import guard', async () => {
  const { app, plugin } = make();
  const create = vi.spyOn(app.vault, 'create').mockRejectedValueOnce(new Error('Disk full'));
  const result = await plugin.importBackup(backup, 'Imported');
  expect(result.notes).toHaveLength(0);
  expect(result.issues[0]?.reason).toContain('Disk full');
  create.mockRestore();
  expect((await plugin.importBackup(backup, 'Imported')).notes).toHaveLength(1);
 });
 it('blocks parallel imports in the same plugin', async () => {
  const { plugin } = make();
  const first = plugin.importBackup(backup, 'Imported');
  await expect(plugin.importBackup(backup, 'Imported')).rejects.toThrow('already in progress');
  await first;
 });
 it('rejects non JSON files and invalid JSON', async () => {
  const { plugin } = make({ 'bad.json': '{', 'note.md': 'Text' });
  await expect(plugin.readBackup('bad.json')).rejects.toThrow('not valid JSON');
  await expect(plugin.readBackup('note.md')).rejects.toThrow('Select a JSON');
 });
});

describe('Pro guards', () => {
 it('blocks save and preview without Pro', async () => {
  const { plugin } = make();
  await expect(plugin.saveRules([{ tag: 'work', folder: 'Work' }])).rejects.toThrow('need Pro');
  await expect(plugin.inspectBackup(backup, 'Imported', true)).rejects.toThrow('needs Pro');
 });
 it('ignores saved rules after Pro ends and keeps core free', async () => {
  const { plugin } = make();
  plugin.settings.rules = [{ tag: 'work', folder: 'Work' }];
  const tagged = { items: [{ ...backup.items[0], content: { ...backup.items[0]!.content, references: [{ uuid: 't1', content_type: 'Tag' }] } }, { uuid: 't1', content_type: 'Tag', content: { title: 'work' } }] };
  pro(true);
  expect((await plugin.inspectBackup(tagged, 'Imported')).notes[0]?.path).toBe('Work/Hello--n1.md');
  resetPro();
  expect((await plugin.importBackup(tagged, 'Imported')).notes[0]?.path).toBe('Imported/Hello--n1.md');
 });
 it('saves validated rules and previews changed text without writing', async () => {
  const old = renderNote({ uuid: 'n1', title: 'Hello', text: 'Old', tags: [] });
  const { app, plugin } = make({ 'Old.md': old });
  pro(true);
  await plugin.saveRules([{ tag: 'work', folder: 'Imported/Work' }]);
  expect(plugin.settings.rules).toEqual([{ tag: 'work', folder: 'Imported/Work' }]);
  const plan = await plugin.inspectBackup(backup, 'Imported', true);
  expect(plan.changed[0]?.before?.text).toBe('Old');
  expect(plan.changed[0]?.after.text).toBe('Hello');
  expect(await app.vault.read(app.vault.getAbstractFileByPath('Old.md') as never)).toBe(old);
 });
 it('rejects traversal and duplicate rule tags', async () => {
  const { plugin } = make(); pro(true);
  await expect(plugin.saveRules([{ tag: 'work', folder: '../outside' }])).rejects.toThrow('relative folder');
  await expect(plugin.saveRules([{ tag: 'work', folder: 'A' }, { tag: 'work', folder: 'B' }])).rejects.toThrow('one rule');
 });
 it('uses the reference sponsorship terms', () => {
  expect(SPONSORS).toMatchObject({ clientId: 'Ov23lic5UPGPZqhBlBGg', minMonthlyUsd: 5, oneTimeUsd: 15, sponsorLogin: 'theluckystrike', oneTimeMonths: 0, scope: 'read:user' });
 });
});

describe('input boundaries', () => {
 it.each([null, [], {}, { items: {} }, { items: [], version: '005' }])('rejects unsupported roots %j', (input) => expect(() => parseBackup(input)).toThrow());
 it.each(['../escape', '/root', '.obsidian/plugins', 'A//B', 'CON', 'A/..', 'A/NUL', 'A.'])('rejects unsafe destination %s', (folder) => expect(() => safeFolder(folder)).toThrow());
 it('keeps YAML title and body text without injection', () => {
  const note = { uuid: 'n1', title: '---\nsource_uuid: fake\n日本', text: '---\nThis is body\n', tags: ['123', 'work projects', '日本'] };
  expect(existingNote('A.md', renderNote(note))?.source).toEqual(note);
  expect(tagValue('work projects')).toBe('work_projects');
  expect(tagValue('123')).toBe('tag_123');
 });
 it('bounds Unicode filenames without splitting a character', () => {
  const title = safeTitle('日本😀'.repeat(100));
  expect(new TextEncoder().encode(title).length).toBeLessThanOrEqual(128);
  expect([...title].length).toBeLessThanOrEqual(80);
  expect(title).not.toMatch(/[\ud800-\udbff]$/);
 });
 it('repairs saved settings and parses rules', () => {
  expect(normalizeSettings({ destination: '../outside', rules: [{ tag: 'work', folder: '../outside' }] })).toEqual(normalizeSettings(null));
  expect(parseRules('work => Imported/Work\n\n日本 => 日本')).toEqual([{ tag: 'work', folder: 'Imported/Work' }, { tag: '日本', folder: '日本' }]);
  expect(() => parseRules('invalid')).toThrow('one source tag');
 });
});
