'use strict';

/**
 * 沙盒代码测试管理器（1.1.21）离线测试：
 *  - 内置 Node 沙盒实跑通过
 *  - 用户沙盒 canary 通过才注册为 ready
 *  - 用户沙盒 canary 不通过标记为 invalid（不可用）
 *  - docker runner 在 allowDocker=false 时被拒
 *  - list / reload 行为正确
 * 不依赖 vscode；直接注入临时目录作为沙盒目录。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sandbox = require('../src/sandbox');
const sandboxTest = require('../src/tools/sandboxTest');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
}
function ok(name, fn) {
  return Promise.resolve().then(fn).then(
    () => {},
    (e) => { failed++; console.error('  ✗', name, '异常:', e && e.message ? e.message : e); }
  );
}

// 构造一个临时沙盒目录，写入 manifest.json
function makeUserSandbox(root, name, manifest) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxai-sb-test-'));

  // 1) 内置 Node 沙盒实跑
  await ok('内置 Node.js 沙盒实跑 console.log', async () => {
    const mgr = sandbox.createManager({ dir: root });
    const r = await mgr.run('node', "console.log('HELLO_FROM_SANDBOX')");
    check('返回非空结果', !!r);
    check('退出码 0', r && r.exit === 0);
    check('标准输出含 HELLO_FROM_SANDBOX', r && r.stdout.includes('HELLO_FROM_SANDBOX'));
    check('ok=true', r && r.ok === true);
  });

  // 2) 用户沙盒：canary 通过 → ready
  await ok('用户沙盒 canary 通过则注册为 ready', async () => {
    makeUserSandbox(root, 'myjs', {
      name: 'MyJS', language: 'javascript',
      run: { command: ['node', '{{file}}'], stdin: true },
      file: { ext: '.js' },
      canary: { code: "console.log('CANARY_OK')", expected: 'CANARY_OK' }
    });
    const mgr = sandbox.createManager({ dir: root });
    const list = await mgr.discover();
    const u = list.user.find((x) => x.name === 'MyJS');
    check('发现用户沙盒 MyJS', !!u);
    check('状态为 ready（canary 通过）', u && u.status === 'ready');
    // 可用：实跑一段代码
    const r = await mgr.run('MyJS', "console.log('USER_CODE')");
    check('用户沙盒可运行代码', r && r.stdout.includes('USER_CODE') && r.exit === 0);
  });

  // 3) 用户沙盒：canary 不通过 → invalid（不可用）
  await ok('用户沙盒 canary 不通过则标记 invalid', async () => {
    makeUserSandbox(root, 'broken', {
      name: 'Broken', language: 'javascript',
      run: { command: ['node', '{{file}}'] },
      file: { ext: '.js' },
      // canary 期望输出与代码实际输出不符 → 必失败
      canary: { code: "console.log('real')", expected: 'EXPECTED_BUT_NOT_PRODUCED' }
    });
    const mgr = sandbox.createManager({ dir: root });
    const list = await mgr.discover();
    const u = list.user.find((x) => x.name === 'Broken');
    check('发现 Broken', !!u);
    check('状态为 invalid（canary 未通过）', u && u.status === 'invalid');
    // 不可用：run 应返回 null（找不到可用沙盒）
    const r = await mgr.run('Broken', "console.log('x')");
    check('invalid 沙盒不可被 run 命中', r === null);
  });

  // 4) docker runner 在 allowDocker=false 时被拒
  await ok('docker runner 在 allowDocker=false 时拒绝', async () => {
    makeUserSandbox(root, 'dockerbox', {
      name: 'DockerBox', language: 'whatever',
      run: { runner: 'docker', command: ['echo', 'hi'], docker: { image: 'alpine:latest' } },
      file: { ext: '.txt' },
      canary: { code: "console.log('x')", expected: 'x' }
    });
    const mgr = sandbox.createManager({ dir: root, allowDocker: false });
    const r = await mgr.run('DockerBox', 'x');
    check('返回错误：docker 被禁用', r && r.ok === false && /docker/i.test(r.error || ''));
  });

  // 5) docker runner 在 allowDocker=true 时允许（仅校验不被"禁用"拦截，不真跑 docker）
  await ok('docker runner allowDocker=true 时不再报禁用', async () => {
    makeUserSandbox(root, 'dockerbox2', {
      name: 'DockerBox2', language: 'whatever',
      run: { runner: 'docker', command: ['echo', 'hi'], docker: { image: 'alpine:latest' } },
      file: { ext: '.txt' },
      canary: { code: "console.log('x')", expected: 'x' }
    });
    const mgr = sandbox.createManager({ dir: root, allowDocker: true });
    // 没有 docker 环境，run 会因 spawn 失败返回 error，但不应是因为"被禁用"
    const r = await mgr.run('DockerBox2', 'x');
    check('不是禁用错误（allowDocker=true）', r && !/allowDocker=false/.test(r.error || ''));
  });

  // 6) list 返回内置 + 用户，含状态
  await ok('list 返回内置与用户沙盒', async () => {
    const mgr = sandbox.createManager({ dir: root });
    const list = mgr.list();
    check('内置含 Node.js', list.builtins.some((b) => b.name === 'Node.js'));
    check('内置含 Python/Go/Rust/Java', ['Python', 'Go', 'Rust', 'Java'].every((n) => list.builtins.some((b) => b.name === n)));
    check('用户列表非空', list.user.length > 0);
  });

  // 7) reload 清空缓存并重新扫描
  await ok('reload 重新扫描并返回列表', async () => {
    const mgr = sandbox.createManager({ dir: root });
    const list = await mgr.reload();
    check('reload 返回内置', list.builtins.length === 5);
    check('reload 返回用户', list.user.length > 0);
  });

  // 8) enabled=false 时 run 直接返回未启用
  await ok('enabled=false 时 run 返回未启用', async () => {
    const mgr = sandbox.createManager({ dir: root, enabled: false });
    const r = await mgr.run('node', "console.log('x')");
    check('返回未启用错误', r && r.ok === false && /未启用/.test(r.error || ''));
  });

  // 9) validateManifest 基本校验
  await ok('validateManifest 校验缺字段', async () => {
    check('缺 name → 报错', !!sandbox.validateManifest({ language: 'x', run: { command: ['a'] } }));
    check('缺 run → 报错', !!sandbox.validateManifest({ name: 'x', language: 'y' }));
    check('docker 缺 image → 报错', !!sandbox.validateManifest({ name: 'x', language: 'y', run: { runner: 'docker' } }));
    check('合法 → null', sandbox.validateManifest({ name: 'x', language: 'y', run: { command: ['a'] } }) === null);
  });

  // 10) createSandbox 成功并出现在 list（带 folder 字段）
  await ok('createSandbox 成功并写入 manifest', async () => {
    const mgr = sandbox.createManager({ dir: root });
    const r = await mgr.createSandbox({ name: 'MyGo', template: 'bash' });
    check('ok=true', r.ok === true);
    check('返回 folder 路径', !!r.folder && /mygo$/i.test(r.folder));
    check('manifest.json 已写入', fs.existsSync(path.join(r.folder, 'manifest.json')));
    check('list 含该用户沙盒', r.list.user.some((u) => u.name === 'MyGo' && !!u.folder));
  });

  // 11) createSandbox 重名拒绝
  await ok('createSandbox 重名拒绝', async () => {
    const mgr = sandbox.createManager({ dir: root });
    await mgr.createSandbox({ name: 'Dup', template: 'bash' });
    const r = await mgr.createSandbox({ name: 'Dup', template: 'bash' });
    check('ok=false', r.ok === false);
    check('提示已存在', /已存在/.test(r.error || ''));
  });

  // 12) removeSandbox 内置沙盒拒绝
  await ok('removeSandbox 内置沙盒拒绝', async () => {
    const mgr = sandbox.createManager({ dir: root });
    const r = await mgr.removeSandbox('Node.js');
    check('ok=false', r.ok === false);
    check('提示内置不可删', /内置/.test(r.error || ''));
  });

  // 13) removeSandbox 用户沙盒成功
  await ok('removeSandbox 用户沙盒成功', async () => {
    const mgr = sandbox.createManager({ dir: root });
    await mgr.createSandbox({ name: 'ToDelete', template: 'bash' });
    const r = await mgr.removeSandbox('ToDelete');
    check('ok=true', r.ok === true);
    check('list 不再含该沙盒', !r.list.user.some((u) => u.name === 'ToDelete'));
  });

  // 14) removeSandbox 越权路径拒绝
  await ok('removeSandbox 越权路径拒绝', async () => {
    const mgr = sandbox.createManager({ dir: root });
    const r = await mgr.removeSandbox('../escape');
    check('ok=false', r.ok === false);
  });

  // 15) watch 在目录变化时回调（热感知）
  await ok('watch 热感知目录变化', async () => {
    const mgr = sandbox.createManager({ dir: root });
    let fired = false;
    const stop = mgr.watch((l) => { fired = true; });
    fs.mkdirSync(path.join(root, 'watched'));
    fs.writeFileSync(path.join(root, 'watched', 'manifest.json'), '{"name":"Watched","language":"bash","run":{"command":["bash","{{file}}"]}}');
    await new Promise((res) => setTimeout(res, 600));
    check('watch 回调被触发', fired === true);
    stop();
  });

  // 16) 紧凑 list 输出（token 优化）：单行、无 markdown 大标题、成功运行无尾注
  await ok('token 优化：紧凑 list 与成功无尾注', async () => {
    const mgr = sandbox.createManager({ dir: root });
    const listText = await sandboxTest.run({ action: 'list' }, { cfg: null });
    check('单行紧凑（含内置 Node.js）', /🔒 Node\.js \[javascript\]/.test(listText));
    check('无 "# 沙盒列表" 大标题', !listText.includes('# 沙盒列表'));
    check('列出沙盒目录', /沙盒目录/.test(listText));
    const runText = await sandboxTest.run({ sandbox: 'node', code: "console.log('hi')" }, { cfg: null });
    check('成功运行不带 sandbox.log 尾注', !runText.includes('sandbox.log'));
    const failText = await sandboxTest.run({ sandbox: 'nope', code: 'x' }, { cfg: null });
    check('失败提示带 action=list 指引', /action="list"/.test(failText));
  });

  // 清理
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  console.log(`\n[sandbox] 通过 ${passed} / 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
})();
