/* Bot Importer: bulk character import for SillyTavern (desktop + mobile).
 * Stage many cards, set profile pictures, tags and lorebooks, check for duplicates, import in one go. */

import { extension_settings } from '../../../extensions.js';
import * as ST from '../../../../script.js';
import * as TAGS from '../../../tags.js';
import { readPng, writePng, extractCard, normalizeCard, writeCardChunks, makeSig, evaluate } from './lib.js';

const MODULE = 'bot_importer';
const DEFAULTS = { dupThreshold: 85, similarThreshold: 60, autoSkipExact: true };
const RANK = { exact: 4, alt: 3, intro: 3, similar: 2, name: 1 };

const items = [];
const libIndex = new Map();
const els = {};
let uid = 0;
let busy = false;
let worlds = [];
let overlay = null;

/* ---------- small utilities ---------- */

function cfg() {
    const s = (extension_settings[MODULE] ??= {});
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
    return s;
}
const save = () => ST.saveSettingsDebounced?.();
const toast = (type, msg) => { try { window.toastr?.[type]?.(msg); } catch { /* ignore */ } };
const tick = () => new Promise(r => setTimeout(r, 0));
const pct = x => `${Math.round(x * 100)}%`;
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'card';
const sameTags = (a, b) => a.length === b.length && a.every(t => b.some(u => u.toLowerCase() === t.toLowerCase()));

function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
        if (kid == null || kid === false) continue;
        el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
}

function thumbUrl(avatar) {
    return ST.getThumbnailUrl ? ST.getThumbnailUrl('avatar', avatar) : `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
}

function gradientFor(name) {
    let n = 0;
    for (const ch of String(name)) n = (n * 31 + ch.charCodeAt(0)) % 360;
    return `linear-gradient(150deg, hsl(${n} 38% 38%), hsl(${(n + 40) % 360} 42% 24%))`;
}

/* ---------- library index (for duplicate checks) ---------- */

async function fullChar(c) {
    if (typeof c.description === 'string' && !c.shallow) return c;
    try {
        const r = await fetch('/api/characters/get', { method: 'POST', headers: ST.getRequestHeaders(), body: JSON.stringify({ avatar_url: c.avatar }) });
        if (r.ok) return await r.json();
    } catch (e) {
        console.warn('[BotImporter] could not load', c.avatar, e);
    }
    return c;
}

function entryFrom(c) {
    const d = c.data || {};
    const pick = k => d[k] ?? c[k] ?? '';
    const card = {
        name: c.name ?? d.name ?? '',
        description: pick('description'),
        personality: pick('personality'),
        scenario: pick('scenario'),
        first_mes: pick('first_mes'),
        alternate_greetings: d.alternate_greetings || c.alternate_greetings || [],
    };
    return { avatar: c.avatar, name: card.name, intro: card.first_mes || '', sig: makeSig(card) };
}

async function ensureIndex() {
    const list = (ST.characters || []).filter(c => c && c.avatar);
    const alive = new Set(list.map(c => c.avatar));
    for (const k of [...libIndex.keys()]) if (!alive.has(k)) libIndex.delete(k);
    const todo = list.filter(c => !libIndex.has(c.avatar));
    const total = todo.length;
    if (!total) return;
    let done = 0;
    const worker = async () => {
        while (todo.length) {
            const c = todo.pop();
            libIndex.set(c.avatar, entryFrom(await fullChar(c)));
            done++;
            if (done % 10 === 0 || done === total) setStatus(`Indexing your library for duplicate checks: ${done} of ${total}`);
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
}

/* ---------- parsing ---------- */

async function parseFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const base = file.name.replace(/\.[^.]+$/, '');
    let json, chunks = null, hadV3 = false;
    if (ext === 'png') {
        chunks = readPng(await file.arrayBuffer());
        const found = extractCard(chunks);
        if (!found) throw new Error('no character data inside this PNG');
        json = found.json;
        hadV3 = found.hadV3;
    } else if (ext === 'json') {
        try { json = JSON.parse(await file.text()); } catch { throw new Error('not valid JSON'); }
    } else {
        throw new Error('unsupported file type');
    }
    const raw = normalizeCard(json);
    const card = raw.data;
    if (!card.name && !card.description && !card.first_mes) throw new Error('this does not look like a character card');
    if (!card.name) card.name = base;
    return {
        id: ++uid, file, kind: ext, chunks, hadV3: hadV3 || raw.spec === 'chara_card_v3', raw,
        name: card.name, tags: [...card.tags], originalTags: [...card.tags], world: '',
        newAvatar: null, newAvatarUrl: null, previewUrl: ext === 'png' ? URL.createObjectURL(file) : null,
        selected: true, userToggled: false, status: 'ready', error: '', sig: makeSig(card),
        libDups: [], batchDups: [], dups: [], level: null, skip: false, el: null,
    };
}

/* ---------- duplicate checks ---------- */

async function runChecks(fresh) {
    if (!items.length) { setStatus(''); return; }
    const c = cfg();
    try {
        if (fresh?.length) {
            setStatus('Checking your library for duplicates…');
            await ensureIndex();
            const lib = [...libIndex.values()];
            let n = 0;
            for (const it of fresh) {
                it.libDups = [];
                for (const e of lib) {
                    const r = evaluate(it.sig, e.sig, c.dupThreshold, c.similarThreshold);
                    if (r) it.libDups.push({ ...r, src: 'lib', name: e.name, thumb: thumbUrl(e.avatar), intro: e.intro });
                }
                if (++n % 3 === 0) await tick();
            }
        }
        await recomputeBatch();
    } catch (e) {
        console.error('[BotImporter] duplicate check failed', e);
        toast('error', 'Duplicate check failed. See the browser console for details.');
    }
    setStatus('');
}

async function recomputeBatch() {
    const c = cfg();
    for (const it of items) it.batchDups = [];
    for (let a = 0; a < items.length; a++) {
        for (let b = a + 1; b < items.length; b++) {
            const A = items[a], B = items[b];
            const r = evaluate(A.sig, B.sig, c.dupThreshold, c.similarThreshold);
            if (!r) continue;
            A.batchDups.push({ ...r, src: 'batch', name: B.name, thumb: B.newAvatarUrl || B.previewUrl, intro: B.raw.data.first_mes || '', earlier: false });
            B.batchDups.push({ ...r, src: 'batch', name: A.name, thumb: A.newAvatarUrl || A.previewUrl, intro: A.raw.data.first_mes || '', earlier: true });
        }
        if (a % 10 === 9) await tick();
    }
    finalize();
}

function finalize() {
    const auto = cfg().autoSkipExact;
    for (const it of items) {
        it.dups = [...it.libDups, ...it.batchDups].sort((x, y) => RANK[y.level] - RANK[x.level] || y.score - x.score);
        it.level = it.dups[0]?.level || null;
        it.skip = it.libDups.some(m => m.level === 'exact') || it.batchDups.some(m => m.level === 'exact' && m.earlier);
        if (auto && !it.userToggled) it.selected = !it.skip;
        if (it.el) { syncSel(it); renderDups(it); }
    }
    updateFooter();
}

/* ---------- card rendering ---------- */

function syncSel(it) {
    it.el.querySelector('.bim-sel').checked = it.selected;
    it.el.classList.toggle('unsel', !it.selected);
}

function renderAvatar(it) {
    const a = it.el.querySelector('.bim-avatar');
    const letter = a.querySelector('.bim-letter');
    const url = it.newAvatarUrl || it.previewUrl;
    if (url) {
        a.style.background = '';
        a.style.backgroundImage = `url("${url}")`;
        letter.textContent = '';
    } else {
        a.style.backgroundImage = '';
        a.style.background = gradientFor(it.name);
        letter.textContent = (it.name.trim()[0] || '?').toUpperCase();
    }
    it.el.querySelector('.bim-reset').hidden = !it.newAvatar;
}

function setAvatar(it, file) {
    if (it.newAvatarUrl) URL.revokeObjectURL(it.newAvatarUrl);
    it.newAvatar = file || null;
    it.newAvatarUrl = file ? URL.createObjectURL(file) : null;
    renderAvatar(it);
}

function renderTags(it) {
    const box = it.el.querySelector('.bim-chips');
    const input = box.querySelector('input');
    box.querySelectorAll('.bim-chip').forEach(n => n.remove());
    for (const t of it.tags) {
        const x = h('button', { type: 'button', title: 'Remove tag', 'aria-label': `Remove tag ${t}` }, '×');
        x.addEventListener('click', () => { it.tags = it.tags.filter(v => v !== t); renderTags(it); });
        box.insertBefore(h('span', { class: 'bim-chip' }, t, x), input);
    }
}

function addTags(it, text) {
    for (const t of String(text).split(',').map(s => s.trim()).filter(Boolean)) {
        if (!it.tags.some(x => x.toLowerCase() === t.toLowerCase())) it.tags.push(t);
    }
    renderTags(it);
}

function fillWorld(it) {
    const sel = it.el.querySelector('.bim-world');
    const own = it.raw.data.extensions?.world;
    sel.replaceChildren(
        h('option', { value: '' }, own ? `Keep the card’s lorebook (${own})` : 'Keep the card’s setting'),
        h('option', { value: '__none__' }, 'No linked lorebook'),
        ...worlds.map(w => h('option', { value: w }, w)),
    );
    sel.value = it.world;
}

function cmpCol(title, text) {
    return h('div', {}, h('div', { class: 'bim-cmp-title' }, title), h('div', { class: 'bim-cmp-col' }, String(text || '').trim() || '(empty)'));
}

function dupEl(it, m) {
    const where = m.src === 'lib' ? 'In your library' : 'In this batch';
    const body = h('div', { class: 'bim-dup-body' },
        h('div', { class: 'bim-dup-title' }, m.label),
        h('div', { class: 'bim-dup-sub' }, `${where}: `, h('b', {}, m.name || '(no name)'),
            m.level === 'name' ? '' : `, description ${pct(m.d)}, intro ${pct(m.i)}`));
    if (m.level !== 'name') {
        body.append(h('details', { class: 'bim-cmp' },
            h('summary', {}, 'Compare intro messages'),
            h('div', { class: 'bim-cmp-grid' }, cmpCol('This card', it.raw.data.first_mes), cmpCol(m.name || 'Match', m.intro))));
    }
    return h('div', { class: `bim-dup lvl-${m.level}` }, m.thumb ? h('img', { src: m.thumb, alt: '', loading: 'lazy' }) : null, body);
}

function renderDups(it) {
    const box = it.el.querySelector('.bim-dups');
    box.replaceChildren(...it.dups.slice(0, 3).map(m => dupEl(it, m)));
    it.el.dataset.level = it.level || '';
}

function renderState(it) {
    const s = it.el.querySelector('.bim-state');
    it.el.classList.toggle('is-importing', it.status === 'importing');
    it.el.classList.toggle('is-error', it.status === 'error');
    s.hidden = it.status === 'ready';
    s.replaceChildren();
    if (it.status === 'importing') s.append(h('i', { class: 'fa-solid fa-spinner fa-spin' }), ' Importing…');
    else if (it.status === 'done') s.append(h('i', { class: 'fa-solid fa-check' }), ' Imported');
    else if (it.status === 'error') s.append(h('i', { class: 'fa-solid fa-triangle-exclamation' }), ` Failed: ${it.error}`);
}

function createCard(it) {
    const d = it.raw.data;
    const sel = h('input', { type: 'checkbox', class: 'bim-sel', checked: it.selected, 'aria-label': `Import ${it.name}` });
    sel.addEventListener('change', () => { it.selected = sel.checked; it.userToggled = true; it.el.classList.toggle('unsel', !it.selected); updateFooter(); });

    const picker = h('input', { type: 'file', accept: 'image/*', hidden: true });
    picker.addEventListener('change', () => { const f = picker.files[0]; picker.value = ''; if (f) setAvatar(it, f); });

    const avatar = h('div', { class: 'bim-avatar', role: 'button', tabindex: '0', title: 'Change profile picture' },
        h('span', { class: 'bim-letter' }), h('span', { class: 'bim-cam' }, h('i', { class: 'fa-solid fa-camera' })));
    avatar.addEventListener('click', () => picker.click());
    avatar.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
    avatar.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); avatar.classList.add('over'); });
    avatar.addEventListener('dragleave', () => avatar.classList.remove('over'));
    avatar.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); avatar.classList.remove('over');
        const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
        if (f) setAvatar(it, f);
    });

    const reset = h('button', { type: 'button', class: 'bim-reset', title: 'Go back to the original picture', hidden: true }, h('i', { class: 'fa-solid fa-rotate-left' }));
    reset.addEventListener('click', () => setAvatar(it, null));

    const tagInput = h('input', { type: 'text', class: 'bim-tag-input', placeholder: 'Add a tag', list: 'bim-taglist', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'none' });
    const commit = () => { if (tagInput.value.trim()) { addTags(it, tagInput.value); tagInput.value = ''; } };
    tagInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
        else if (e.key === 'Backspace' && !tagInput.value && it.tags.length) { it.tags.pop(); renderTags(it); }
    });
    tagInput.addEventListener('input', () => { if (tagInput.value.includes(',')) commit(); });
    tagInput.addEventListener('change', commit);
    tagInput.addEventListener('blur', commit);

    const worldSel = h('select', { class: 'bim-world', 'aria-label': 'Lorebook' });
    worldSel.addEventListener('change', () => { it.world = worldSel.value; });

    const alts = d.alternate_greetings.length;
    const snippet = (d.description || d.first_mes || '').replace(/\s+/g, ' ').trim().slice(0, 200);

    it.el = h('article', { class: 'bim-card' },
        h('div', { class: 'bim-card-top' },
            h('div', { class: 'bim-avatar-wrap' }, avatar, reset, picker),
            h('div', { class: 'bim-info' },
                h('label', { class: 'bim-namerow' }, sel, h('span', { class: 'bim-name', title: it.name }, it.name)),
                h('div', { class: 'bim-badges' },
                    h('span', { class: 'bim-badge' }, it.kind === 'png' ? 'PNG card' : 'JSON card'),
                    alts ? h('span', { class: 'bim-badge' }, `${alts} extra greeting${alts > 1 ? 's' : ''}`) : null,
                    d.character_book ? h('span', { class: 'bim-badge' }, 'Has its own lorebook') : null),
                h('p', { class: 'bim-snippet' }, snippet || 'No description')),
            h('button', { type: 'button', class: 'bim-x', title: 'Remove from this list', 'aria-label': `Remove ${it.name} from the list`, onclick: () => removeItem(it) }, h('i', { class: 'fa-solid fa-xmark' }))),
        h('div', { class: 'bim-dups' }),
        h('div', { class: 'bim-field' }, h('span', { class: 'bim-lbl' }, h('i', { class: 'fa-solid fa-tags' }), 'Tags'), h('div', { class: 'bim-chips' }, tagInput)),
        h('div', { class: 'bim-field' }, h('span', { class: 'bim-lbl' }, h('i', { class: 'fa-solid fa-book' }), 'Lorebook'), worldSel),
        h('div', { class: 'bim-state', hidden: true }));

    renderAvatar(it); renderTags(it); fillWorld(it); renderDups(it); renderState(it); syncSel(it);
    return it.el;
}

function removeItem(it, silent) {
    const i = items.indexOf(it);
    if (i < 0) return;
    items.splice(i, 1);
    if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
    if (it.newAvatarUrl) URL.revokeObjectURL(it.newAvatarUrl);
    it.el?.remove();
    if (!silent) { updateFooter(); recomputeBatch(); }
}

/* ---------- worlds and tags lists ---------- */

async function refreshWorlds() {
    try {
        const wi = await import('../../../world-info.js');
        if (!wi.world_names?.length && wi.updateWorldInfoList) await wi.updateWorldInfoList();
        worlds = [...(wi.world_names || [])].sort((a, b) => a.localeCompare(b));
    } catch (e) {
        console.warn('[BotImporter] could not read lorebooks', e);
        worlds = [];
    }
    for (const it of items) fillWorld(it);
    if (els.bulkWorld) {
        els.bulkWorld.replaceChildren(
            h('option', { value: '' }, 'Choose a lorebook'),
            h('option', { value: '__none__' }, 'No linked lorebook'),
            ...worlds.map(w => h('option', { value: w }, w)));
    }
}

function refreshTagList() {
    const dl = document.getElementById('bim-taglist');
    if (!dl) return;
    dl.replaceChildren(...(TAGS.tags || []).map(t => h('option', { value: t.name })));
}

/* ---------- adding files ---------- */

async function addFiles(files) {
    if (busy) { toast('info', 'Wait for the current import to finish.'); return; }
    const list = files.filter(f => /\.(png|json)$/i.test(f.name));
    if (files.length - list.length) toast('warning', `${files.length - list.length} file(s) skipped. Only .png and .json cards work here.`);
    if (!list.length) return;
    setStatus(`Reading ${list.length} file${list.length > 1 ? 's' : ''}…`);
    const fresh = [];
    const errors = [];
    for (const f of list) {
        try { fresh.push(await parseFile(f)); } catch (e) { errors.push(`${f.name}: ${e.message}`); }
    }
    for (const it of fresh) { items.push(it); els.grid.append(createCard(it)); }
    updateFooter();
    if (errors.length) toast('error', errors.slice(0, 4).join('; ') + (errors.length > 4 ? `; and ${errors.length - 4} more` : ''));
    refreshTagList();
    await runChecks(fresh);
}

/* ---------- import pipeline ---------- */

async function imageToAvatarPng(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => rej(new Error('could not read the chosen picture'));
            i.src = url;
        });
        const W = 512, H = 768;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const sw = W / scale, sh = H / scale;
        canvas.getContext('2d').drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) * 0.2, sw, sh, 0, 0, W, H);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        if (!blob) throw new Error('could not process the chosen picture');
        return await blob.arrayBuffer();
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function uploadCharacter(file, type) {
    const fd = new FormData();
    fd.append('avatar', file, file.name);
    fd.append('file_type', type);
    if (ST.name1) fd.append('user_name', ST.name1);
    const headers = ST.getRequestHeaders();
    delete headers['Content-Type'];
    delete headers['content-type'];
    const r = await fetch('/api/characters/import', { method: 'POST', headers, body: fd, cache: 'no-cache' });
    if (!r.ok) throw new Error(`the server answered ${r.status}`);
    const data = await r.json();
    if (!data?.file_name) throw new Error('the server rejected this card');
    return data.file_name;
}

function applyTags(avatar, names) {
    const { tags, tag_map } = TAGS;
    if (!tags || !tag_map || !names.length) return;
    const ids = new Set(tag_map[avatar] || []);
    for (const n of names) {
        let t = tags.find(x => x.name.toLowerCase() === n.toLowerCase());
        if (!t) {
            t = { id: crypto.randomUUID(), name: n, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: tags.length, is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() };
            tags.push(t);
        }
        ids.add(t.id);
    }
    tag_map[avatar] = [...ids];
}

async function importItem(it) {
    const card = it.raw.data;
    card.tags = [...it.tags];
    if (Array.isArray(it.raw.tags)) it.raw.tags = [...it.tags];
    if (it.world === '__none__') card.extensions.world = '';
    else if (it.world) card.extensions.world = it.world;

    const base = safeName(it.file.name.replace(/\.[^.]+$/, ''));
    const metaChanged = it.world !== '' || !sameTags(it.tags, it.originalTags);
    let file, type;
    if (it.newAvatar) {
        const chunks = writeCardChunks(readPng(await imageToAvatarPng(it.newAvatar)), it.raw, it.hadV3);
        file = new File([writePng(chunks)], `${base}.png`, { type: 'image/png' });
        type = 'png';
    } else if (it.kind === 'png' && metaChanged) {
        file = new File([writePng(writeCardChunks(it.chunks, it.raw, it.hadV3))], `${base}.png`, { type: 'image/png' });
        type = 'png';
    } else if (it.kind === 'png') {
        file = it.file;
        type = 'png';
    } else {
        file = new File([JSON.stringify(it.raw)], `${base}.json`, { type: 'application/json' });
        type = 'json';
    }
    const avatar = `${await uploadCharacter(file, type)}.png`;
    applyTags(avatar, it.tags);
    return avatar;
}

async function doImport() {
    if (busy) return;
    const queue = items.filter(i => i.selected);
    if (!queue.length) return;
    busy = true;
    updateFooter();
    els.barWrap.hidden = false;
    els.bar.style.width = '0%';
    let ok = 0, fail = 0, n = 0;
    for (const it of queue) {
        it.status = 'importing';
        renderState(it);
        it.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        try {
            const avatar = await importItem(it);
            libIndex.set(avatar, { avatar, name: it.name, intro: it.raw.data.first_mes || '', sig: it.sig });
            it.status = 'done';
            ok++;
        } catch (e) {
            console.error('[BotImporter]', it.name, e);
            it.status = 'error';
            it.error = e.message || String(e);
            fail++;
        }
        renderState(it);
        els.bar.style.width = `${Math.round((++n / queue.length) * 100)}%`;
    }
    try {
        await ST.getCharacters();
        save();
        ST.printCharactersDebounced?.();
    } catch (e) {
        console.warn('[BotImporter] refresh failed', e);
    }
    for (const it of queue.filter(i => i.status === 'done')) removeItem(it, true);
    busy = false;
    els.barWrap.hidden = true;
    if (ok) toast('success', `Imported ${ok} bot${ok > 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}.`);
    else toast('error', 'Nothing could be imported. Open the failed cards for details.');
    setStatus(fail ? `${fail} card${fail > 1 ? 's' : ''} failed and stayed in the list.` : ok ? `Imported ${ok} bot${ok > 1 ? 's' : ''}. Add more or close this window.` : '');
    await recomputeBatch();
}

/* ---------- modal ---------- */

function setStatus(text) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.hidden = !text;
}

function updateFooter() {
    if (!els.summary) return;
    const sel = items.filter(i => i.selected).length;
    const flagged = items.filter(i => ['exact', 'alt', 'intro'].includes(i.level)).length;
    els.summary.textContent = items.length
        ? `${sel} of ${items.length} selected${flagged ? `, ${flagged} possible duplicate${flagged > 1 ? 's' : ''}` : ''}`
        : 'No cards added yet';
    els.importBtn.disabled = busy || !sel;
    els.importLabel.textContent = sel ? `Import ${sel} bot${sel > 1 ? 's' : ''}` : 'Import';
    els.empty.hidden = items.length > 0;
}

function bulkTargets() {
    const t = items.filter(i => i.selected);
    if (!t.length) toast('info', 'Select some cards first.');
    return t;
}

function buildModal() {
    const fileInput = h('input', { type: 'file', multiple: true, accept: '.png,.json,image/png,application/json', hidden: true });
    fileInput.addEventListener('change', async () => { const f = [...fileInput.files]; fileInput.value = ''; await addFiles(f); });

    const drop = h('div', { class: 'bim-drop', role: 'button', tabindex: '0' },
        h('i', { class: 'fa-solid fa-cloud-arrow-up' }),
        h('div', { class: 'bim-drop-text' }, h('b', {}, 'Add character cards'), h('span', {}, 'Drop PNG or JSON files here, or tap to browse. You can pick as many as you like.')),
        fileInput);
    drop.addEventListener('click', e => { if (e.target !== fileInput) fileInput.click(); });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });

    els.status = h('div', { class: 'bim-status', hidden: true, 'aria-live': 'polite' });
    els.grid = h('div', { class: 'bim-grid' });
    els.empty = h('div', { class: 'bim-empty' }, h('i', { class: 'fa-regular fa-folder-open' }), h('p', {}, 'Cards you add show up here. Set a picture, tags and a lorebook on each one, then import them together.'));

    els.bulkTag = h('input', { type: 'text', class: 'bim-input', placeholder: 'Tag for selected cards', list: 'bim-taglist', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'none' });
    const applyBulkTag = () => {
        const v = els.bulkTag.value.trim();
        if (!v) return;
        const t = bulkTargets();
        if (!t.length) return;
        t.forEach(i => addTags(i, v));
        els.bulkTag.value = '';
        toast('success', `Tag added to ${t.length} card${t.length > 1 ? 's' : ''}.`);
    };
    els.bulkTag.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyBulkTag(); } });

    els.bulkWorld = h('select', { class: 'bim-input', 'aria-label': 'Lorebook for selected cards' });
    els.bulkWorld.addEventListener('change', () => {
        const v = els.bulkWorld.value;
        if (!v) return;
        const t = bulkTargets();
        t.forEach(i => { i.world = v; fillWorld(i); });
        if (t.length) toast('success', `Lorebook set on ${t.length} card${t.length > 1 ? 's' : ''}.`);
        els.bulkWorld.value = '';
    });

    const btn = (icon, label, fn, cls = '') => h('button', { type: 'button', class: `bim-btn ${cls}`, onclick: fn }, h('i', { class: `fa-solid ${icon}` }), label);

    const bulk = h('div', { class: 'bim-bulk' },
        h('div', { class: 'bim-row' },
            btn('fa-check-double', 'Select all', () => { items.forEach(i => { i.selected = true; i.userToggled = true; syncSel(i); }); updateFooter(); }),
            btn('fa-square', 'Select none', () => { items.forEach(i => { i.selected = false; i.userToggled = true; syncSel(i); }); updateFooter(); }),
            btn('fa-filter', 'Only unique', () => { items.forEach(i => { i.selected = !i.level || i.level === 'name'; i.userToggled = true; syncSel(i); }); updateFooter(); }),
            btn('fa-trash-can', 'Clear list', () => { if (busy) return; [...items].forEach(i => removeItem(i, true)); updateFooter(); setStatus(''); })),
        h('div', { class: 'bim-row' },
            els.bulkTag, btn('fa-tag', 'Add tag', applyBulkTag),
            els.bulkWorld));

    els.importLabel = h('span', {}, 'Import');
    els.importBtn = h('button', { type: 'button', class: 'bim-btn primary', onclick: doImport }, h('i', { class: 'fa-solid fa-file-import' }), els.importLabel);
    els.summary = h('div', { class: 'bim-summary' });
    els.bar = h('div', { class: 'bim-bar' });
    els.barWrap = h('div', { class: 'bim-bar-wrap', hidden: true }, els.bar);

    const modal = h('div', { class: 'bim-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bot Importer' },
        h('header', { class: 'bim-head' },
            h('div', { class: 'bim-logo' }, h('i', { class: 'fa-solid fa-boxes-packing' })),
            h('div', {}, h('div', { class: 'bim-title' }, 'Bot Importer'), h('div', { class: 'bim-sub' }, 'Import many bots at once without opening each one')),
            h('button', { type: 'button', class: 'bim-close', 'aria-label': 'Close', onclick: closeModal }, h('i', { class: 'fa-solid fa-xmark' }))),
        h('div', { class: 'bim-body' }, drop, els.status, bulk, els.grid, els.empty),
        h('footer', { class: 'bim-foot' }, els.barWrap, els.summary, els.importBtn),
        h('datalist', { id: 'bim-taglist' }));

    modal.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    modal.addEventListener('dragleave', e => { if (!modal.contains(e.relatedTarget)) drop.classList.remove('over'); });
    modal.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f); });

    overlay = h('div', { id: 'bim-overlay' }, modal);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
    document.body.append(overlay);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal(); });
}

async function openModal() {
    if (!overlay) buildModal();
    overlay.classList.add('open');
    document.body.classList.add('bim-lock');
    updateFooter();
    refreshTagList();
    await refreshWorlds();
}

function closeModal() {
    if (busy || !overlay) return;
    overlay.classList.remove('open');
    document.body.classList.remove('bim-lock');
}

/* ---------- entry points and settings ---------- */

function mountSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('bim_settings')) return;
    const c = cfg();
    const wrap = h('div', { id: 'bim_settings', class: 'bim-settings' });
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Bot Importer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="bim_open" class="menu_button menu_button_icon"><i class="fa-solid fa-boxes-packing"></i><span>Open Bot Importer</span></div>
                <label class="bim-set">Duplicate threshold: <b id="bim_dup_val">${c.dupThreshold}</b>%
                    <input id="bim_dup" type="range" min="60" max="100" step="1" value="${c.dupThreshold}">
                </label>
                <label class="bim-set">Similar threshold: <b id="bim_sim_val">${c.similarThreshold}</b>%
                    <input id="bim_sim" type="range" min="30" max="95" step="1" value="${c.similarThreshold}">
                </label>
                <label class="checkbox_label"><input id="bim_auto" type="checkbox" ${c.autoSkipExact ? 'checked' : ''}><span>Untick exact duplicates automatically</span></label>
                <small>Cards are compared by description and intro messages, never by name alone. New thresholds apply to cards added from now on.</small>
            </div>
        </div>`;
    host.append(wrap);
    wrap.querySelector('#bim_open').addEventListener('click', openModal);
    const bindRange = (id, valId, key) => wrap.querySelector(id).addEventListener('input', e => {
        cfg()[key] = Number(e.target.value);
        wrap.querySelector(valId).textContent = e.target.value;
        save();
    });
    bindRange('#bim_dup', '#bim_dup_val', 'dupThreshold');
    bindRange('#bim_sim', '#bim_sim_val', 'similarThreshold');
    wrap.querySelector('#bim_auto').addEventListener('change', e => { cfg().autoSkipExact = e.target.checked; save(); });
}

function mountButtons() {
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('bim_wand')) {
        menu.append(h('div', { class: 'extension_container' },
            h('div', { id: 'bim_wand', class: 'list-group-item flex-container flexGap5 interactable', tabindex: '0', role: 'button', onclick: openModal },
                h('div', { class: 'fa-solid fa-boxes-packing extensionsMenuExtensionButton' }), h('span', {}, 'Bot Importer'))));
    }
    const imp = document.getElementById('character_import_button');
    if (imp && !document.getElementById('bim_char_btn')) {
        imp.after(h('div', { id: 'bim_char_btn', class: 'menu_button fa-solid fa-boxes-packing faSmallFontSquareFix', title: 'Bulk import with Bot Importer', tabindex: '0', role: 'button', onclick: openModal }));
    }
}

function init() {
    cfg();
    mountSettings();
    mountButtons();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
