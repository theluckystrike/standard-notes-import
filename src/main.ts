import { Notice, Plugin, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from 'obsidian';
import { createGitHubSponsors } from './license/github-obsidian';
import type { SponsorsManager } from './license/index';
import { bindPro, isPro, resetPro, SPONSORS } from './pro';
import { object, planImport, safeFolder, tagValue, type Existing, type ImportPlan, type PlannedNote, type Rule, type SourceNote } from './importer';
import { ImportModal, ReportModal } from './modals';
import { ImportSettingTab, normalizeSettings, type ImportSettings } from './settings';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

export function renderNote(note: SourceNote): string {
 const properties = {
  source_uuid: note.uuid,
  source_title: note.title,
  ...(note.createdAt !== undefined ? { source_created_at: note.createdAt } : {}),
  ...(note.updatedAt !== undefined ? { source_updated_at: note.updatedAt } : {}),
  source_tags: note.tags,
  tags: [...new Set(note.tags.map(tagValue))],
 };
 return `---\n${stringifyYaml(properties)}---\n${note.text}`;
}

/** Reads an import identity from disk, without waiting for the metadata cache. */
export function existingNote(path: string, text: string): Existing | null {
 const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
 if (!match) return null;
 let value: unknown;
 try { value = parseYaml(match[1]!); } catch { return null; }
 if (!object(value) || typeof value.source_uuid !== 'string') return null;
 const source: SourceNote | undefined = typeof value.source_title === 'string' && Array.isArray(value.source_tags) && value.source_tags.every((v: unknown) => typeof v === 'string')
  ? { uuid: value.source_uuid, title: value.source_title, text: text.slice(match[0].length), tags: [...value.source_tags].sort(),
   ...(typeof value.source_created_at === 'string' ? { createdAt: value.source_created_at } : {}),
   ...(typeof value.source_updated_at === 'string' ? { updatedAt: value.source_updated_at } : {}) }
  : undefined;
 return { uuid: value.source_uuid, path, source };
}

export default class StandardNotesImportPlugin extends Plugin {
 settings: ImportSettings = normalizeSettings(null);
 pro: SponsorsManager | null = null;
 private importing = false;
 private unloaded = false;
 private tab: ImportSettingTab | null = null;
 private modals = new Set<ImportModal | ReportModal>();

 async onload(): Promise<void> {
  // First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
  setupHello(this, WHATS_NEW);
  this.unloaded = false;
  const saved: unknown = await this.loadData();
  if (this.unloaded) return;
  this.settings = normalizeSettings(saved);
  const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
  pro.init();
  this.pro = pro;
  bindPro(pro);
  this.tab = new ImportSettingTab(this.app, this);
  this.addSettingTab(this.tab);
  this.register(pro.onChange(() => this.tab?.update()));
  this.addCommand({ id: 'import-backup', name: 'Import a decrypted backup', callback: () => this.openImport() });
  this.app.workspace.onLayoutReady(() => {
   if (this.unloaded) return;
   void pro.refresh();
   this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
  });
 }
 onunload(): void {
  this.unloaded = true;
  for (const modal of this.modals) modal.close();
  this.modals.clear();
  resetPro();
 }
 openImport(): void {
  if (this.unloaded) return;
  const modal = new ImportModal(this);
  this.modals.add(modal);
  modal.open();
 }
 showReport(plan: ImportPlan, imported = false): void {
  if (this.unloaded) return;
  const modal = new ReportModal(this, plan, imported);
  this.modals.add(modal);
  modal.open();
 }
 forgetModal(modal: ImportModal | ReportModal): void { this.modals.delete(modal); }
 async saveSettings(): Promise<void> { await this.saveData(this.settings); }
 async saveRules(rules: Rule[]): Promise<void> {
  if (!isPro()) throw new Error('Saved tag rules need Pro. Sign in from the plugin settings.');
  const checked = rules.map((r) => ({ tag: r.tag.trim(), folder: safeFolder(r.folder) }));
  if (checked.some((r) => !r.tag)) throw new Error('A rule needs a source tag.');
  if (new Set(checked.map((r) => r.tag)).size !== checked.length) throw new Error('Use one rule for each source tag.');
  this.settings.rules = checked;
  await this.saveSettings();
 }
 async readBackup(path: string): Promise<unknown> {
  const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile) || !['json', 'txt'].includes(file.extension.toLowerCase())) throw new Error('Select a .json or .txt backup in this vault.');
  const text = await this.app.vault.read(file);
  try { return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown; } catch { throw new Error('The backup is not valid JSON.'); }
 }
 async inspectBackup(input: unknown, folder: string, preview = false): Promise<ImportPlan> {
  this.requireLoaded();
  if (preview && !isPro()) throw new Error('The changed record preview needs Pro. Sign in from the plugin settings.');
  const existing: Existing[] = [];
  const files = this.app.vault.getFiles();
  for (const file of files) {
   if (file.extension.toLowerCase() !== 'md') continue;
   const note = existingNote(file.path, await this.app.vault.read(file));
   this.requireLoaded();
   if (note) existing.push(note);
  }
  const plan = planImport(input, normalizePath(safeFolder(folder)), existing, files.map((f) => f.path), isPro() ? this.settings.rules : [], preview);
  const available: PlannedNote[] = [];
  for (const note of plan.notes) {
   const segments = note.path.split('/');
   const blocked = segments.slice(0, -1).some((_, i) => {
    const entry = this.app.vault.getAbstractFileByPath(segments.slice(0, i + 1).join('/'));
    return entry !== null && !(entry instanceof TFolder);
   });
   if (blocked || this.app.vault.getAbstractFileByPath(note.path)) plan.issues.push({ uuid: note.uuid, reason: `Path conflict: ${note.path}` });
   else available.push(note);
  }
  plan.notes = available;
  return plan;
 }
 async importBackup(input: unknown, folder: string): Promise<ImportPlan> {
  if (this.importing) throw new Error('An import is already in progress.');
  this.importing = true;
  try {
   const plan = await this.inspectBackup(input, folder);
   this.requireLoaded();
   const written: PlannedNote[] = [];
   for (const note of plan.notes) {
    this.requireLoaded();
    try {
     await this.ensureFolder(note.path.substring(0, note.path.lastIndexOf('/')));
     this.requireLoaded();
     const path = normalizePath(note.path);
     if (this.app.vault.getAbstractFileByPath(path)) throw new Error('The output path is occupied.');
     await this.app.vault.create(path, renderNote(note));
     written.push(note);
    } catch (error) {
     this.requireLoaded();
     plan.issues.push({ uuid: note.uuid, reason: `Write failed at ${note.path}: ${error instanceof Error ? error.message : String(error)}` });
    }
   }
   plan.notes = written;
   this.requireLoaded();
   new Notice(`Imported ${written.length} notes. Report entries: ${plan.issues.length}.`);
   return plan;
  } finally { this.importing = false; }
 }
 private requireLoaded(): void {
  if (this.unloaded) throw new Error('The plugin was unloaded. Notes already created stay in the vault.');
 }
 private async ensureFolder(folder: string): Promise<void> {
  const segments = normalizePath(folder).split('/');
  for (let i = 1; i <= segments.length; i++) {
   this.requireLoaded();
   const path = normalizePath(segments.slice(0, i).join('/'));
   const entry = this.app.vault.getAbstractFileByPath(path);
   if (entry instanceof TFolder) continue;
   if (entry) throw new Error(`A file blocks the folder: ${path}`);
   try { await this.app.vault.createFolder(path); }
   catch (error) { if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw error; }
  }
 }
}
