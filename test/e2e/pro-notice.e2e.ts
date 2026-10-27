import { browser, expect } from '@wdio/globals';
import type StandardNotesImportPlugin from '../../src/main';
import type { SponsorsManager } from '../../src/license/index';

// A free user can select "Preview changes (pro)" in the import window and "Save rules" in the settings. The select
// shows the shared Pro notice with the "Sponsor on GitHub" button. No report opens and no rule is saved.
// A Pro user gets the changed record preview.
type Host = { plugins: { plugins: Record<string, StandardNotesImportPlugin> }; setting: { open(): void; close(): void; openTabById(id: string): void } };
const ID = 'standard-notes-import';
const BACKUP = 'w4 pro notice backup.json';

async function setPro(on: boolean): Promise<boolean> {
 return browser.executeObsidian(async ({ app }, enabled) => {
  const p = (app as unknown as Host).plugins.plugins['standard-notes-import']!;
  const pro = p.pro as SponsorsManager;
  if (!enabled) { pro.signOut(); return pro.isPro(); }
  // Synthetic token store and HTTP answer. No network request or Keychain key.
  let token: string | null = 'gho_' + '0'.repeat(36);
  pro.opts.tokens.get = () => token; pro.opts.tokens.set = (v) => { token = v; }; pro.opts.tokens.clear = () => { token = null; };
  pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader', totalSponsorshipAmountAsSponsorInCents: 1500 }, user: { viewerIsSponsoring: true, sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
  await pro.refreshNow();
  return pro.isPro();
 }, on);
}

/** Opens the import window with the test backup selected. */
async function openWindow(): Promise<void> {
 await browser.executeObsidian(async ({ app }, name) => {
  activeDocument.querySelectorAll('.notice').forEach((n) => n.remove());
  if (!app.vault.getAbstractFileByPath(name)) await app.vault.create(name, JSON.stringify({ items: [{ uuid: 'w4-note', content_type: 'Note', content: { title: 'W4 note', text: 'Text', references: [] } }] }));
 }, BACKUP);
 await browser.executeObsidianCommand(`${ID}:import-backup`);
 const picker = browser.$('select[data-field="backup"]');
 await picker.waitForDisplayed();
 await picker.selectByAttribute('value', BACKUP);
}

/** Selects the button with this text in the open import window or settings tab, then returns the notices and the state. */
async function select(text: string) {
 // The settings tab draws its rows after openTabById, so wait for the button first.
 // A row below the fold can be drawn only after a scroll, so scroll the settings page down while waiting.
 await browser.waitUntil(async () => browser.execute((t) => {
  activeWindow.document.querySelectorAll('.vertical-tab-content, .modal-content').forEach((el) => { el.scrollTop = el.scrollHeight; });
  return [...activeWindow.document.querySelectorAll('button')].some((b) => b.textContent === t);
 }, text), { timeout: 8000, timeoutMsg: `No button "${text}".` }).catch(async (e: unknown) => {
  const seen = await browser.execute(() => [...activeWindow.document.querySelectorAll('button, .setting-item-name')].map((b) => b.textContent).join(' | '));
  throw new Error(`${String(e)} Seen: ${seen}`);
 });
 return browser.executeObsidian(async ({ app }, text) => {
  const doc = activeWindow.document;
  doc.querySelectorAll('.notice').forEach((n) => n.remove());
  const button = [...doc.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`No button "${text}".`);
  const disabled = button.disabled;
  button.click();
  await new Promise((r) => setTimeout(r, 500));
  const p = (app as unknown as Host).plugins.plugins['standard-notes-import']!;
  return {
   disabled,
   notices: [...doc.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', sponsor: n.querySelectorAll('.pf-pro-notice-sponsor').length })),
   reports: doc.querySelectorAll('.sni-summary').length,
   status: doc.querySelector('.sni-status')?.textContent ?? '',
   rules: JSON.stringify(p.settings.rules),
   saved: JSON.stringify((await p.loadData()) ?? {}),
  };
 }, text);
}

async function closeAll(): Promise<void> {
 await browser.executeObsidian(({ app }) => {
  (app as unknown as Host).setting.close();
  activeDocument.querySelectorAll('.modal-container .modal-close-button').forEach((b) => (b as HTMLElement).click());
 });
}

describe('Pro controls of Standard Notes Import', function () {
 afterEach(async () => { await closeAll(); await setPro(false); });

 it('a free user who selects Preview changes or Save rules gets the Pro notice with a Sponsor button, and nothing opens or saves', async () => {
  expect(await setPro(false)).toBe(false);
  await openWindow();
  const preview = await select('Preview changes (pro)');
  if (!preview.notices.some((n) => n.text.includes('The changed record preview needs Pro.') && n.sponsor === 1)) throw new Error(`No Pro notice after Preview changes: ${JSON.stringify(preview.notices)}`);
  expect(preview.disabled).toBe(false);
  expect(preview.reports).toBe(0);
  expect(preview.status).toBe('');
  await closeAll();
  await browser.executeObsidian(({ app }, id) => { const s = (app as unknown as Host).setting; s.open(); s.openTabById(id); }, ID);
  const save = await select('Save rules');
  if (!save.notices.some((n) => n.text.includes('Saved tag rules need Pro.') && n.sponsor === 1)) throw new Error(`No Pro notice after Save rules: ${JSON.stringify(save.notices)}`);
  expect(save.disabled).toBe(false);
  expect(save.rules).toBe('[]');
  expect(save.saved.includes('"rules":[{')).toBe(false);
 });

 it('a Pro user who selects Preview changes gets the changed record preview and no Pro notice', async () => {
  expect(await setPro(true)).toBe(true);
  await openWindow();
  const preview = await select('Preview changes (pro)');
  await browser.$('.sni-summary').waitForDisplayed();
  expect(await browser.$('.sni-summary').getText()).toContain('Ready: 1 notes');
  expect(preview.notices.filter((n) => n.sponsor > 0)).toEqual([]);
 });
});
