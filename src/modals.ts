import { Modal, Setting } from 'obsidian';
import { isPro, PRO_PREVIEW, proNotice } from './pro';
import type StandardNotesImportPlugin from './main';
import type { ImportPlan } from './importer';

export class ImportModal extends Modal {
 private path = '';
 private folder: string;
 constructor(private plugin: StandardNotesImportPlugin) {
  super(plugin.app);
  this.folder = plugin.settings.destination;
 }
 onOpen(): void {
  this.setTitle('Import a decrypted backup');
  this.contentEl.addClass('standard-notes-import');
  this.contentEl.createEl('p', { text: 'Select a decrypted .json or .txt backup in this vault. Encrypted notes and unsupported editors are skipped. Existing notes keep their text.' });
  const files = this.app.vault.getFiles().filter((f) => ['json', 'txt'].includes(f.extension.toLowerCase())).sort((a, b) => a.path.localeCompare(b.path));
  this.path = (files.find((f) => f.name === 'Standard Notes Backup and Import File.txt') ?? files.find((f) => f.extension.toLowerCase() === 'json') ?? files[0])?.path ?? '';
  if (!files.length) this.contentEl.createEl('p', { text: 'Put a decrypted .json or .txt backup in your vault, then open this command again.' });
  new Setting(this.contentEl).setName('Backup file').addDropdown((d) => {
   d.addOptions(Object.fromEntries(files.map((f) => [f.path, f.path]))).setValue(this.path).onChange((v) => { this.path = v; });
   d.selectEl.dataset.field = 'backup';
  });
  new Setting(this.contentEl).setName('Destination folder').setDesc('New notes use this folder. Pro tag rules can select another folder.').addText((t) => {
   t.setValue(this.folder).onChange((v) => { this.folder = v; });
   t.inputEl.dataset.field = 'destination';
  });
  const status = this.contentEl.createEl('p', { cls: 'sni-status', attr: { role: 'status' } });
  new Setting(this.contentEl).setName('Check the backup').setDesc('The free report lists new paths and skipped records. The pro preview also shows changed source records.').addButton((b) => b.setButtonText('Check backup').setDisabled(!this.path).onClick(async () => {
   b.setDisabled(true);
   try { this.plugin.showReport(await this.plugin.inspectBackup(await this.plugin.readBackup(this.path), this.folder)); }
   catch (e) { status.setText(e instanceof Error ? e.message : String(e)); }
   finally { b.setDisabled(false); }
  })).addButton((b) => b.setButtonText('Preview changes (pro)').setDisabled(!this.path).onClick(async () => {
   // A free user gets the shared Pro notice. No backup is read and no preview opens.
   if (!isPro()) { proNotice(PRO_PREVIEW); return; }
   b.setDisabled(true);
   try { this.plugin.showReport(await this.plugin.inspectBackup(await this.plugin.readBackup(this.path), this.folder, true)); }
   catch (e) { status.setText(e instanceof Error ? e.message : String(e)); }
   finally { b.setDisabled(false); }
  }));
  new Setting(this.contentEl).setName('Create new notes').setDesc('The backup stays in place. Repeat imports skip source identifiers found in vault properties.').addButton((b) => {
   b.setButtonText('Import notes').setCta().setDisabled(!this.path).onClick(async () => {
    b.setDisabled(true);
    try {
     const plan = await this.plugin.importBackup(await this.plugin.readBackup(this.path), this.folder);
     this.close();
     this.plugin.showReport(plan, true);
    } catch (e) { status.setText(e instanceof Error ? e.message : String(e)); b.setDisabled(false); }
   });
   b.buttonEl.dataset.action = 'import';
  });
 }
 onClose(): void { this.contentEl.empty(); this.plugin.forgetModal(this); }
}

export class ReportModal extends Modal {
 constructor(private plugin: StandardNotesImportPlugin, private plan: ImportPlan, private imported: boolean) { super(plugin.app); }
 onOpen(): void {
  this.setTitle(this.imported ? 'Standard Notes import report' : 'Standard Notes backup check');
  const el = this.contentEl;
  el.addClass('standard-notes-import');
  el.createEl('p', { text: `${this.imported ? 'Created' : 'Ready'}: ${this.plan.notes.length} notes. Report entries: ${this.plan.issues.length}. Changed records: ${this.plan.changed.length}.`, cls: 'sni-summary' });
  el.createEl('p', { text: this.imported ? 'The backup and existing notes stay in place.' : 'This check writes no notes. Changed records are for review; version 1 does not merge updates.' });
  const rows = el.createDiv({ cls: 'sni-report' });
  for (const note of this.plan.notes) {
   const row = rows.createDiv({ cls: 'sni-row' });
   row.createEl('strong', { text: note.title || '(empty title)' });
   row.createDiv({ text: note.path });
   row.createEl('small', { text: `UUID ${note.uuid} · Tags: ${note.tags.join(', ') || '(none)'}` });
  }
  if (isPro()) for (const change of this.plan.changed) {
   const block = rows.createEl('details', { cls: 'sni-change' });
   block.createEl('summary', { text: `Changed: ${change.path}` });
   const comparison = block.createDiv({ cls: 'sni-comparison' });
   for (const [label, record] of [['Existing vault record', change.before], ['New backup record', change.after]] as const) {
    const column = comparison.createDiv({ cls: 'sni-column' });
    column.createEl('strong', { text: label });
    if (!record) { column.createEl('p', { text: 'Source properties are incomplete.' }); continue; }
    column.createEl('p', { text: `Title: ${record.title}` });
    column.createEl('small', { text: `Tags: ${record.tags.join(', ') || '(none)'} · Created: ${record.createdAt ?? '(none)'} · Updated: ${record.updatedAt ?? '(none)'}` });
    column.createEl('pre', { text: record.text });
   }
  }
  for (const issue of this.plan.issues) rows.createEl('p', { text: `${issue.uuid}: ${issue.reason}`, cls: 'sni-issue' });
  new Setting(el).addButton((b) => b.setButtonText('Close report').onClick(() => this.close()));
 }
 onClose(): void { this.contentEl.empty(); this.plugin.forgetModal(this); }
}
