import { browser, expect } from '@wdio/globals';
import type StandardNotesImportPlugin from '../../src/main';

function backup() {
 return { version: '004', items: [
  { uuid: 'e2e-1', content_type: 'Note', created_at: '2020-01-01T00:00:00Z', updated_at: '2024-02-03T00:00:00Z', content: { title: 'Trip / 日本', text: '# A trip\n\nKeep this text.', references: [{ uuid: 'e2e-tag', content_type: 'Tag' }] } },
  { uuid: 'e2e-2', content_type: 'Note', content: { title: 'Trip / 日本', text: 'Second note', editorIdentifier: 'org.standardnotes.simple-markdown-editor' } },
  { uuid: 'e2e-tag', content_type: 'Tag', content: { title: 'work', references: [{ uuid: 'e2e-1', content_type: 'Note' }] } },
  { uuid: 'e2e-1', content_type: 'Note', content: { title: 'Duplicate', text: 'Do not replace' } },
  { uuid: 'e2e-secret', content_type: 'Note', content: '004:ciphertext' },
  { uuid: 'e2e-rich', content_type: 'Note', content: { title: 'Rich', text: 'data', editorIdentifier: 'org.standardnotes.super' } },
 ] };
}

describe('Standard Notes import behavior', () => {
 it('imports through the command dialog and keeps the backup', async () => {
  await browser.executeObsidian(async ({ app }) => {
   await app.vault.create('ui-backup.json', JSON.stringify({ items: [{ uuid: 'ui-note', content_type: 'Note', content: { title: 'From dialog', text: 'Hello from the dialog', references: [] } }] }));
  });
  await browser.executeObsidianCommand('standard-notes-import:import-backup');
  const picker = browser.$('select[data-field="backup"]');
  await picker.waitForDisplayed();
  await picker.selectByAttribute('value', 'ui-backup.json');
  await browser.$('input[data-field="destination"]').setValue('Dialog import');
  await browser.$('button[data-action="import"]').click();
  await browser.waitUntil(async () => browser.executeObsidian(({ app }) => !!app.vault.getAbstractFileByPath('Dialog import/From dialog--ui-note.md')));
  await browser.$('.sni-summary').waitForDisplayed();
  expect(await browser.$('.sni-summary').getText()).toContain('Created: 1 notes');
  const result = await browser.executeObsidian(async ({ app }) => {
   const file = app.vault.getFiles().find((f) => f.path === 'Dialog import/From dialog--ui-note.md')!;
   return { body: await app.vault.read(file), backup: !!app.vault.getAbstractFileByPath('ui-backup.json') };
  });
  expect(result.body).toContain('source_uuid: ui-note');
  expect(result.body).toContain('Hello from the dialog');
  expect(result.backup).toBe(true);
  await browser.keys('Escape');
 });
 it('keeps dot titles visible and recognizes normalized paths and moved empty notes', async () => {
  const result = await browser.executeObsidian(async ({ app }) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, StandardNotesImportPlugin> } }).plugins.plugins['standard-notes-import']!;
   await app.vault.create('Moved empty.md', '---\nsource_uuid: review-empty\n---');
   const input = { items: [
    { uuid: 'review-hidden', content_type: 'Note', content: { title: '.private', text: 'Visible text' } },
    { uuid: 'review-space', content_type: 'Note', content: { title: 'Trip\u00a0plan', text: 'Space text' } },
    { uuid: 'review-empty', content_type: 'Note', content: { title: 'Empty', text: 'Do not duplicate' } },
   ] };
   const plan = await plugin.importBackup(input, 'Review');
   return { paths: plan.notes.map((n) => n.path), visible: app.vault.getFiles().filter((f) => f.path.startsWith('Review/')).map((f) => f.path), issues: plan.issues };
  });
  expect(result.paths).toEqual(['Review/Note-.private--review-hidden.md', 'Review/Trip plan--review-space.md']);
  expect(result.visible.sort()).toEqual([...result.paths].sort());
  expect(result.issues[0]?.reason).toContain('Duplicate UUID');
 });
 it('joins both tag directions, retains dates and reports skips', async () => {
  const result = await browser.executeObsidian(async ({ app }, input) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, StandardNotesImportPlugin> } }).plugins.plugins['standard-notes-import']!;
   const report = await plugin.importBackup(input, 'Cases');
   const first = app.vault.getFiles().find((f) => f.path === 'Cases/Trip - 日本--e2e-1.md')!;
   return { report, text: await app.vault.read(first) };
  }, backup());
  expect(result.report.notes).toHaveLength(2);
  expect(result.report.notes[0].tags).toEqual(['work']);
  expect(result.report.issues.map((i) => i.reason)).toEqual(['Duplicate UUID in backup', 'Encrypted content: select a decrypted backup', 'Unsupported editor: org.standardnotes.super']);
  expect(result.text).toContain('source_created_at:');
  expect(result.text).toContain('2020-01-01T00:00:00Z');
  expect(result.text).toContain('2024-02-03T00:00:00Z');
  expect(result.text).toContain('source_title: Trip / 日本');
 });
 it('repeat imports and occupied paths preserve existing files', async () => {
  const result = await browser.executeObsidian(async ({ app }, input) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, StandardNotesImportPlugin> } }).plugins.plugins['standard-notes-import']!;
   const file = app.vault.getFiles().find((f) => f.path === 'Cases/Trip - 日本--e2e-1.md')!;
   const before = await app.vault.read(file);
   const repeat = await plugin.importBackup(input, 'Elsewhere');
   await app.vault.createFolder('Conflicts');
   const conflict = await app.vault.create('Conflicts/Keep--conflict-note.md', 'Keep existing text');
   const occupied = await plugin.importBackup({ items: [{ uuid: 'conflict-note', content_type: 'Note', content: { title: 'Keep', text: 'Replace me' } }] }, 'Conflicts');
   return { count: repeat.notes.length, same: before === await app.vault.read(file), occupied, conflict: await app.vault.read(conflict) };
  }, backup());
  expect(result.count).toBe(0);
  expect(result.same).toBe(true);
  expect(result.occupied.notes).toHaveLength(0);
  expect(result.occupied.issues[0].reason).toContain('Path conflict');
  expect(result.conflict).toBe('Keep existing text');
 });
 it('uses the Sponsors check for saved rules and repeat preview', async () => {
  const result = await browser.executeObsidian(async ({ app }) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, StandardNotesImportPlugin> } }).plugins.plugins['standard-notes-import']!;
   const manager = plugin.pro!;
   const requests: string[] = [];
   (manager as unknown as { opts: { http: (r: { url: string }) => Promise<unknown> } }).opts.http = async (r) => {
    requests.push(r.url);
    return { status: 200, json: { data: { viewer: { login: 'test-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } };
   };
   app.secretStorage.setSecret('standard-notes-import-github-token', 'gho_' + '0'.repeat(36));
   try {
    await manager.refreshNow();
    await plugin.saveRules([{ tag: 'work', folder: 'Rule output' }]);
    const input = { items: [{ uuid: 'pro-note', content_type: 'Note', content: { title: 'Work', text: 'First', references: [{ uuid: 'pro-tag', content_type: 'Tag' }] } }, { uuid: 'pro-tag', content_type: 'Tag', content: { title: 'work', references: [] } }] };
    const first = await plugin.importBackup(input, 'Default');
    input.items[0]!.content.text = 'Changed';
    const preview = await plugin.inspectBackup(input, 'Default', true);
    plugin.showReport(preview);
    const visible = document.querySelector('.sni-change')?.textContent ?? '';
    const file = app.vault.getFiles().find((f) => f.path === 'Rule output/Work--pro-note.md')!;
    const kept = await app.vault.read(file);
    manager.signOut();
    let blocked = false;
    try { await plugin.inspectBackup(input, 'Default', true); } catch { blocked = true; }
    return { path: first.notes[0]?.path, changed: preview.changed.length, visible, kept, blocked, requests };
   } finally { manager.signOut(); }
  });
  expect(result.path).toBe('Rule output/Work--pro-note.md');
  expect(result.changed).toBe(1);
  expect(result.visible).toContain('First');
  expect(result.visible).toContain('Changed');
  expect(result.kept).toContain('First');
  expect(result.blocked).toBe(true);
  expect(result.requests).toEqual(['https://api.github.com/graphql']);
  await browser.keys('Escape');
 });
});
