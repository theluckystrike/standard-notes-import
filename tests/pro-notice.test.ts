import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice, Setting } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import StandardNotesImportPlugin from '../src/main';
import { ImportModal } from '../src/modals';
import { ImportSettingTab } from '../src/settings';
import { bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

// A free user can select "Preview changes (pro)" in the import window and "Save rules" in the settings. The select
// shows the shared Pro notice with the "Sponsor on GitHub" button. No preview opens, no backup is read, no rule is saved.
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';
const PREVIEW_LEAD = 'The changed record preview needs Pro.';
const RULES_LEAD = 'Saved tag rules need Pro.';
const BACKUP = JSON.stringify({ items: [{ uuid: 'n1', content_type: 'Note', content: { title: 'Hello', text: 'Hello', references: [] } }] });

function fakePro(pro: boolean): SponsorsManager {
 return {
  isPro: () => pro,
  onChange: () => () => undefined,
  hasToken: () => false,
  isChecking: () => false,
  getState: () => ({ status: 'unchecked', lastAttemptAt: 0 }),
  config: { sponsorLogin: 'theluckystrike', source: 'standard-notes-import' },
 } as unknown as SponsorsManager;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(pro: boolean) {
 const app = App.createConfigured__({ files: { 'backup.json': BACKUP } });
 const plugin = new StandardNotesImportPlugin(app as never, manifest as never);
 plugin.saveSettings = vi.fn(async () => undefined);
 bindPro(fakePro(pro));
 const shown: { text: string; buttons: number }[] = [];
 vi.spyOn(Notice.prototype as unknown as { constructor__(): void }, 'constructor__').mockImplementation(function (this: Notice) {
  shown.push({ text: this.messageEl.textContent ?? '', buttons: this.messageEl.querySelectorAll('.pf-pro-notice-sponsor').length });
 });
 const report = vi.spyOn(plugin, 'showReport').mockImplementation(() => undefined);
 return { app, plugin, shown, report };
}
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === text)!;

function rulesRow(app: unknown, plugin: StandardNotesImportPlugin): HTMLElement {
 const def = new ImportSettingTab(app as never, plugin).getSettingDefinitions().find((d) => d.name === 'Saved tag rules (Pro)') as { render: (s: Setting) => void };
 const el = document.createElement('div');
 def.render(new Setting(el));
 return el;
}

describe('Pro controls of Standard Notes Import', () => {
 afterEach(() => { resetPro(); vi.restoreAllMocks(); });

 it('a free user who selects Preview changes or Save rules gets the Pro notice with a Sponsor button, and nothing runs or saves', async () => {
  const { app, plugin, shown, report } = setup(false);
  const read = vi.spyOn(plugin, 'readBackup');
  const saveRules = vi.spyOn(plugin, 'saveRules');
  const modal = new ImportModal(plugin);
  modal.onOpen();
  const preview = button(modal.contentEl, 'Preview changes (pro)');
  expect(preview.disabled).toBe(false);
  preview.click(); await flush();
  // The button stays available, and the free status line has no error.
  expect(button(modal.contentEl, 'Preview changes (pro)').disabled).toBe(false);
  expect(modal.contentEl.querySelector('.sni-status')?.textContent).toBe('');
  const row = rulesRow(app, plugin);
  const save = button(row, 'Save rules');
  expect(save.disabled).toBe(false);
  save.click(); await flush();
  expect(shown).toEqual([
   { text: `${PREVIEW_LEAD} ${PITCH}Sponsor on GitHub`, buttons: 1 },
   { text: `${RULES_LEAD} ${PITCH}Sponsor on GitHub`, buttons: 1 },
  ]);
  expect(read).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(saveRules).not.toHaveBeenCalled();
  expect(plugin.saveSettings).not.toHaveBeenCalled();
  expect(plugin.settings.rules).toEqual([]);
  // The free check still runs.
  button(modal.contentEl, 'Check backup').click();
  await vi.waitFor(() => { expect(report).toHaveBeenCalledTimes(1); });
  modal.close();
 });

 it('a Pro user who selects Preview changes and Save rules gets the preview and saves the rules, with no Pro notice', async () => {
  const { app, plugin, shown, report } = setup(true);
  const inspect = vi.spyOn(plugin, 'inspectBackup');
  const modal = new ImportModal(plugin);
  modal.onOpen();
  button(modal.contentEl, 'Preview changes (pro)').click();
  await vi.waitFor(() => { expect(report).toHaveBeenCalledTimes(1); });
  expect(inspect).toHaveBeenCalledWith(expect.anything(), 'Standard Notes', true);
  await vi.waitFor(() => { expect(button(modal.contentEl, 'Preview changes (pro)').disabled).toBe(false); });
  const row = rulesRow(app, plugin);
  const area = row.querySelector('textarea')!;
  expect(area.disabled).toBe(false);
  area.value = 'work => Imported/Work';
  area.dispatchEvent(new Event('input'));
  button(row, 'Save rules').click();
  await vi.waitFor(() => { expect(plugin.saveSettings).toHaveBeenCalled(); });
  expect(plugin.settings.rules).toEqual([{ tag: 'work', folder: 'Imported/Work' }]);
  expect(shown.filter((n) => n.buttons > 0)).toEqual([]);
  modal.close();
 });
});
