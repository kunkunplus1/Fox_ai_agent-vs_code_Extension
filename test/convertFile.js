'use strict';
// 探针：验证 convert_file 的 docx 无损提取逻辑（python zipfile + XML 解析）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-docx-'));
const file = path.join(dir, 'test.docx');
const docXmlPath = path.join(dir, 'doc.xml');

const docXml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + '<w:p><w:r><w:t>标题：季度报告</w:t></w:r></w:p>'
  + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>产品</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>销量</w:t></w:r></w:p></w:tc></w:tr>'
  + '<w:tr><w:tc><w:p><w:r><w:t>手机</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  + '<w:p><w:r><w:t>总结：增长</w:t></w:r></w:p></w:body></w:document>';
fs.writeFileSync(docXmlPath, docXml, 'utf8');

// 用 python 打包 docx
const mkPy = path.join(dir, 'mk.py');
fs.writeFileSync(mkPy, [
  'import zipfile, sys',
  'z = zipfile.ZipFile(sys.argv[1], "w")',
  'z.writestr("[Content_Types].xml", "<?xml version=\\"1.0\\"?><Types xmlns=\\"http://schemas.openxmlformats.org/package/2006/content-types\\"/>")',
  'z.writestr("word/document.xml", open(sys.argv[2], encoding="utf-8").read())',
  'z.close()'
].join('\n'), 'utf8');
execSync('python "' + mkPy + '" "' + file + '" "' + docXmlPath + '"', { encoding: 'utf8' });

// 复刻 convert_file 的提取脚本
const extractPy = path.join(dir, 'extract.py');
fs.writeFileSync(extractPy, [
  'import sys, zipfile, json',
  'from xml.etree import ElementTree as ET',
  'path = sys.argv[1]',
  'NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}',
  'def q(tag):',
  '  pfx, _, local = tag.partition(":")',
  '  return "{" + NS.get(pfx, "") + "}" + local',
  'z = zipfile.ZipFile(path)',
  'root = ET.fromstring(z.read("word/document.xml"))',
  'body = root.find(q("w:body"))',
  'out = []',
  'def text_of(el): return "".join(el.itertext())',
  'for child in body:',
  '  tag = child.tag.split("}")[-1]',
  '  if tag == "p":',
  '    t = text_of(child).strip()',
  '    if t: out.append(t)',
  '  elif tag == "tbl":',
  '    for tr in child.findall(q("w:tr")):',
  '      cells = [" ".join(text_of(tc).split()) for tc in tr.findall(q("w:tc"))]',
  '      out.append("| " + " | ".join(cells) + " |")',
  'print(json.dumps("\\n".join(out), ensure_ascii=False))'
].join('\n'), 'utf8');

const raw = execSync('python "' + extractPy + '" "' + file + '"', { encoding: 'utf8' }).trim();
const result = JSON.parse(raw);
console.log('docx 提取结果:');
console.log(result);
console.log('---');
console.log('含段落文本:', result.includes('季度报告') && result.includes('总结：增长') ? '✓' : '✗');
console.log('含表格行:', result.includes('| 产品 | 销量 |') && result.includes('| 手机 | 100 |') ? '✓' : '✗');
fs.rmSync(dir, { recursive: true, force: true });
