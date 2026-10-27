import { Notice, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_RULES, PRO_UI, isPro, proNotice } from './pro';
import { object, safeFolder, type Rule } from './importer';
import type StandardNotesImportPlugin from './main';
import { helloSettingItems } from './hello/settings';

export interface ImportSettings { destination: string; rules: Rule[] }
export function normalizeSettings(value: unknown): ImportSettings {
 const settings: ImportSettings = { destination: 'Standard Notes', rules: [] };
 if (!object(value)) return settings;
 if (typeof value.destination === 'string') { try { settings.destination = safeFolder(value.destination); } catch { /* Use the default folder. */ } }
 if (Array.isArray(value.rules)) for (const raw of value.rules as unknown[]) {
  if (!object(raw) || typeof raw.tag !== 'string' || typeof raw.folder !== 'string' || !raw.tag.trim()) continue;
  try { settings.rules.push({ tag: raw.tag.trim(), folder: safeFolder(raw.folder) }); } catch { /* Drop unsafe paths. */ }
 }
 return settings;
}
export function parseRules(text: string): Rule[] {
 return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
  const split = line.indexOf(' => ');
  if (split < 1) throw new Error('Use one source tag => folder rule per line.');
  return { tag: line.slice(0, split).trim(), folder: safeFolder(line.slice(split + 4)) };
 });
}
function folderError(value: string): string | undefined {
 try { safeFolder(value); return undefined; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
export class ImportSettingTab extends PluginSettingTab {
 constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], public plugin: StandardNotesImportPlugin) { super(app, plugin); }
 getSettingDefinitions(): SettingDefinitionItem[] {
  // The product rows, then the "More from NoteMods" card (packages/hello).
  return [...this.productSettingDefinitions(), ...helloSettingItems()];
 }

 productSettingDefinitions(): SettingDefinitionItem[] {
  return [
   { name: 'Destination folder', desc: 'Default folder for new notes.', control: { type: 'text', key: 'destination', defaultValue: 'Standard Notes', validate: (v: string) => folderError(v) } },
   ...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
   { name: 'Saved tag rules (Pro)', desc: 'Use one source tag => folder rule per line. Source tag names are case sensitive. The first matching rule selects the folder.', render: (setting) => {
    let text = this.plugin.settings.rules.map((r) => `${r.tag} => ${r.folder}`).join('\n');
    setting.addTextArea((t) => t.setValue(text).setDisabled(!isPro()).onChange((v) => { text = v; }));
    setting.addButton((b) => b.setButtonText('Save rules').onClick(async () => {
     // A free user gets the shared Pro notice. No rule is saved. The text area stays read-only without Pro.
     if (!isPro()) { proNotice(PRO_RULES); return; }
     try { await this.plugin.saveRules(parseRules(text)); new Notice('Saved tag rules.'); }
     catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
    }));
   } },
  ];
 }
 async setControlValue(key: string, value: unknown): Promise<void> {
  if (key === 'destination') {
   try { this.plugin.settings.destination = safeFolder(String(value)); await this.plugin.saveSettings(); }
   catch (e) { new Notice(e instanceof Error ? e.message : String(e)); }
   return;
  }
  await super.setControlValue(key, value);
 }
}
