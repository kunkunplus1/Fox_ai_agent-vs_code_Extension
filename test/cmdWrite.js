'use strict';
// 探针：验证 _isCmdFileWrite 写文件命令检测（逻辑复制自 agent.js，防 bash 转义）
function isCmdFileWrite(cmd) {
  const c = String(cmd || '');
  if (!c) return false;
  if (/\b(cat|type|more|less|head|tail|grep|find|dir|ls)\b/.test(c) && !/[>|]\s*[\w\\/.\-]+\.\w{1,10}/.test(c)) {
    if (!/>>?\s*[\w\\/.\-]/.test(c)) return false;
  }
  if (/>>?\s*["']?[\w\\/:.\-]+\.\w{1,10}["']?\s*$/.test(c)) return true;
  if (/>>?\s*["']?[\w\\/:.\-]+\.\w{1,10}["']?\s+&&/.test(c)) return true;
  if (/\bsed\s+(-[a-z]*i[a-z]*)\b/.test(c)) return true;
  if (/\bperl\s+-[a-z]*pi[a-z]*\b/.test(c)) return true;
  if (/\bpython\s+(-c|-m)\b[\s\S]*\b(open\s*\(|\.write\s*\()/.test(c)) return true;
  if (/\btee\b/.test(c) && /[\w\\/.\-]+\.\w{1,10}/.test(c)) return true;
  if (/\b(cp|move|mv|copy)\b[\s\S]*(\.\w{1,10})[\s\S]*(\.\w{1,10})/.test(c) &&
      !/\b(cp|mv|copy)\b[\s\S]*(\/usr\/|\/bin\/|system32|c:\\windows)/i.test(c)) return true;
  return false;
}

const cases = [
  ['echo hello > note.md', true],
  ['echo "你好" >> note.md', true],
  ['sed -i s/foo/bar/g config.json', true],
  ['perl -pi -e s/a/b/g file.txt', true],
  ['printf x > out.txt && cat out.txt', true],
  ['type nul > empty.log', true],
  ['cp file1.txt file2.txt', true],
  ['mv old.txt new.txt', true],
  ['tee result.txt < input.txt', true],
  ['python -c "open(\'a.txt\',\'w\').write(\'hi\')"', true],
  ['cat note.md', false],
  ['ls -la', false],
  ['node --check src/agent.js', false],
  ['git status', false],
  ['npm install', false],
  ['rm -rf /tmp/cache', false],
  ['head -20 file.txt', false],
  ['grep -r foo src', false],
  ['dir C:\\Users', false],
  ['copy /y C:\\a.txt C:\\b.txt', true],
  ['cd src && npm test', false],
  ['python run_tests.py', false],
];

let pass = 0, fail = 0;
for (const [cmd, expect] of cases) {
  const got = isCmdFileWrite(cmd);
  const ok = got === expect;
  ok ? pass++ : fail++;
  if (!ok) console.log('✗', JSON.stringify(cmd), '→', got, '期望', expect);
}
console.log('写文件命令检测: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
