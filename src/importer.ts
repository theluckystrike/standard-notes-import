export interface SourceNote {
 uuid: string;
 title: string;
 text: string;
 tags: string[];
 createdAt?: string;
 updatedAt?: string;
}
export interface Issue { uuid: string; reason: string }
export interface Backup { notes: SourceNote[]; issues: Issue[] }
export interface Rule { tag: string; folder: string }
export interface Existing { uuid: string; path: string; source?: SourceNote }
export interface PlannedNote extends SourceNote { path: string }
export interface ImportPlan { notes: PlannedNote[]; issues: Issue[]; changed: { uuid: string; path: string; before: SourceNote | null; after: SourceNote }[] }

export function object(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function references(value: unknown): { uuid: string; content_type: string }[] | null {
 if (value === undefined) return [];
 if (!Array.isArray(value)) return null;
 if (!value.every((r: unknown) => object(r) && typeof r.uuid === 'string' && typeof r.content_type === 'string')) return null;
 return value as { uuid: string; content_type: string }[];
}
function identity(item: Record<string, unknown>): string {
 return typeof item.uuid === 'string' ? item.uuid : '(no UUID)';
}
const EDITORS = new Set(['com.standardnotes.plain-text', 'org.standardnotes.simple-markdown-editor']);

/** Reads the tested legacy and 004 shapes. It does not decode encrypted content. */
export function parseBackup(input: unknown): Backup {
 if (!object(input) || !Array.isArray(input.items)) throw new Error('Invalid backup: expected an items array.');
 if (input.version !== undefined && input.version !== '004') throw new Error('Unsupported backup version. Use a decrypted legacy or 004 backup.');
 const notes: SourceNote[] = [];
 const issues: Issue[] = [];
 const tags = new Map<string, { title: string; refs: { uuid: string; content_type: string }[] }>();
 for (const raw of input.items as unknown[]) {
  if (!object(raw) || raw.content_type !== 'Tag') continue;
  if (raw.deleted === true) { issues.push({ uuid: identity(raw), reason: 'Deleted source tag' }); continue; }
  const c = raw.content;
  const refs = object(c) ? references(c.references) : null;
  if (typeof raw.uuid !== 'string' || !object(c) || typeof c.title !== 'string' || !refs) {
   issues.push({ uuid: identity(raw), reason: 'Invalid tag shape' }); continue;
  }
  if (tags.has(raw.uuid)) { issues.push({ uuid: raw.uuid, reason: 'Duplicate tag UUID' }); continue; }
  tags.set(raw.uuid, { title: c.title, refs });
 }
 const noteTags = new Map<string, Set<string>>();
 for (const tag of tags.values()) for (const ref of tag.refs) {
  if (ref.content_type !== 'Note') continue;
  const names = noteTags.get(ref.uuid) ?? new Set<string>();
  names.add(tag.title);
  noteTags.set(ref.uuid, names);
 }
 const seen = new Set<string>();
 for (const raw of input.items as unknown[]) {
  if (!object(raw)) { issues.push({ uuid: '(no UUID)', reason: 'Invalid item shape' }); continue; }
  if (raw.content_type === 'Tag') continue;
  if (raw.content_type !== 'Note') { issues.push({ uuid: identity(raw), reason: `Unsupported item type: ${String(raw.content_type)}` }); continue; }
  const uuid = identity(raw);
  if (typeof raw.uuid !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(raw.uuid)) { issues.push({ uuid, reason: 'Invalid note UUID' }); continue; }
  if (seen.has(uuid)) { issues.push({ uuid, reason: 'Duplicate UUID in backup' }); continue; }
  seen.add(uuid);
  if (raw.deleted === true) { issues.push({ uuid, reason: 'Deleted source note' }); continue; }
  const c = raw.content;
  if (typeof c === 'string') { issues.push({ uuid, reason: 'Encrypted content: select a decrypted backup' }); continue; }
  if (!object(c)) { issues.push({ uuid, reason: 'Invalid note content shape' }); continue; }
  if (c.editorIdentifier !== undefined && (typeof c.editorIdentifier !== 'string' || !EDITORS.has(c.editorIdentifier))) {
   issues.push({ uuid, reason: `Unsupported editor: ${typeof c.editorIdentifier === 'string' ? c.editorIdentifier : '(invalid identifier)'}` }); continue;
  }
  if (c.noteType !== undefined && c.noteType !== 'plain-text' && c.noteType !== 'markdown') {
   issues.push({ uuid, reason: `Unsupported note type: ${typeof c.noteType === 'string' ? c.noteType : '(invalid type)'}` }); continue;
  }
  const refs = references(c.references);
  if (typeof c.title !== 'string' || typeof c.text !== 'string' || !refs ||
      (raw.created_at !== undefined && typeof raw.created_at !== 'string') ||
      (raw.updated_at !== undefined && typeof raw.updated_at !== 'string')) {
   issues.push({ uuid, reason: 'Invalid note shape' }); continue;
  }
  const names = new Set(noteTags.get(uuid));
  for (const ref of refs) {
   if (ref.content_type !== 'Tag') continue;
   const t = tags.get(ref.uuid);
   if (t) names.add(t.title);
   else issues.push({ uuid, reason: `Missing tag: ${ref.uuid}` });
  }
  notes.push({ uuid, title: c.title, text: c.text, tags: [...names].sort(),
   ...(typeof raw.created_at === 'string' ? { createdAt: raw.created_at } : {}),
   ...(typeof raw.updated_at === 'string' ? { updatedAt: raw.updated_at } : {}) });
 }
 return { notes, issues };
}

function removeControls(value: string): string {
 return [...value].map((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '-' : c).join('');
}
export function safeTitle(title: string): string {
 let name = removeControls(title.normalize('NFC').replace(/[\u00a0\u202f]/g, ' ')).replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim();
 const encoder = new TextEncoder();
 let short = '';
 for (const c of [...name].slice(0, 80)) {
  if (encoder.encode(short + c).length > 128) break;
  short += c;
 }
 name = short.replace(/[. ]+$/g, '');
 if (!name || /^\.+$/.test(name)) name = 'Untitled';
 if (name.startsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `Note-${name}`;
 return name;
}
export function safeFolder(folder: string): string {
 const normalized = folder.trim().replace(/\\/g, '/').normalize('NFC').replace(/[\u00a0\u202f]/g, ' ');
 const segments = normalized.split('/');
 if (!normalized || segments.some((s) => !s || s === '.' || s === '..' || s.startsWith('.') || s !== s.trim() || /[<>:"|?*]/.test(s) || removeControls(s) !== s || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw new Error('Use a relative folder path with safe folder names.');
 return normalized;
}
export function tagValue(name: string): string {
 let tag = name.normalize('NFC').replace(/^#+/, '').replace(/[^\p{L}\p{N}_/-]/gu, '_').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
 if (!tag || /^[\d/]+$/.test(tag)) tag = `tag_${tag || 'unnamed'}`;
 return tag;
}

/** Plans new files. Existing UUIDs and occupied paths produce reports, not writes. */
export function planImport(input: unknown, folder = 'Standard Notes', existing: Existing[] = [], occupied: string[] = [], rules: Rule[] = [], preview = false): ImportPlan {
 const backup = parseBackup(input);
 const destination = safeFolder(folder);
 const checkedRules = rules.map((r) => ({ tag: r.tag, folder: safeFolder(r.folder) }));
 const notes: PlannedNote[] = [];
 const issues = [...backup.issues];
 const changed: ImportPlan['changed'] = [];
 const paths = new Set(occupied.map((p) => p.normalize('NFC').toLowerCase()));
 const uuids = new Map(existing.map((e) => [e.uuid, e]));
 for (const note of backup.notes) {
  const prior = uuids.get(note.uuid);
  if (prior) {
   issues.push({ uuid: note.uuid, reason: `Duplicate UUID in vault: ${prior.path}` });
   if (preview && JSON.stringify(prior.source) !== JSON.stringify(note)) changed.push({ uuid: note.uuid, path: prior.path, before: prior.source ?? null, after: note });
   continue;
  }
  const target = checkedRules.find((r) => note.tags.includes(r.tag))?.folder ?? destination;
  const path = `${target}/${safeTitle(note.title)}--${note.uuid}.md`;
  const key = path.normalize('NFC').toLowerCase();
  if (paths.has(key)) { issues.push({ uuid: note.uuid, reason: `Path conflict: ${path}` }); continue; }
  paths.add(key);
  notes.push({ ...note, path });
 }
 return { notes, issues, changed };
}
