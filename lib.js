/* Bot Importer: pure helpers (no SillyTavern imports, so they can be tested anywhere). */

/* ---------- PNG chunks ---------- */

export const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function readPng(buf) {
    const u = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) if (u[i] !== PNG_SIG[i]) throw new Error('not a valid PNG file');
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const chunks = [];
    let p = 8;
    while (p + 12 <= u.length) {
        const len = dv.getUint32(p);
        const type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
        if (p + 12 + len > u.length) throw new Error('PNG file is truncated');
        chunks.push({ type, data: u.subarray(p + 8, p + 8 + len) });
        p += 12 + len;
        if (type === 'IEND') break;
    }
    return chunks;
}

export function writePng(chunks) {
    let size = 8;
    for (const c of chunks) size += 12 + c.data.length;
    const out = new Uint8Array(size);
    out.set(PNG_SIG, 0);
    const dv = new DataView(out.buffer);
    let p = 8;
    for (const c of chunks) {
        dv.setUint32(p, c.data.length);
        for (let i = 0; i < 4; i++) out[p + 4 + i] = c.type.charCodeAt(i);
        out.set(c.data, p + 8);
        dv.setUint32(p + 8 + c.data.length, crc32(out.subarray(p + 4, p + 8 + c.data.length)));
        p += 12 + c.data.length;
    }
    return out;
}

export function utf8ToB64(str) {
    const u = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function b64ToUtf8(b64) {
    const bin = atob(String(b64).trim());
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(u);
}

export function textChunk(keyword, asciiText) {
    const out = new Uint8Array(keyword.length + 1 + asciiText.length);
    for (let i = 0; i < keyword.length; i++) out[i] = keyword.charCodeAt(i);
    out[keyword.length] = 0;
    for (let i = 0; i < asciiText.length; i++) out[keyword.length + 1 + i] = asciiText.charCodeAt(i);
    return { type: 'tEXt', data: out };
}

export function readTextChunk(c) {
    const z = c.data.indexOf(0);
    if (z < 0) return { key: '', val: '' };
    const dec = new TextDecoder('latin1');
    return { key: dec.decode(c.data.subarray(0, z)), val: dec.decode(c.data.subarray(z + 1)) };
}

/** Finds the character card inside a PNG (prefers ccv3, falls back to chara). */
export function extractCard(chunks) {
    let chara = null;
    let ccv3 = null;
    for (const c of chunks) {
        if (c.type !== 'tEXt') continue;
        const { key, val } = readTextChunk(c);
        if (key === 'ccv3') ccv3 = val;
        else if (key === 'chara') chara = val;
    }
    const src = ccv3 || chara;
    if (!src) return null;
    try {
        return { json: JSON.parse(b64ToUtf8(src)), hadV3: !!ccv3 };
    } catch {
        throw new Error('the character data inside this PNG is corrupted');
    }
}

/** Returns a new chunk list with the card (re)written just before IEND. */
export function writeCardChunks(base, raw, hadV3) {
    const out = base.filter(c => !(c.type === 'tEXt' && ['chara', 'ccv3'].includes(readTextChunk(c).key)));
    const v2 = JSON.parse(JSON.stringify(raw));
    if (v2.spec === 'chara_card_v3') {
        v2.spec = 'chara_card_v2';
        v2.spec_version = '2.0';
    }
    const add = [textChunk('chara', utf8ToB64(JSON.stringify(v2)))];
    if (hadV3 || raw.spec === 'chara_card_v3') add.push(textChunk('ccv3', utf8ToB64(JSON.stringify(raw))));
    let at = out.findIndex(c => c.type === 'IEND');
    if (at < 0) at = out.length;
    out.splice(at, 0, ...add);
    return out;
}

/* ---------- Card normalisation ---------- */

/** Accepts V1 (flat), V2 and V3 cards and always returns an object shaped like { spec, data:{...} }. */
export function normalizeCard(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not a character card');
    let raw = json;
    const isSpec = raw.data && typeof raw.data === 'object' && /^chara_card_v/.test(String(raw.spec || ''));
    if (!isSpec) {
        raw = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: json.name || json.char_name || '',
                description: json.description || json.char_persona || '',
                personality: json.personality || '',
                scenario: json.scenario || json.world_scenario || '',
                first_mes: json.first_mes || json.char_greeting || '',
                mes_example: json.mes_example || json.example_dialogue || '',
                creator_notes: json.creator_notes || json.creatorcomment || '',
                system_prompt: '',
                post_history_instructions: '',
                alternate_greetings: Array.isArray(json.alternate_greetings) ? json.alternate_greetings : [],
                tags: Array.isArray(json.tags) ? json.tags : [],
                creator: json.creator || '',
                character_version: json.character_version || '',
                extensions: json.extensions && typeof json.extensions === 'object' ? json.extensions : {},
            },
        };
    }
    const d = raw.data;
    d.name = String(d.name ?? '');
    for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) d[k] = d[k] == null ? '' : String(d[k]);
    d.alternate_greetings = Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(String) : [];
    d.tags = Array.isArray(d.tags) ? d.tags.map(t => String(t).trim()).filter(Boolean) : [];
    if (!d.extensions || typeof d.extensions !== 'object') d.extensions = {};
    return raw;
}

/* ---------- Duplicate scoring ---------- */

export function norm(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\{\{\s*(char|user)\s*\}\}|<\s*(bot|user)\s*>/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Word n-gram set. Longer texts use trigrams, short ones fall back to bigrams or single words. */
export function shingles(s) {
    const t = norm(s).split(' ').filter(Boolean);
    const set = new Set();
    if (!t.length) return set;
    const n = t.length >= 8 ? 3 : t.length >= 3 ? 2 : 1;
    for (let i = 0; i <= t.length - n; i++) set.add(t.slice(i, i + n).join(' '));
    return set;
}

/** Jaccard similarity, plus a containment boost so an extended or trimmed copy still scores high. */
export function sim(a, b) {
    if (!a.size || !b.size) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let inter = 0;
    for (const x of small) if (large.has(x)) inter++;
    let score = inter / (a.size + b.size - inter);
    if (small.size >= 15) score = Math.max(score, (0.95 * inter) / small.size);
    return score;
}

/** Fingerprint of the parts that identify a bot: description and intro messages (first message + a few alternates). */
export function makeSig(card) {
    const descText = String(card.description || '').trim() ? card.description : [card.personality, card.scenario].filter(Boolean).join(' ');
    const intros = [card.first_mes, ...(card.alternate_greetings || [])]
        .filter(t => t && String(t).trim())
        .slice(0, 5)
        .map(shingles);
    return { desc: shingles(descText), intros, nameKey: norm(card.name) };
}

/**
 * Compares two fingerprints. Returns null when nothing is worth flagging, otherwise
 * { level, label, d, i, score } where d is description similarity and i is the best intro similarity (0 to 1).
 */
export function evaluate(a, b, dupPct = 85, simPct = 60) {
    const D = dupPct / 100;
    const M = simPct / 100;
    const d = sim(a.desc, b.desc);
    let i = 0;
    for (const x of a.intros) for (const y of b.intros) {
        const v = sim(x, y);
        if (v > i) i = v;
    }
    const sameName = !!a.nameKey && a.nameKey === b.nameKey;
    let level = null;
    let label = '';
    if (d >= D && i >= D) {
        level = 'exact';
        label = d >= 0.99 && i >= 0.99 ? 'Exact duplicate' : 'Near-identical card';
    } else if (d >= D) {
        level = 'alt';
        label = 'Same description, different intro. Could be an alternate scenario';
    } else if (i >= D) {
        level = 'intro';
        label = 'Same intro message, different description';
    } else if (d >= M || i >= M) {
        level = 'similar';
        label = 'Looks similar';
    } else if (sameName) {
        level = 'name';
        label = 'Same name, but the content is different. Probably another bot';
    }
    return level ? { level, label, d, i, score: level === 'name' ? 0 : Math.max(d, i) } : null;
}
