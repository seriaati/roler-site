// Roler markup in the browser: a parser that follows the bot's documented validation rules,
// and a renderer that draws the result as a Discord message. Used by the playground and the
// reusable-templates demo.

export type Attrs = Record<string, string>;
type Color = 'blurple' | 'green' | 'red' | 'grey';

export interface Button {
  label: string;
  emoji: string;
  color: Color;
  mode: string;
  disabled: boolean;
  kind: 'url' | 'template' | 'role';
  url?: string;
  template?: string;
  role?: string;
  key: string;
  n: number;
}

type Accessory = { t: 'thumb'; a: Attrs } | { t: 'btn'; b: Button };
type Comp =
  | { t: 'text'; lines: string[] }
  | { t: 'sep'; size: 'small' | 'large'; visible: boolean }
  | { t: 'row'; btns: Button[]; n: number }
  | { t: 'gallery'; items: Attrs[] }
  | { t: 'section'; texts: string[]; acc: Accessory | null };

export interface Parsed {
  comps: Comp[];
  errors: string[];
  meta: { template?: Attrs; webhook?: Attrs };
}

export interface RenderOpts {
  stateful?: boolean;
  on?: string;
  off?: string;
  has?: Set<string>;
}

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const now = () => {
  const t = new Date();
  return `Today at ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

const LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
export const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

/* ---------- parser ---------- */

const COLORS: Color[] = ['blurple', 'green', 'red', 'grey'];
const KNOWN = ['button', 'separator', 'image', 'gallery', 'item', 'section', 'thumbnail', 'webhook', 'template'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isUrl = (u?: string) => /^https?:\/\/\S+$/i.test(u || '');

function attrs(s: string): Attrs {
  const o: Attrs = {};
  const re = /(\w+)=("([^"]*)"|<[^>]*>|[^\s\]]+)/g;
  let m;
  while ((m = re.exec(s))) o[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
  return o;
}

// all [button]…[/button] tags on a line, or null if the line holds anything else
function buttonsIn(line: string) {
  const out: { a: Attrs; label: string }[] = [];
  const rest = line.replace(/\[button\b([^\]]*)\]([\s\S]*?)\[\/button\]/gi, (_, a: string, label: string) => {
    out.push({ a: attrs(a), label: label.trim() });
    return '';
  });
  return out.length && !rest.trim() ? out : null;
}

export function parse(src: string): Parsed {
  const errors: string[] = [], comps: Comp[] = [], meta: Parsed['meta'] = {}, buttons: Button[] = [];
  const err = (n: number, msg: string) => errors.push(n ? `Line ${n}: ${msg}` : msg);
  const lines = src.replace(/\r/g, '').split('\n');

  // a template pasted inside a ``` code block still works
  const fence = lines.findIndex(l => l.trim());
  if (fence >= 0 && lines[fence].trim().startsWith('```')) {
    lines[fence] = '';
    for (let k = lines.length - 1; k > fence; k--) if (lines[k].trim()) { if (lines[k].trim() === '```') lines[k] = ''; break; }
  }

  let text: string[] = [], row: { t: 'row'; btns: Button[]; n: number } | null = null, rows = 0, first = true;
  const flushText = () => { if (text.length) { comps.push({ t: 'text', lines: text }); text = []; } };
  const flushRow = () => {
    if (!row) return;
    if (row.btns.length > 5) err(row.n, `a row holds up to 5 buttons, this one has ${row.btns.length}.`);
    rows++; comps.push(row); row = null;
  };
  const mkBtn = ({ a, label }: { a: Attrs; label: string }, n: number): Button => {
    const color = (a.color || 'blurple').toLowerCase().replace('gray', 'grey') as Color;
    const mode = (a.mode || 'toggle').toLowerCase();
    const disabled = String(a.disabled).toLowerCase() === 'true';
    if (!COLORS.includes(color)) err(n, `"${a.color}" isn't a button color. Use blurple, green, red or grey.`);
    if (!['toggle', 'add', 'remove'].includes(mode)) err(n, `"${a.mode}" isn't a button mode. Use toggle, add or remove.`);
    if (a.url) {
      if (a.role || a.template) err(n, `a link button can't also have role= or template=.`);
      if (!isUrl(a.url)) err(n, `link buttons need a url starting with http:// or https://.`);
    }
    if (a.template) {
      if (a.role) err(n, `a template button can't also have role=.`);
      if (!label) err(n, `template buttons need a label.`);
      if (!ID.test(a.template)) err(n, `template IDs use letters, numbers, - and _ only, up to 64 characters.`);
    }
    if (!label && !a.emoji) err(n, `a button needs a label, an emoji, or both.`);
    else if (!a.role && !a.url && !a.template && !label) err(n, `a button without role= needs a label, so Roler can match the role by name.`);
    const kind = a.url ? 'url' : a.template ? 'template' : 'role';
    const b: Button = {
      label, emoji: a.emoji || '', color: COLORS.includes(color) ? color : 'blurple', mode, disabled, kind,
      url: a.url, template: a.template, role: a.role, n,
      key: kind === 'role' ? (a.role || label.toLowerCase()) : (a.template || a.url),
    };
    buttons.push(b);
    return b;
  };

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1, line = lines[i].trim();
    if (!line) { flushText(); flushRow(); continue; }
    const wasFirst = first;
    first = false;
    let m;
    if ((m = line.match(/^\[template\b([^\]]*)\]$/i))) {
      if (!wasFirst) err(n, `[template] has to be the first line of the message.`);
      meta.template = attrs(m[1]);
      if (!ID.test(meta.template.id || '')) err(n, `[template] needs an id made of letters, numbers, - and _, up to 64 characters.`);
      continue;
    }
    if ((m = line.match(/^\[webhook\b([^\]]*)\]$/i))) {
      const a = attrs(m[1]);
      if (!a.name || a.name.length > 80) err(n, `[webhook] needs a name between 1 and 80 characters.`);
      if (a.avatar && !isUrl(a.avatar)) err(n, `the [webhook] avatar has to be an http:// or https:// link.`);
      meta.webhook = a;
      continue;
    }
    if (line === '---') { flushText(); flushRow(); comps.push({ t: 'sep', size: 'large', visible: true }); continue; }
    if ((m = line.match(/^\[separator\b([^\]]*)\]$/i))) {
      flushText(); flushRow();
      const a = attrs(m[1]);
      comps.push({ t: 'sep', size: (a.size || 'large').toLowerCase() === 'small' ? 'small' : 'large', visible: String(a.visible || 'true').toLowerCase() !== 'false' });
      continue;
    }
    if ((m = line.match(/^\[image\b([^\]]*)\]$/i))) {
      flushText(); flushRow();
      const a = attrs(m[1]);
      if (!isUrl(a.url)) err(n, `[image] needs a url starting with http:// or https://.`);
      comps.push({ t: 'gallery', items: [a] });
      continue;
    }
    if (/^\[gallery\]$/i.test(line)) {
      flushText(); flushRow();
      const items: Attrs[] = [];
      let j = i + 1, closed = false;
      for (; j < lines.length; j++) {
        const l = lines[j].trim();
        if (/^\[\/gallery\]$/i.test(l)) { closed = true; break; }
        const im = l.match(/^\[item\b([^\]]*)\]$/i);
        if (im) {
          const a = attrs(im[1]);
          if (!isUrl(a.url)) err(j + 1, `gallery items need a url starting with http:// or https://.`);
          items.push(a);
        } else if (l) err(j + 1, `only [item] tags go inside a [gallery].`);
      }
      if (!closed) err(n, `this [gallery] is never closed with [/gallery].`);
      if (items.length < 1 || items.length > 10) err(n, `a gallery holds 1 to 10 items, this one has ${items.length}.`);
      comps.push({ t: 'gallery', items });
      i = j;
      continue;
    }
    if (/^\[section\]$/i.test(line)) {
      flushText(); flushRow();
      const texts: string[] = [];
      let acc: Accessory | null = null, j = i + 1, closed = false;
      for (; j < lines.length; j++) {
        const l = lines[j].trim();
        if (/^\[\/section\]$/i.test(l)) { closed = true; break; }
        if (!l) continue;
        const tm = l.match(/^\[thumbnail\b([^\]]*)\]$/i);
        if (tm) {
          const a = attrs(tm[1]);
          if (!isUrl(a.url)) err(j + 1, `[thumbnail] needs a url starting with http:// or https://.`);
          acc = { t: 'thumb', a };
          continue;
        }
        const bs = buttonsIn(l);
        if (bs) { acc = { t: 'btn', b: mkBtn(bs[bs.length - 1], j + 1) }; continue; }
        texts.push(l);
      }
      if (!closed) err(n, `this [section] is never closed with [/section].`);
      if (texts.length < 1 || texts.length > 3) err(n, `a section holds 1 to 3 lines of text, this one has ${texts.length}.`);
      if (!acc) err(n, `a section needs one [thumbnail] or [button] as its accessory.`);
      comps.push({ t: 'section', texts, acc });
      i = j;
      continue;
    }
    const bs = buttonsIn(line);
    if (bs) {
      flushText();
      if (!row) row = { t: 'row', btns: [], n };
      for (const b of bs) row.btns.push(mkBtn(b, n));
      continue;
    }
    if ((m = line.match(/^\[\/?([a-z]+)(\s[^\]]*)?\]/i))) {
      const tag = m[1].toLowerCase();
      if (tag === 'button') err(n, `this [button] is missing its closing [/button].`);
      else if (tag === 'thumbnail') err(n, `[thumbnail] only works inside a [section].`);
      else if (tag === 'item') err(n, `[item] only works inside a [gallery].`);
      else if (!KNOWN.includes(tag)) err(n, `Roler doesn't know the [${m[1]}] tag.`);
      else err(n, `[${m[1]}] can't go here.`);
      continue;
    }
    flushRow();
    text.push(line);
  }
  flushText(); flushRow();
  if (rows > 5) err(0, `A panel holds up to 5 rows of buttons. This one has ${rows}.`);

  // uniqueness: role IDs, template IDs and name-matched labels; disabled buttons are exempt
  const seen = { role: new Map<string, number>(), template: new Map<string, number>(), label: new Map<string, number>() };
  for (const b of buttons) {
    if (b.disabled || b.kind === 'url') continue;
    const bucket = b.kind === 'template' ? 'template' : b.role ? 'role' : 'label';
    const k = bucket === 'label' ? b.label.toLowerCase() : b.key;
    const at = seen[bucket].get(k);
    if (at === undefined) seen[bucket].set(k, b.n);
    else err(b.n, bucket === 'label'
      ? `"${b.label}" is already used by a button on line ${at}. Name-matched buttons need different labels.`
      : `this ${bucket} is already used by a button on line ${at}.`);
  }
  if (!comps.length && !errors.length) err(0, `The template is empty. Add some text or a button.`);
  return { comps, errors, meta };
}

/* ---------- renderer ---------- */

function inline(s: string) {
  return esc(s)
    .replace(/&lt;a?:(\w+):\d+&gt;/g, (_, nm: string) => `<span class="dc-cemoji" title=":${nm}:">${nm[0].toUpperCase()}</span>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>');
}

function textHtml(lines: string[]) {
  let out = '', list = false;
  for (const l of lines) {
    const li = l.match(/^[-*] (.*)$/);
    if (li) {
      if (!list) { out += '<ul>'; list = true; }
      out += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (list) { out += '</ul>'; list = false; }
    let m;
    if ((m = l.match(/^### (.*)$/))) out += `<h3>${inline(m[1])}</h3>`;
    else if ((m = l.match(/^## (.*)$/))) out += `<h2>${inline(m[1])}</h2>`;
    else if ((m = l.match(/^# (.*)$/))) out += `<h1>${inline(m[1])}</h1>`;
    else if ((m = l.match(/^-# (.*)$/))) out += `<small>${inline(m[1])}</small>`;
    else if ((m = l.match(/^> (.*)$/))) out += `<blockquote>${inline(m[1])}</blockquote>`;
    else out += `<p>${inline(l)}</p>`;
  }
  if (list) out += '</ul>';
  return `<div class="dc-text">${out}</div>`;
}

// Unsplash photos used by the playground presets, served from /img instead of hotlinking
const PHOTOS: Record<string, string> = {
  'photo-1522120657009-060ca01afcd6': '/img/owl.jpg',
  'photo-1593305841991-05c297ba4575': '/img/setup.jpg',
  'photo-1746635732312-0083b7f9423f': '/img/cards.jpg',
  'photo-1612287230202-1ff1d85d1bdf': '/img/controller.jpg',
};
const photoSrc = (url: string) => PHOTOS[(url.match(/unsplash\.com\/(photo-[\w-]+)/) || [])[1]] || url;

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// an image tile; if the picture can't load, the tile keeps its file name on a tinted background
function media(url: string | undefined, cls: string) {
  const h = hue(url || 'x'), a = 190 + h % 40, b = 205 + (h >> 4) % 40;
  const name = (url || '').split(/[/?#]/).filter(Boolean).pop() || 'image';
  const img = url && isUrl(url) ? `<img src="${esc(photoSrc(url))}" alt="" loading="lazy">` : '';
  return `<div class="${cls} dc-ph" style="background:linear-gradient(135deg,hsl(${a} 32% 30%),hsl(${b} 38% 18%))">${img}${esc(name)}</div>`;
}
if (typeof window !== 'undefined') {
  addEventListener('error', e => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.matches('.dc-ph > img, .dc-av > img')) t.remove();
  }, true);
}

function emojiHtml(e: string) {
  if (!e) return '';
  const m = e.match(/^<a?:(\w+):\d+>$/);
  return m ? `<span class="dc-cemoji" title=":${m[1]}:">${m[1][0].toUpperCase()}</span>` : `<span>${esc(e)}</span>`;
}

function btnHtml(b: Button, opts: RenderOpts) {
  let color = b.color as string;
  if (opts.stateful && b.kind === 'role') color = opts.has?.has(b.key) ? (opts.on || 'blurple') : (opts.off || 'grey');
  const inner = `${emojiHtml(b.emoji)}${b.label ? `<span>${inline(b.label)}</span>` : ''}${b.kind === 'url' ? LINK : ''}`;
  if (b.kind === 'url' && !b.disabled && isUrl(b.url)) {
    return `<a class="dc-btn c-grey" href="${esc(b.url!)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  }
  const cls = `dc-btn c-${b.kind === 'url' ? 'grey' : color}${b.disabled ? ' dis' : ''}`;
  return `<button type="button" class="${cls}" data-kind="${b.kind}" data-key="${esc(b.key || '')}" data-label="${esc(b.label || b.emoji)}" data-mode="${b.mode}"${b.disabled ? ' aria-disabled="true"' : ''}>${inner}</button>`;
}

export function render(comps: Comp[], opts: RenderOpts = {}) {
  return comps.map(c => {
    switch (c.t) {
      case 'text': return textHtml(c.lines);
      case 'sep': return `<div class="dc-sep ${c.size}${c.visible ? '' : ' inv'}"></div>`;
      case 'row': return `<div class="dc-row">${c.btns.map(b => btnHtml(b, opts)).join('')}</div>`;
      case 'gallery': {
        const k = c.items.length;
        return `<div class="dc-gal${k === 1 ? ' one' : ''}" style="--cols:${k === 1 ? 1 : k === 2 || k === 4 ? 2 : 3}">${c.items.map(it => media(it.url, 'dc-img')).join('')}</div>`;
      }
      case 'section': {
        const acc = !c.acc ? '' : c.acc.t === 'thumb' ? media(c.acc.a.url, 'dc-thumb') : btnHtml(c.acc.b, opts);
        return `<div class="dc-section">${textHtml(c.texts)}<div>${acc}</div></div>`;
      }
    }
  }).join('');
}

// a whole message: avatar, name, APP tag and timestamp around the rendered body
export function messageHtml(meta: Parsed['meta'], body: string, extra: { time?: string; edited?: boolean; foot?: string } = {}) {
  const wh = meta.webhook?.name;
  const avatar = wh && isUrl(meta.webhook!.avatar) ? `<img src="${esc(photoSrc(meta.webhook!.avatar))}" alt="">` : '';
  const av = wh
    ? `<div class="dc-av wh">${avatar}${esc(wh[0].toUpperCase())}</div>`
    : `<div class="dc-av"><img src="/logo.png" alt=""></div>`;
  return `<div class="dc-msg">${av}<div class="dc-main"><div class="dc-head"><b>${esc(wh || 'Roler')}</b><em>APP</em><time>${extra.time || now()}</time>${extra.edited ? '<span class="ed">(edited)</span>' : ''}</div><div class="dc-body">${body}</div>${extra.foot || ''}</div></div>`;
}

// syntax colors for the editors and template views
export function highlight(src: string) {
  const tag = (s: string) => s.replace(/\[(\/?)([a-zA-Z]+)([^\]\n]*)\]/g, (_, sl: string, name: string, rest: string) =>
    `<span class="h-tag">[${sl}${name}</span>${rest.replace(/(\w+)=(&quot;[^&\n]*?&quot;|&lt;\S*?&gt;|[^\s]+)/g, '<span class="h-attr">$1=</span><span class="h-val">$2</span>')}<span class="h-tag">]</span>`);
  return esc(src).split('\n').map(l => {
    if (/^(#{1,3}|-#) /.test(l)) return `<span class="h-head">${tag(l)}</span>`;
    if (l.trim() === '---') return `<span class="h-tag">${l}</span>`;
    return tag(l);
  }).join('\n') + '\n';
}
