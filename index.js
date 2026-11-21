/* Bot Importer: bulk character import for SillyTavern (desktop + mobile).
 * Stage many cards, set profile pictures, tags and lorebooks, check for duplicates, import in one go. */

import { extension_settings } from '../../../extensions.js';
import * as ST from '../../../../script.js';
import * as TAGS from '../../../tags.js';
import { readPng, writePng, extractCard, normalizeCard, writeCardChunks, makeSig, evaluate } from './lib.js';
import { RU, PL, pluralIndex } from './i18n.js';

const MODULE = 'bot_importer';
const DEFAULTS = { dupThreshold: 85, similarThreshold: 60, autoSkipExact: true, ignoreCardTags: false, ignoredTags: '', language: 'auto', askCrop: true };
const RANK = { exact: 4, alt: 3, intro: 3, similar: 2, name: 1 };

const items = [];
const libIndex = new Map();
const els = {};
let uid = 0;
let busy = false;
let worlds = [];
let overlay = null;
let escBound = false;

/* ---------- small utilities ---------- */

function cfg() {
    const s = (extension_settings[MODULE] ??= {});
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
    return s;
}
const save = () => ST.saveSettingsDebounced?.();

/* ---------- language ---------- */

function curLang() {
    const v = cfg().language;
    if (v === 'ru' || v === 'en') return v;
    let l = '';
    try { l = localStorage.getItem('language') || ''; } catch { /* ignore */ }
    l = (l || navigator.language || 'en').toLowerCase();
    return l.startsWith('ru') ? 'ru' : 'en';
}

/** Translates an English source string. Placeholders like {name} are filled from vars. */
function tr(key, vars) {
    let out = (curLang() === 'ru' && RU[key]) || key;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
    return out;
}

/** Translates a phrase with a number in it, choosing the right plural form. */
function tp(key, n, vars = {}) {
    const lang = curLang();
    const forms = PL[key][lang] || PL[key].en;
    return forms[pluralIndex(lang, n)].replace(/\{(\w+)\}/g, (m, k) => (k === 'n' ? n : (vars[k] ?? m)));
}
const toast = (type, msg) => { try { window.toastr?.[type]?.(msg); } catch { /* ignore */ } };
const tick = () => new Promise(r => setTimeout(r, 0));
const pct = x => `${Math.round(x * 100)}%`;
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'card';
const sameTags = (a, b) => a.length === b.length && a.every(t => b.some(u => u.toLowerCase() === t.toLowerCase()));
const ignoredList = () => String(cfg().ignoredTags || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
/** Tags a card starts with after the "ignore tags" settings are applied. */
const baseTags = list => {
    if (cfg().ignoreCardTags) return [];
    const ig = ignoredList();
    return list.filter(t => !ig.includes(t.toLowerCase()));
};

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
            if (done % 10 === 0 || done === total) setStatus(tr('Indexing your library for duplicate checks: {done} of {total}', { done, total }));
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
        if (!found) throw new Error(tr('no character data inside this PNG'));
        json = found.json;
        hadV3 = found.hadV3;
    } else if (ext === 'json') {
        try { json = JSON.parse(await file.text()); } catch { throw new Error(tr('not valid JSON')); }
    } else {
        throw new Error(tr('unsupported file type'));
    }
    const raw = normalizeCard(json);
    const card = raw.data;
    if (!card.name && !card.description && !card.first_mes) throw new Error(tr('this does not look like a character card'));
    if (!card.name) card.name = base;
    return {
        id: ++uid, file, kind: ext, chunks, hadV3: hadV3 || raw.spec === 'chara_card_v3', raw,
        name: card.name, tags: baseTags(card.tags), originalTags: [...card.tags], world: '', extras: [],
        newAvatar: null, newAvatarUrl: null, avatarSource: null, avatarCropped: false, previewUrl: ext === 'png' ? URL.createObjectURL(file) : null,
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
            setStatus(tr('Checking your library for duplicates…'));
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
        toast('error', tr('Duplicate check failed. See the browser console for details.'));
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
    it.el.querySelector('.bim-crop-btn').hidden = !(it.newAvatar || it.previewUrl);
}

function setAvatar(it, file, opts = {}) {
    if (it.newAvatarUrl) URL.revokeObjectURL(it.newAvatarUrl);
    it.newAvatar = file || null;
    it.newAvatarUrl = file ? URL.createObjectURL(file) : null;
    it.avatarSource = file ? (opts.source || file) : null;
    it.avatarCropped = !!(file && opts.cropped);
    renderAvatar(it);
}

/** A picture was picked or dropped: let the user crop it first (unless the cropper is switched off). */
async function chooseAvatar(it, file) {
    if (!cfg().askCrop) { setAvatar(it, file); return; }
    const out = await openCropper(file);
    if (out) setAvatar(it, out, { source: file, cropped: true });
}

/** Crop again, starting from the picture the user originally chose (or the card's own image). */
async function recrop(it) {
    const src = it.avatarSource || (it.kind === 'png' ? it.file : null);
    if (!src) return;
    const out = await openCropper(src);
    if (out) setAvatar(it, out, { source: src, cropped: true });
}

/* ---------- cropper ---------- */

let cropOpen = false;

/** Opens a 2:3 cropper (drag to move, pinch / wheel / slider to zoom). Resolves with a 512x768 PNG File, or null if cancelled. */
function openCropper(file) {
    return new Promise(resolve => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onerror = () => { URL.revokeObjectURL(url); toast('error', tr('could not read the chosen picture')); resolve(null); };
        img.onload = () => run(img);
        img.src = url;

        function run(img) {
            cropOpen = true;
            const OUT_W = 512, OUT_H = 768;
            const iw = img.naturalWidth, ih = img.naturalHeight;
            const vw = Math.max(160, Math.min(320, window.innerWidth - 64, Math.floor((window.innerHeight - 300) * 2 / 3)));
            const vh = Math.round(vw * 1.5);
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cover = Math.max(vw / iw, vh / ih);
            const minZ = Math.min(1, Math.min(vw / iw, vh / ih) / cover);
            const maxZ = 6;
            let z = 1, cx = vw / 2, cy = vh / 2;

            const canvas = h('canvas', { class: 'bim-crop-canvas', width: Math.round(vw * dpr), height: Math.round(vh * dpr) });
            canvas.style.width = `${vw}px`;
            canvas.style.height = `${vh}px`;
            const ctx = canvas.getContext('2d');
            const slider = h('input', { type: 'range', class: 'bim-crop-zoom', min: String(minZ), max: String(maxZ), step: '0.01', value: '1', 'aria-label': tr('Zoom') });

            const size = () => ({ dw: iw * cover * z, dh: ih * cover * z });
            const clamp = () => {
                const { dw, dh } = size();
                cx = dw >= vw ? Math.min(dw / 2, Math.max(vw - dw / 2, cx)) : vw / 2;
                cy = dh >= vh ? Math.min(dh / 2, Math.max(vh - dh / 2, cy)) : vh / 2;
            };
            const paint = (c, kx, ky) => {
                const { dw, dh } = size();
                c.setTransform(kx, 0, 0, ky, 0, 0);
                c.clearRect(0, 0, vw, vh);
                c.imageSmoothingQuality = 'high';
                c.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
            };
            const draw = () => paint(ctx, canvas.width / vw, canvas.height / vh);
            const zoomAt = (nz, px, py) => {
                nz = Math.min(maxZ, Math.max(minZ, nz));
                const ratio = nz / z;
                cx = px - (px - cx) * ratio;
                cy = py - (py - cy) * ratio;
                z = nz;
                clamp();
                slider.value = String(z);
                draw();
            };
            const reset = () => {
                z = 1;
                const { dh } = size();
                cx = vw / 2;
                cy = dh > vh ? dh / 2 - (dh - vh) * 0.2 : vh / 2;   // keep the top of tall pictures (faces)
                clamp();
                slider.value = '1';
                draw();
            };
            const showAll = () => { cx = vw / 2; cy = vh / 2; zoomAt(minZ, vw / 2, vh / 2); };

            const pts = new Map();
            canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
            canvas.addEventListener('pointermove', e => {
                const prev = pts.get(e.pointerId);
                if (!prev) return;
                const cur = { x: e.clientX, y: e.clientY };
                if (pts.size === 1) {
                    cx += cur.x - prev.x;
                    cy += cur.y - prev.y;
                    clamp();
                    draw();
                } else if (pts.size === 2) {
                    const other = [...pts.entries()].find(([id]) => id !== e.pointerId)[1];
                    const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
                    const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
                    const r = canvas.getBoundingClientRect();
                    if (d0 > 0) zoomAt(z * (d1 / d0), (cur.x + other.x) / 2 - r.left, (cur.y + other.y) / 2 - r.top);
                }
                pts.set(e.pointerId, cur);
            });
            const lift = e => pts.delete(e.pointerId);
            canvas.addEventListener('pointerup', lift);
            canvas.addEventListener('pointercancel', lift);
            canvas.addEventListener('wheel', e => {
                e.preventDefault();
                const r = canvas.getBoundingClientRect();
                zoomAt(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
            }, { passive: false });
            slider.addEventListener('input', () => zoomAt(Number(slider.value), vw / 2, vh / 2));

            const view = h('div', { class: 'bim-crop-view' }, canvas, h('div', { class: 'bim-crop-grid' }));
            view.style.width = `${vw}px`;
            view.style.height = `${vh}px`;

            const mk = (icon, label, fn, cls = '') => h('button', { type: 'button', class: `bim-btn ${cls}`, onclick: fn }, h('i', { class: `fa-solid ${icon}` }), label);
            const box = h('div', { id: 'bim-crop' }, h('div', { class: 'bim-crop-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Crop profile picture') },
                h('div', { class: 'bim-crop-title' }, tr('Crop profile picture')),
                view,
                h('p', { class: 'bim-crop-hint' }, tr('Drag to move. Pinch, scroll or use the slider to zoom.')),
                h('div', { class: 'bim-crop-zoomrow' }, h('i', { class: 'fa-solid fa-magnifying-glass-minus' }), slider, h('i', { class: 'fa-solid fa-magnifying-glass-plus' })),
                h('div', { class: 'bim-row bim-crop-actions' }, mk('fa-rotate-left', tr('Reset'), reset), mk('fa-expand', tr('Show whole image'), showAll)),
                h('div', { class: 'bim-row bim-crop-actions' }, mk('fa-xmark', tr('Cancel'), () => close(null)), mk('fa-check', tr('Apply crop'), () => apply(), 'primary'))));

            const onKey = e => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                close(null);
            };
            function close(result) {
                document.removeEventListener('keydown', onKey, true);
                box.remove();
                URL.revokeObjectURL(url);
                cropOpen = false;
                resolve(result);
            }
            async function apply() {
                const out = document.createElement('canvas');
                out.width = OUT_W;
                out.height = OUT_H;
                paint(out.getContext('2d'), OUT_W / vw, OUT_H / vh);
                const blob = await new Promise(r => out.toBlob(r, 'image/png'));
                close(blob ? new File([blob], 'avatar.png', { type: 'image/png' }) : null);
            }

            document.addEventListener('keydown', onKey, true);
            document.body.append(box);
            reset();
        }
    });
}

function renderTags(it) {
    const box = it.el.querySelector('.bim-chips');
    const input = box.querySelector('input');
    box.querySelectorAll('.bim-chip').forEach(n => n.remove());
    for (const t of it.tags) {
        const x = h('button', { type: 'button', title: tr('Remove tag'), 'aria-label': tr('Remove tag {t}', { t }) }, '×');
        x.addEventListener('click', () => { it.tags = it.tags.filter(v => v !== t); renderTags(it); });
        box.insertBefore(h('span', { class: 'bim-chip' }, t, x), input);
    }
    schedulePool();
}

function addTags(it, text) {
    for (const t of String(text).split(',').map(s => s.trim()).filter(Boolean)) {
        if (!it.tags.some(x => x.toLowerCase() === t.toLowerCase())) it.tags.push(t);
    }
    renderTags(it);
}

let poolTimer = null;
function schedulePool() {
    clearTimeout(poolTimer);
    poolTimer = setTimeout(refreshPool, 30);
}

/** Shows every tag found on the selected cards; tapping one removes it from all of them. */
function refreshPool() {
    if (!els.pool) return;
    const counts = new Map();
    for (const it of items) {
        if (!it.selected) continue;
        for (const t of it.tags) {
            const k = t.toLowerCase();
            const c = counts.get(k) || { name: t, n: 0 };
            c.n++;
            counts.set(k, c);
        }
    }
    els.pool.replaceChildren(...[...counts.values()]
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
        .map(({ name, n }) => {
            const b = h('button', { type: 'button', class: 'bim-pool-chip', title: tp('poolTitle', n, { name }) },
                name, h('span', { class: 'bim-pool-n' }, String(n)), h('i', { class: 'fa-solid fa-xmark' }));
            b.addEventListener('click', () => removeTags(items.filter(i => i.selected), [name]));
            return b;
        }));
    els.poolWrap.hidden = !counts.size;
}

/** Removes the given tags from every card in targets. Returns how many cards changed. */
function removeTags(targets, names) {
    const drop = new Set(names.map(n => n.toLowerCase()));
    let changed = 0;
    for (const it of targets) {
        const before = it.tags.length;
        it.tags = it.tags.filter(t => !drop.has(t.toLowerCase()));
        if (it.tags.length !== before) { changed++; renderTags(it); }
    }
    return changed;
}

function applyIgnore(it) {
    const orig = it.originalTags.map(t => t.toLowerCase());
    const added = it.tags.filter(t => !orig.includes(t.toLowerCase()));
    const merged = [...baseTags(it.originalTags), ...added];
    it.tags = merged.filter((t, i) => merged.findIndex(u => u.toLowerCase() === t.toLowerCase()) === i);
    renderTags(it);
}

function setIgnoreAll(v) {
    cfg().ignoreCardTags = !!v;
    save();
    if (els.ignoreChk) els.ignoreChk.checked = !!v;
    const s = document.getElementById('bim_ignore');
    if (s) s.checked = !!v;
    items.forEach(applyIgnore);
}

function renderExtras(it) {
    const box = it.el.querySelector('.bim-extras');
    box.replaceChildren(...it.extras.map(w => {
        const x = h('button', { type: 'button', title: tr('Remove lorebook'), 'aria-label': tr('Remove lorebook {w}', { w }) }, '×');
        x.addEventListener('click', () => { it.extras = it.extras.filter(v => v !== w); renderExtras(it); fillExtraSel(it); });
        return h('span', { class: 'bim-chip' }, w, x);
    }));
    box.hidden = !it.extras.length;
}

function fillExtraSel(it) {
    const sel = it.el.querySelector('.bim-extra-sel');
    sel.replaceChildren(
        h('option', { value: '' }, tr('Add a lorebook')),
        ...worlds.filter(w => !it.extras.includes(w)).map(w => h('option', { value: w }, w)));
    sel.value = '';
}

function addExtra(it, name) {
    if (!it.extras.includes(name)) it.extras.push(name);
    renderExtras(it);
    fillExtraSel(it);
}

function fillWorld(it) {
    const sel = it.el.querySelector('.bim-world');
    const own = it.raw.data.extensions?.world;
    sel.replaceChildren(
        h('option', { value: '' }, own ? tr('Keep the card’s lorebook ({own})', { own }) : tr('Keep the card’s setting')),
        h('option', { value: '__none__' }, tr('No linked lorebook')),
        ...worlds.map(w => h('option', { value: w }, w)),
    );
    sel.value = it.world;
    fillExtraSel(it);
}

function cmpCol(title, text) {
    return h('div', {}, h('div', { class: 'bim-cmp-title' }, title), h('div', { class: 'bim-cmp-col' }, String(text || '').trim() || tr('(empty)')));
}

function dupEl(it, m) {
    const where = m.src === 'lib' ? tr('In your library') : tr('In this batch');
    const body = h('div', { class: 'bim-dup-body' },
        h('div', { class: 'bim-dup-title' }, tr(m.label)),
        h('div', { class: 'bim-dup-sub' }, `${where}: `, h('b', {}, m.name || tr('(no name)')),
            m.level === 'name' ? '' : tr(', description {d}, intro {i}', { d: pct(m.d), i: pct(m.i) })));
    if (m.level !== 'name') {
        body.append(h('details', { class: 'bim-cmp' },
            h('summary', {}, tr('Compare intro messages')),
            h('div', { class: 'bim-cmp-grid' }, cmpCol(tr('This card'), it.raw.data.first_mes), cmpCol(m.name || tr('Match'), m.intro))));
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
    if (it.status === 'importing') s.append(h('i', { class: 'fa-solid fa-spinner fa-spin' }), tr(' Importing…'));
    else if (it.status === 'done') s.append(h('i', { class: 'fa-solid fa-check' }), tr(' Imported'));
    else if (it.status === 'error') s.append(h('i', { class: 'fa-solid fa-triangle-exclamation' }), tr(' Failed: {error}', { error: it.error }));
}

function createCard(it) {
    const d = it.raw.data;
    const sel = h('input', { type: 'checkbox', class: 'bim-sel', checked: it.selected, 'aria-label': tr('Import {name}', { name: it.name }) });
    sel.addEventListener('change', () => { it.selected = sel.checked; it.userToggled = true; it.el.classList.toggle('unsel', !it.selected); updateFooter(); });

    const picker = h('input', { type: 'file', accept: 'image/*', hidden: true });
    picker.addEventListener('change', () => { const f = picker.files[0]; picker.value = ''; if (f) chooseAvatar(it, f); });

    const avatar = h('div', { class: 'bim-avatar', role: 'button', tabindex: '0', title: tr('Change profile picture') },
        h('span', { class: 'bim-letter' }), h('span', { class: 'bim-cam' }, h('i', { class: 'fa-solid fa-camera' })));
    avatar.addEventListener('click', () => picker.click());
    avatar.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
    avatar.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); avatar.classList.add('over'); });
    avatar.addEventListener('dragleave', () => avatar.classList.remove('over'));
    avatar.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); avatar.classList.remove('over');
        const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
        if (f) chooseAvatar(it, f);
    });

    const cropBtn = h('button', { type: 'button', class: 'bim-crop-btn', title: tr('Crop picture'), 'aria-label': tr('Crop picture'), hidden: true }, h('i', { class: 'fa-solid fa-crop-simple' }));
    cropBtn.addEventListener('click', () => recrop(it));

    const reset = h('button', { type: 'button', class: 'bim-reset', title: tr('Go back to the original picture'), hidden: true }, h('i', { class: 'fa-solid fa-rotate-left' }));
    reset.addEventListener('click', () => setAvatar(it, null));

    const tagInput = h('input', { type: 'text', class: 'bim-tag-input', placeholder: tr('Add a tag'), list: 'bim-taglist', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'none' });
    const commit = () => { if (tagInput.value.trim()) { addTags(it, tagInput.value); tagInput.value = ''; } };
    tagInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
        else if (e.key === 'Backspace' && !tagInput.value && it.tags.length) { it.tags.pop(); renderTags(it); }
    });
    tagInput.addEventListener('input', () => { if (tagInput.value.includes(',')) commit(); });
    tagInput.addEventListener('change', commit);
    tagInput.addEventListener('blur', commit);

    const worldSel = h('select', { class: 'bim-world', 'aria-label': tr('Lorebook') });
    worldSel.addEventListener('change', () => { it.world = worldSel.value; });

    const extraSel = h('select', { class: 'bim-extra-sel', 'aria-label': tr('Add an additional lorebook') });
    extraSel.addEventListener('change', () => { if (extraSel.value) addExtra(it, extraSel.value); extraSel.value = ''; });

    const alts = d.alternate_greetings.length;
    const snippet = (d.description || d.first_mes || '').replace(/\s+/g, ' ').trim().slice(0, 200);

    it.el = h('article', { class: 'bim-card' },
        h('div', { class: 'bim-card-top' },
            h('div', { class: 'bim-avatar-wrap' }, avatar, cropBtn, reset, picker),
            h('div', { class: 'bim-info' },
                h('label', { class: 'bim-namerow' }, sel, h('span', { class: 'bim-name', title: it.name }, it.name)),
                h('div', { class: 'bim-badges' },
                    h('span', { class: 'bim-badge' }, it.kind === 'png' ? tr('PNG card') : tr('JSON card')),
                    alts ? h('span', { class: 'bim-badge' }, tp('greetN', alts)) : null,
                    d.character_book ? h('span', { class: 'bim-badge' }, tr('Has its own lorebook')) : null),
                h('p', { class: 'bim-snippet' }, snippet || tr('No description'))),
            h('button', { type: 'button', class: 'bim-x', title: tr('Remove from this list'), 'aria-label': tr('Remove {name} from the list', { name: it.name }), onclick: () => removeItem(it) }, h('i', { class: 'fa-solid fa-xmark' }))),
        h('div', { class: 'bim-dups' }),
        h('div', { class: 'bim-field' }, h('span', { class: 'bim-lbl' }, h('i', { class: 'fa-solid fa-tags' }), tr('Tags')), h('div', { class: 'bim-chips' }, tagInput)),
        h('div', { class: 'bim-field' }, h('span', { class: 'bim-lbl' }, h('i', { class: 'fa-solid fa-book' }), tr('Main lorebook')), worldSel),
        h('div', { class: 'bim-field' }, h('span', { class: 'bim-lbl' }, h('i', { class: 'fa-solid fa-book-bookmark' }), tr('Additional lorebooks')), h('div', { class: 'bim-extras', hidden: true }), extraSel),
        h('div', { class: 'bim-state', hidden: true }));

    renderAvatar(it); renderTags(it); renderExtras(it); fillWorld(it); renderDups(it); renderState(it); syncSel(it);
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
    if (els.bulkExtra) {
        els.bulkExtra.replaceChildren(
            h('option', { value: '' }, tr('Add an additional lorebook')),
            ...worlds.map(w => h('option', { value: w }, w)));
    }
    if (els.bulkWorld) {
        els.bulkWorld.replaceChildren(
            h('option', { value: '' }, tr('Choose a lorebook')),
            h('option', { value: '__none__' }, tr('No linked lorebook')),
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
    if (busy) { toast('info', tr('Wait for the current import to finish.')); return; }
    const list = files.filter(f => /\.(png|json)$/i.test(f.name));
    if (files.length - list.length) toast('warning', tp('skipN', files.length - list.length));
    if (!list.length) return;
    setStatus(tp('readN', list.length));
    const fresh = [];
    const errors = [];
    for (const f of list) {
        try { fresh.push(await parseFile(f)); } catch (e) { errors.push(`${f.name}: ${tr(e.message)}`); }
    }
    for (const it of fresh) { items.push(it); els.grid.append(createCard(it)); }
    updateFooter();
    if (errors.length) toast('error', errors.slice(0, 4).join('; ') + (errors.length > 4 ? tr('; and {n} more', { n: errors.length - 4 }) : ''));
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
            i.onerror = () => rej(new Error(tr('could not read the chosen picture')));
            i.src = url;
        });
        const W = 512, H = 768;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const sw = W / scale, sh = H / scale;
        canvas.getContext('2d').drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) * 0.2, sw, sh, 0, 0, W, H);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        if (!blob) throw new Error(tr('could not process the chosen picture'));
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
    if (!r.ok) throw new Error(tr('the server answered {status}', { status: r.status }));
    const data = await r.json();
    if (!data?.file_name) throw new Error(tr('the server rejected this card'));
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

/** Additional lorebooks live in SillyTavern's lorebook settings, keyed by the card's file name without extension. */
async function applyExtraBooks(avatar, books) {
    const wi = await import('../../../world-info.js');
    const info = wi.world_info;
    if (!info) throw new Error(tr('lorebook settings are not reachable'));
    const key = avatar.replace(/\.[^.]+$/, '');
    info.charLore ??= [];
    let entry = info.charLore.find(e => e.name === key);
    if (!entry) { entry = { name: key, extraBooks: [] }; info.charLore.push(entry); }
    entry.extraBooks = [...new Set([...(entry.extraBooks || []), ...books])];
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
        const pngBuf = it.avatarCropped ? await it.newAvatar.arrayBuffer() : await imageToAvatarPng(it.newAvatar);
        const chunks = writeCardChunks(readPng(pngBuf), it.raw, it.hadV3);
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
    if (it.extras.length) {
        try {
            await applyExtraBooks(avatar, it.extras);
        } catch (e) {
            console.warn('[BotImporter] additional lorebooks failed', e);
            toast('warning', tr('{name} was imported, but its additional lorebooks could not be set.', { name: it.name }));
        }
    }
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
    if (ok) toast('success', tp('importedToast', ok) + (fail ? tr(', {fail} failed', { fail }) : '') + '.');
    else toast('error', tr('Nothing could be imported. Open the failed cards for details.'));
    setStatus(fail ? tp('failedN', fail) : ok ? tp('importedN', ok) : '');
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
        ? tr('{sel} of {total} selected', { sel, total: items.length }) + (flagged ? tp('dupN', flagged) : '')
        : tr('No cards added yet');
    els.importBtn.disabled = busy || !sel;
    els.importLabel.textContent = sel ? tp('importN', sel) : tr('Import');
    els.empty.hidden = items.length > 0;
    schedulePool();
}

function bulkTargets() {
    const t = items.filter(i => i.selected);
    if (!t.length) toast('info', tr('Select some cards first.'));
    return t;
}

function buildModal() {
    const fileInput = h('input', { type: 'file', multiple: true, accept: '.png,.json,image/png,application/json', hidden: true });
    fileInput.addEventListener('change', async () => { const f = [...fileInput.files]; fileInput.value = ''; await addFiles(f); });

    const drop = h('div', { class: 'bim-drop', role: 'button', tabindex: '0' },
        h('i', { class: 'fa-solid fa-cloud-arrow-up' }),
        h('div', { class: 'bim-drop-text' }, h('b', {}, tr('Add character cards')), h('span', {}, tr('Drop PNG or JSON files here, or tap to browse. You can pick as many as you like.'))),
        fileInput);
    drop.addEventListener('click', e => { if (e.target !== fileInput) fileInput.click(); });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });

    els.status = h('div', { class: 'bim-status', hidden: true, 'aria-live': 'polite' });
    els.grid = h('div', { class: 'bim-grid' });
    els.empty = h('div', { class: 'bim-empty' }, h('i', { class: 'fa-regular fa-folder-open' }), h('p', {}, tr('Cards you add show up here. Set a picture, tags and a lorebook on each one, then import them together.')));

    els.bulkTag = h('input', { type: 'text', class: 'bim-input', placeholder: tr('Tag for selected cards'), list: 'bim-taglist', enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'none' });
    const applyBulkTag = () => {
        const v = els.bulkTag.value.trim();
        if (!v) return;
        const t = bulkTargets();
        if (!t.length) return;
        t.forEach(i => addTags(i, v));
        els.bulkTag.value = '';
        toast('success', tp('tagAddedN', t.length));
    };
    els.bulkTag.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyBulkTag(); } });

    els.bulkWorld = h('select', { class: 'bim-input', 'aria-label': tr('Lorebook for selected cards') });
    els.bulkWorld.addEventListener('change', () => {
        const v = els.bulkWorld.value;
        if (!v) return;
        const t = bulkTargets();
        t.forEach(i => { i.world = v; fillWorld(i); });
        if (t.length) toast('success', tp('lbSetN', t.length));
        els.bulkWorld.value = '';
    });

    const btn = (icon, label, fn, cls = '') => h('button', { type: 'button', class: `bim-btn ${cls}`, onclick: fn }, h('i', { class: `fa-solid ${icon}` }), label);

    els.bulkExtra = h('select', { class: 'bim-input', 'aria-label': tr('Additional lorebook for selected cards') });
    els.bulkExtra.addEventListener('change', () => {
        const v = els.bulkExtra.value;
        if (!v) return;
        const t = bulkTargets();
        t.forEach(i => addExtra(i, v));
        if (t.length) toast('success', tp('lbAddedN', t.length));
        els.bulkExtra.value = '';
    });

    els.bulkRemove = h('input', { type: 'text', class: 'bim-input', placeholder: tr('Tags to remove, separated by commas'), enterkeyhint: 'done', autocomplete: 'off', autocapitalize: 'none' });
    const applyBulkRemove = () => {
        const names = els.bulkRemove.value.split(',').map(s => s.trim()).filter(Boolean);
        if (!names.length) return;
        const t = bulkTargets();
        if (!t.length) return;
        const n = removeTags(t, names);
        els.bulkRemove.value = '';
        toast(n ? 'success' : 'info', n ? tp('removedN', n) : tr('None of the selected cards had those tags.'));
    };
    els.bulkRemove.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyBulkRemove(); } });

    els.ignoreChk = h('input', { type: 'checkbox', checked: cfg().ignoreCardTags });
    els.ignoreChk.addEventListener('change', () => setIgnoreAll(els.ignoreChk.checked));

    els.pool = h('div', { class: 'bim-pool' });
    els.poolWrap = h('div', { class: 'bim-pool-wrap', hidden: true },
        h('div', { class: 'bim-lbl' }, tr('Tags on the selected cards. Tap one to remove it from all of them')), els.pool);

    const bulk = h('div', { class: 'bim-bulk' },
        h('div', { class: 'bim-row' },
            btn('fa-check-double', tr('Select all'), () => { items.forEach(i => { i.selected = true; i.userToggled = true; syncSel(i); }); updateFooter(); }),
            btn('fa-square', tr('Select none'), () => { items.forEach(i => { i.selected = false; i.userToggled = true; syncSel(i); }); updateFooter(); }),
            btn('fa-filter', tr('Only unique'), () => { items.forEach(i => { i.selected = !i.level || i.level === 'name'; i.userToggled = true; syncSel(i); }); updateFooter(); }),
            btn('fa-trash-can', tr('Clear list'), () => { if (busy) return; [...items].forEach(i => removeItem(i, true)); updateFooter(); setStatus(''); })),
        h('div', { class: 'bim-row' }, els.bulkTag, btn('fa-tag', tr('Add tags'), applyBulkTag)),
        h('div', { class: 'bim-row' }, els.bulkRemove, btn('fa-eraser', tr('Remove tags'), applyBulkRemove)),
        els.poolWrap,
        h('div', { class: 'bim-row' }, els.bulkWorld, els.bulkExtra),
        h('label', { class: 'bim-check' }, els.ignoreChk, h('span', {}, tr('Ignore tags that come with the cards'))));

    els.importLabel = h('span', {}, tr('Import'));
    els.importBtn = h('button', { type: 'button', class: 'bim-btn primary', onclick: doImport }, h('i', { class: 'fa-solid fa-file-import' }), els.importLabel);
    els.summary = h('div', { class: 'bim-summary' });
    els.bar = h('div', { class: 'bim-bar' });
    els.barWrap = h('div', { class: 'bim-bar-wrap', hidden: true }, els.bar);

    const modal = h('div', { class: 'bim-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bot Importer' },
        h('header', { class: 'bim-head' },
            h('div', { class: 'bim-logo' }, h('i', { class: 'fa-solid fa-boxes-packing' })),
            h('div', {}, h('div', { class: 'bim-title' }, 'Bot Importer'), h('div', { class: 'bim-sub' }, tr('Import many bots at once without opening each one'))),
            h('button', { type: 'button', class: 'bim-lang', title: tr('Language'), onclick: switchLang }, curLang() === 'ru' ? 'EN' : 'RU'),
            h('button', { type: 'button', class: 'bim-close', 'aria-label': tr('Close'), onclick: closeModal }, h('i', { class: 'fa-solid fa-xmark' }))),
        h('div', { class: 'bim-body' }, drop, els.status, bulk, els.grid, els.empty),
        h('footer', { class: 'bim-foot' }, els.barWrap, els.summary, els.importBtn),
        h('datalist', { id: 'bim-taglist' }));

    modal.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    modal.addEventListener('dragleave', e => { if (!modal.contains(e.relatedTarget)) drop.classList.remove('over'); });
    modal.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f); });

    overlay = h('div', { id: 'bim-overlay' }, modal);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
    document.body.append(overlay);
    if (!escBound) {
        escBound = true;
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !cropOpen && overlay?.classList.contains('open')) closeModal(); });
    }
}

async function openModal() {
    if (!overlay) buildModal();
    overlay.classList.add('open');
    document.body.classList.add('bim-lock');
    updateFooter();
    if (els.ignoreChk) els.ignoreChk.checked = cfg().ignoreCardTags;
    refreshTagList();
    await refreshWorlds();
}

function closeModal() {
    if (busy || !overlay) return;
    overlay.classList.remove('open');
    document.body.classList.remove('bim-lock');
}

/* ---------- entry points and settings ---------- */

function switchLang() {
    cfg().language = curLang() === 'ru' ? 'en' : 'ru';
    save();
    rebuildUI();
}

/** Rebuilds every piece of UI text after a language change, keeping the staged cards. */
function rebuildUI() {
    const wasOpen = !!overlay?.classList.contains('open');
    overlay?.remove();
    overlay = null;
    for (const k of Object.keys(els)) delete els[k];
    mountSettings();
    const b = document.getElementById('bim_char_btn');
    if (b) b.title = tr('Bulk import with Bot Importer');
    if (!wasOpen && !items.length) return;
    buildModal();
    for (const it of items) els.grid.append(createCard(it));
    if (wasOpen) {
        overlay.classList.add('open');
        document.body.classList.add('bim-lock');
    }
    refreshTagList();
    refreshWorlds();
    finalize();
}

function mountSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    document.getElementById('bim_settings')?.remove();
    const c = cfg();
    const wrap = h('div', { id: 'bim_settings', class: 'bim-settings' });
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Bot Importer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="bim_open" class="menu_button menu_button_icon"><i class="fa-solid fa-boxes-packing"></i><span>${tr('Open Bot Importer')}</span></div>
                <label class="bim-set">${tr('Language')}
                    <select id="bim_lang" class="text_pole">
                        <option value="auto">${tr('Automatic')}</option>
                        <option value="en">English</option>
                        <option value="ru">Русский</option>
                    </select>
                </label>
                <label class="bim-set">${tr('Duplicate threshold:')} <b id="bim_dup_val">${c.dupThreshold}</b>%
                    <input id="bim_dup" type="range" min="60" max="100" step="1" value="${c.dupThreshold}">
                </label>
                <label class="bim-set">${tr('Similar threshold:')} <b id="bim_sim_val">${c.similarThreshold}</b>%
                    <input id="bim_sim" type="range" min="30" max="95" step="1" value="${c.similarThreshold}">
                </label>
                <label class="checkbox_label"><input id="bim_auto" type="checkbox" ${c.autoSkipExact ? 'checked' : ''}><span>${tr('Untick exact duplicates automatically')}</span></label>
                <label class="checkbox_label"><input id="bim_crop" type="checkbox" ${c.askCrop ? 'checked' : ''}><span>${tr('Open the cropper when choosing a picture')}</span></label>
                <label class="checkbox_label"><input id="bim_ignore" type="checkbox" ${c.ignoreCardTags ? 'checked' : ''}><span>${tr('Ignore tags that come with the cards')}</span></label>
                <label class="bim-set">${tr('Always ignore these tags (separated by commas)')}
                    <input id="bim_ignored" type="text" class="text_pole" autocomplete="off">
                </label>
                <small>${tr('Cards are compared by description and intro messages, never by name alone. New thresholds apply to cards added from now on.')}</small>
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
    wrap.querySelector('#bim_crop').addEventListener('change', e => { cfg().askCrop = e.target.checked; save(); });
    wrap.querySelector('#bim_ignore').addEventListener('change', e => setIgnoreAll(e.target.checked));
    const ignored = wrap.querySelector('#bim_ignored');
    ignored.value = c.ignoredTags || '';
    ignored.addEventListener('change', () => { cfg().ignoredTags = ignored.value; save(); items.forEach(applyIgnore); });
    const lang = wrap.querySelector('#bim_lang');
    lang.value = c.language || 'auto';
    lang.addEventListener('change', () => { cfg().language = lang.value; save(); rebuildUI(); });
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
        imp.after(h('div', { id: 'bim_char_btn', class: 'menu_button fa-solid fa-boxes-packing faSmallFontSquareFix', title: tr('Bulk import with Bot Importer'), tabindex: '0', role: 'button', onclick: openModal }));
    }
}

function init() {
    cfg();
    mountSettings();
    mountButtons();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
