'use strict';
// 一次性生成器：把 package.json 里「展示用」中文抽成 %foxai.nN% 占位，
// 并产出 package.nls.json（中文默认）与 package.nls.en.json（英文，初始用中文占位，待翻译）。
// 仅处理白名单字段，避免误伤命令 ID / 正则 / 枚举值等。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'package.json');
const WHITELIST = new Set(['displayName', 'description', 'title', 'name', 'category', 'placeholder', 'tooltip', 'markdownDescription']);

function hasCJK(s) {
  return /[一-鿿]/.test(s);
}

let counter = 0;
const map = Object.create(null); // nN -> 中文

function walk(node) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && WHITELIST.has(k) && hasCJK(v)) {
        const key = 'foxai.n' + (++counter);
        map[key] = v;
        node[k] = '%' + key + '%';
      } else if (v && typeof v === 'object') {
        node[k] = walk(v);
      }
    }
    return node;
  }
  return node;
}

const pkg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
walk(pkg);

fs.writeFileSync(FILE, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
const zh = Object.create(null);
const en = Object.create(null);
for (const k of Object.keys(map)) {
  zh[k] = map[k];
  en[k] = map[k]; // 英文先以中文占位，后续翻译覆盖
}
fs.writeFileSync(path.join(__dirname, '..', 'package.nls.json'), JSON.stringify(zh, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(__dirname, '..', 'package.nls.en.json'), JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('keyed strings:', counter);
console.log('wrote package.nls.json + package.nls.en.json (en placeholder=zh, to translate)');
