#!/usr/bin/env node
// output/*.md を作品単位に分割し、静的サイトを dist/ に生成する。
// 依存パッケージなし（Node.js 18 以上）。使い方: node scripts/build.mjs

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'output');
const ASSET_DIR = path.join(ROOT, 'site');
const DIST_DIR = path.join(ROOT, 'dist');

const SITE_TITLE = 'パブリックドメイン詩集';
const SITE_TAGLINE = '植物と天文の詩 ── 原文・日本語訳・解説';
const REPO_URL = 'https://github.com/TatsuyaOGth/poem-collection';

// `- Theme:` の値 → サイト上のテーマ
const THEMES = [
  { id: 'plant', key: 'Plant', label: '植物' },
  { id: 'astronomy', key: 'Astronomy', label: '天文' },
];

// 表記ゆれのある作者名を1つにまとめる
const AUTHOR_ALIASES = {
  'Alfred Tennyson': 'Alfred, Lord Tennyson',
  'H. D. (Hilda Doolittle)': 'H.D. (Hilda Doolittle)',
};

const REQUIRED_FIELDS = ['Theme', 'Author', 'Author Years', 'Public Domain Reason', 'Source URL', 'Added Date'];
const SEC_ORIGINAL = '原文';
const SEC_TRANSLATION = '日本語訳';
const SEC_COMMENTARY = '解説';

// ---------------------------------------------------------------- 文字列処理

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 比較・検索用: アクセント記号を外して小文字化
const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const isJapanese = (s) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(s);

const slugify = (s) => fold(s).replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// エスケープ済みテキストに最小限のインライン装飾（_斜体_ *斜体* **太字**）を適用
const inline = (s) =>
  esc(s)
    .replace(/\*\*([^*\s][^*\n]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*\n]*?)\*/g, '<em>$1</em>')
    .replace(/(?<![\p{L}\p{N}])_([^_\n]+?)_(?![\p{L}\p{N}])/gu, '<em>$1</em>');

// 姓で並べるためのキー（"Walter de la Mare" → "de la mare walter"）
function authorSortKey(name) {
  const words = name.replace(/\s*\(.*\)$/, '').split(/\s+/);
  let i = words.length - 1;
  while (i > 0 && /^(de|la|du|van|von|der)$/.test(words[i - 1])) i--;
  return fold([...words.slice(i), ...words.slice(0, i)].join(' '));
}

// 冠詞を無視したタイトルの並べ替えキー
const titleSortKey = (title) => fold(title).replace(/^[^a-z0-9]+/, '').replace(/^(a|an|the)\s+/, '');

// ---------------------------------------------------------------- 解析

const errors = [];
const warnings = [];

// 末尾の区切り線（---）と前後の空行を取り除く
const trimBody = (s) => s.replace(/\n-{3,}[ \t]*\s*$/, '\n').replace(/^\n+|\s+$/g, '');

function parseFile(file, text) {
  const poems = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/^## /m).slice(1);
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    const heading = (nl === -1 ? block : block.slice(0, nl)).trim();
    const where = `${file}「${heading}」`;
    const parts = block.slice(nl + 1).split(/^### (.+)$/m);

    const fields = {};
    for (const m of parts[0].matchAll(/^- ([A-Za-z ]+): (.*)$/gm)) fields[m[1]] = m[2].trim();
    const sections = [];
    for (let i = 1; i < parts.length; i += 2) sections.push({ name: parts[i].trim(), body: trimBody(parts[i + 1]) });
    const section = (name) => sections.find((s) => s.name === name)?.body ?? '';

    const missing = [
      ...REQUIRED_FIELDS.filter((f) => !fields[f]),
      ...[SEC_ORIGINAL, SEC_TRANSLATION, SEC_COMMENTARY].filter((s) => !section(s)),
    ];
    if (missing.length) {
      errors.push(`${where}: 必須項目がありません（${missing.join(', ')}）`);
      continue;
    }
    const theme = THEMES.find((t) => t.key === fields.Theme);
    if (!theme) {
      errors.push(`${where}: 未知の Theme「${fields.Theme}」`);
      continue;
    }
    if (!/^https?:\/\/\S+$/.test(fields['Source URL'])) {
      errors.push(`${where}: Source URL が不正です（${fields['Source URL']}）`);
      continue;
    }

    // 見出しは「英題 / 邦題」。邦題なし・英題の繰り返し・「邦題 / 英題」の逆順も混在する
    const sep = heading.indexOf(' / ');
    let titleEn = sep === -1 ? heading : heading.slice(0, sep).trim();
    let titleJaRaw = sep === -1 ? '' : heading.slice(sep + 3).trim();
    if (titleJaRaw && isJapanese(titleEn) && !isJapanese(titleJaRaw)) [titleEn, titleJaRaw] = [titleJaRaw, titleEn];
    if (!slugify(titleEn)) {
      errors.push(`${where}: 英題を判別できません`);
      continue;
    }
    const author = AUTHOR_ALIASES[fields.Author] ?? fields.Author;

    poems.push({
      theme,
      titleEn,
      titleJa: titleJaRaw && titleJaRaw !== titleEn ? titleJaRaw : '',
      author,
      years: fields['Author Years'],
      pdReason: fields['Public Domain Reason'],
      sourceUrl: fields['Source URL'],
      added: fields['Added Date'],
      original: section(SEC_ORIGINAL),
      translation: section(SEC_TRANSLATION),
      commentary: section(SEC_COMMENTARY),
      // 「日本語訳補注」など、標準3セクション以外はそのまま補足として載せる
      extras: sections.filter((s) => ![SEC_ORIGINAL, SEC_TRANSLATION, SEC_COMMENTARY].includes(s.name) && s.body),
    });
  }
  if (!blocks.length) warnings.push(`${file}: 作品が見つかりません`);
  return poems;
}

// ---------------------------------------------------------------- HTML 部品

const stanzasOf = (body) => body.split(/\n{2,}/).map((s) => s.split('\n'));

// 詩行。行頭の字下げは CSS 変数 --i（半角スペース数相当）で再現する
function renderLine(line) {
  const lead = line.match(/^[ 　]*/)[0];
  const indent = [...lead].reduce((n, ch) => n + (ch === '　' ? 2.5 : 1), 0);
  const style = indent ? ` style="--i:${indent}"` : '';
  return `<div class="l"${style}>${inline(line.slice(lead.length).trimEnd()) || '&nbsp;'}</div>`;
}

function renderColumn(body, cls, lang, label) {
  const stanzas = stanzasOf(body)
    .map((lines, i) => `<div class="stanza" style="--r:${i + 2}">${lines.map(renderLine).join('')}</div>`)
    .join('\n');
  return `<section class="col ${cls}"${lang ? ` lang="${lang}"` : ''}>
<h2 class="col-head" lang="ja">${label}</h2>
${stanzas}
</section>`;
}

// 解説・補注: 段落と箇条書きだけを解釈する
function renderProse(body) {
  const out = [];
  let para = [];
  let list = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^[-*・]\s+(.*)$/);
    if (!line) flush();
    else if (bullet) {
      if (para.length) flush();
      // 「主題：…」のような見出し語を強調
      const m = bullet[1].match(/^([^：:。、]{1,14})[：:]\s*(.+)$/);
      list.push(m ? `<b>${inline(m[1])}</b>${inline(m[2])}` : inline(bullet[1]));
    } else {
      if (list.length) flush();
      para.push(line);
    }
  }
  flush();
  return out.join('\n');
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%232b2723'/%3E%3Ctext x='16' y='23' font-size='20' text-anchor='middle' fill='%23f7f3ea' font-family='serif'%3E詩%3C/text%3E%3C/svg%3E";

function page({ title, root, bodyClass, main, scripts = '' }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="${root}assets/style.css?v=${assetVersion}">
</head>
<body class="${bodyClass}">
${main}
<footer class="site-footer">
<p>収録している原文はすべてパブリックドメインです。日本語訳と解説は AI による生成であり、誤りを含む可能性があります。</p>
<p><a href="${root}">${SITE_TITLE}</a> ・ <a href="${REPO_URL}" rel="noopener">GitHub</a></p>
</footer>
${scripts}
</body>
</html>
`;
}

function poemPage(poem, prev, next) {
  const root = '../../';
  const aligned = stanzasOf(poem.original).length === stanzasOf(poem.translation).length;
  const host = new URL(poem.sourceUrl).hostname.replace(/^www\./, '');
  const navLink = (p, cls, label) =>
    p
      ? `<a class="${cls}" href="../${p.slug}/"><span class="dir">${label}</span><span class="t" lang="en">${esc(p.titleEn)}</span><span class="by" lang="en">${esc(p.author)}</span></a>`
      : `<span class="${cls}"></span>`;

  const main = `<header class="crumbs">
<a href="${root}#${poem.theme.id}">${SITE_TITLE}</a><span aria-hidden="true">／</span><a href="${root}#${poem.theme.id}">${poem.theme.label}</a>
</header>
<main class="poem">
<header class="poem-head">
<h1 lang="en">${esc(poem.titleEn)}</h1>
${poem.titleJa ? `<p class="title-ja">${esc(poem.titleJa)}</p>` : ''}
<p class="author"><span lang="en">${esc(poem.author)}</span> <span class="years">${esc(poem.years)}</span></p>
</header>

<dl class="info">
<div><dt>テーマ</dt><dd>${poem.theme.label}</dd></div>
<div><dt>権利状態</dt><dd>${esc(poem.pdReason)}</dd></div>
<div><dt>出典</dt><dd><a href="${esc(poem.sourceUrl)}" rel="noopener noreferrer">${esc(host)}</a></dd></div>
<div><dt>追加日</dt><dd><time>${esc(poem.added)}</time></dd></div>
</dl>

<div class="poem-text${aligned ? ' aligned' : ''}">
${renderColumn(poem.original, 'en', 'en', '原文')}
${renderColumn(poem.translation, 'ja', '', '日本語訳')}
</div>
${poem.extras.map((s) => `\n<section class="prose note">\n<h2>${esc(s.name)}</h2>\n${renderProse(s.body)}\n</section>`).join('')}

<section class="prose">
<h2>解説</h2>
${renderProse(poem.commentary)}
</section>

<nav class="pager" aria-label="前後の作品">
${navLink(prev, 'prev', '前の作品')}
${navLink(next, 'next', '次の作品')}
</nav>
</main>`;

  return page({
    title: `${poem.titleEn} — ${poem.author}｜${SITE_TITLE}`,
    root,
    bodyClass: `page-poem theme-${poem.theme.id}`,
    main,
  });
}

function homePage(byTheme, total, latest) {
  const item = (p) => `<li class="item" data-t="${esc(titleSortKey(p.titleEn))}" data-d="${esc(p.added)}" data-q="${esc(fold(`${p.titleEn} ${p.titleJa} ${p.author}`))}">
<a href="${p.theme.id}/${p.slug}/"><span class="t-en" lang="en">${esc(p.titleEn)}</span>${p.titleJa ? `<span class="t-ja">${esc(p.titleJa)}</span>` : ''}</a>
<span class="meta"><span class="by" lang="en">${esc(p.author)}</span><time class="date">${esc(p.added)}</time></span>
</li>`;

  const themeSection = ({ theme, groups, poems }) => `<section class="theme theme-${theme.id}" id="theme-${theme.id}" data-theme="${theme.id}">
<h2 class="theme-title">${theme.label}<span class="count"><span data-count>${poems.length}</span> 作品</span></h2>
<div class="groups">
${groups
  .map(
    (g) => `<section class="group">
<h3><span lang="en">${esc(g.author)}</span> <span class="years">${esc(g.years)}</span></h3>
<ul>
${g.poems.map(item).join('\n')}
</ul>
</section>`
  )
  .join('\n')}
</div>
<ul class="flat" hidden></ul>
<p class="empty" hidden>該当する作品がありません。</p>
</section>`;

  const main = `<header class="site-head">
<h1>${SITE_TITLE}</h1>
<p class="tagline">${SITE_TAGLINE}</p>
<p class="stats">全 ${total} 作品・最終更新 <time>${esc(latest)}</time></p>
</header>
<div class="toolbar">
<nav class="tabs" aria-label="テーマ">
${byTheme.map(({ theme, poems }) => `<a class="tab theme-${theme.id}" href="#theme-${theme.id}" data-tab="${theme.id}">${theme.label}<span class="n">${poems.length}</span></a>`).join('\n')}
</nav>
<div class="controls">
<input type="search" id="q" placeholder="タイトル・作者で絞り込み" aria-label="タイトル・作者で絞り込み" autocomplete="off">
<div class="sort" role="group" aria-label="並び順">
<button type="button" data-sort="author" aria-pressed="true">作者別</button>
<button type="button" data-sort="title" aria-pressed="false">タイトル順</button>
<button type="button" data-sort="date" aria-pressed="false">新着順</button>
</div>
</div>
</div>
<main class="home">
${byTheme.map(themeSection).join('\n')}
</main>`;

  return page({
    title: `${SITE_TITLE}｜植物と天文の詩`,
    root: './',
    bodyClass: 'page-home',
    main,
    scripts: `<script src="assets/home.js?v=${assetVersion}"></script>`,
  });
}

// ---------------------------------------------------------------- ビルド

let assetVersion = '';

async function write(relPath, content) {
  const file = path.join(DIST_DIR, relPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function main() {
  const files = (await readdir(SRC_DIR)).filter((f) => f.endsWith('.md')).sort();
  const poems = [];
  for (const file of files) poems.push(...parseFile(file, await readFile(path.join(SRC_DIR, file), 'utf8')));

  if (errors.length) {
    console.error(`ビルド失敗: ${errors.length} 件のエラー\n` + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }

  // 同じ作品（題名+作者）が複数回収録されていないか
  const seen = new Map();
  for (const p of poems) {
    const key = `${p.theme.id}|${fold(p.titleEn)}|${fold(p.author)}`;
    if (seen.has(key)) warnings.push(`重複の可能性: 「${p.titleEn}」(${p.author}) が ${seen.get(key)} と ${p.added} の両方にあります`);
    else seen.set(key, p.added);
  }

  // テーマごとに作者別（姓順）→ タイトル順で並べ、URL を割り当てる
  const byTheme = THEMES.map((theme) => {
    const list = poems
      .filter((p) => p.theme === theme)
      .sort(
        (a, b) =>
          authorSortKey(a.author).localeCompare(authorSortKey(b.author)) ||
          titleSortKey(a.titleEn).localeCompare(titleSortKey(b.titleEn)) ||
          a.added.localeCompare(b.added)
      );
    const used = new Set();
    const groups = [];
    for (const p of list) {
      const base = `${slugify(p.titleEn)}-${slugify(p.author.replace(/\s*\(.*\)$/, ''))}`;
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
      used.add(slug);
      p.slug = slug;
      if (groups.at(-1)?.author !== p.author) groups.push({ author: p.author, years: p.years, poems: [] });
      groups.at(-1).poems.push(p);
    }
    return { theme, poems: list, groups };
  });

  const assets = ['style.css', 'home.js'];
  const assetData = await Promise.all(assets.map((a) => readFile(path.join(ASSET_DIR, a))));
  assetVersion = createHash('sha1').update(Buffer.concat(assetData)).digest('hex').slice(0, 8);

  await rm(DIST_DIR, { recursive: true, force: true });
  await Promise.all(assets.map((a, i) => write(`assets/${a}`, assetData[i])));

  for (const { theme, poems: list } of byTheme) {
    await Promise.all(list.map((p, i) => write(`${theme.id}/${p.slug}/index.html`, poemPage(p, list[i - 1], list[i + 1]))));
  }
  const latest = poems.reduce((d, p) => (p.added > d ? p.added : d), '');
  await write('index.html', homePage(byTheme, poems.length, latest));

  for (const w of warnings) console.warn(`警告: ${w}`);
  console.log(
    `${files.length} ファイルから ${poems.length} 作品を生成しました（` +
      byTheme.map(({ theme, poems: l }) => `${theme.label} ${l.length}`).join(' / ') +
      `）→ ${path.relative(ROOT, DIST_DIR)}/`
  );
}

await main();
