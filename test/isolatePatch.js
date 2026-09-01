'use strict';
// 探针：验证 fox_isolate 隔离标签页补丁注入与幂等
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-iso-'));
fs.mkdirSync(path.join(dir, 'src/backend/pool'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src/server/api/openai'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src/server'), { recursive: true });
fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src/backend/adapter'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src/backend/utils'), { recursive: true });
fs.mkdirSync(path.join(dir, 'config'), { recursive: true });

// Worker.js（模拟上游原版 _executeAdapter）
fs.writeFileSync(path.join(dir, 'src/backend/pool/Worker.js'),
`import { registry } from '../registry.js';
export class Worker {
    async _executeAdapter(ctx, type, modelId, prompt, paths, meta) {
        const adapter = registry.getAdapter(type);
        if (!adapter) {
            return { error: '适配器不存在: ' + type };
        }
        logger.info('工作池', '[' + this.name + '] 执行任务 -> ' + type + '/' + modelId, meta);
        const subContext = {
            ...ctx,
            page: this.page,
            config: this.globalConfig
        };
        this.busyCount++;
        try {
            return await adapter.generate(subContext, prompt, paths, modelId, meta);
        } finally {
            this.busyCount--;
        }
    }
}
`);

// routes.js（带 foxNewSession 透传的旧版）
fs.writeFileSync(path.join(dir, 'src/server/api/openai/routes.js'),
`const foxNewSession = data.fox_new_session === true;
            queueManager.addTask({
                req,
                res,
                prompt,
                modelId,
                modelName,
                id: requestId,
                reasoning,
                foxNewSession
            });`);

// queue.js（带 foxNewSession 透传的旧版）
fs.writeFileSync(path.join(dir, 'src/server/queue.js'),
`const { res, prompt, imagePaths, modelId, modelName, id, isStreaming, reasoning, foxNewSession } = task;
            const result = await generate(poolContext, prompt, imagePaths, modelId, { id, reasoning, foxNewSession });`);

const w = require('../src/webai2api');
const logs = [];
const ok = w.patchWebAI2APIProject(dir, (s) => logs.push(s));
console.log('补丁执行:', ok ? '✓' : '✗');
console.log('--- 补丁日志 ---');
logs.forEach((l) => console.log('  ' + l));

const worker = fs.readFileSync(path.join(dir, 'src/backend/pool/Worker.js'), 'utf8');
const routes = fs.readFileSync(path.join(dir, 'src/server/api/openai/routes.js'), 'utf8');
const queue = fs.readFileSync(path.join(dir, 'src/server/queue.js'), 'utf8');
console.log('--- 验证 ---');
console.log('Worker 含隔离标记:', worker.includes('fox-ai:skip-if-ready-isolate-tab') ? '✓' : '✗');
console.log('Worker 含 _isolatePage:', worker.includes('_isolatePage') ? '✓' : '✗');
console.log('Worker subContext 用隔离页:', worker.includes('page: _isolatePage || this.page') ? '✓' : '✗');
console.log('Worker finally 关闭隔离页:', worker.includes('隔离任务完成，已关闭临时标签页') ? '✓' : '✗');
console.log('routes 含 foxIsolate:', (routes.includes('foxIsolate: data.fox_isolate === true') || routes.includes('const foxIsolate = data.fox_isolate === true')) ? '✓' : '✗');
console.log('routes addTask 透传 foxIsolate:', routes.includes('foxIsolate') && routes.includes('queueManager.addTask') && /foxIsolate[\s\S]*\}\);\s*$/.test(routes.slice(routes.indexOf('queueManager.addTask'))) ? '✓' : '✗');
console.log('queue 含 foxIsolate:', queue.includes('foxIsolate') ? '✓' : '✗');

const ok2 = w.patchWebAI2APIProject(dir, () => {});
const worker2 = fs.readFileSync(path.join(dir, 'src/backend/pool/Worker.js'), 'utf8');
const cnt = (worker2.match(/fox-ai:skip-if-ready-isolate-tab/g) || []).length;
console.log('二次调用幂等:', !ok2 && cnt === 1 ? '✓' : '✗ (changed=' + ok2 + ' marks=' + cnt + ')');

fs.rmSync(dir, { recursive: true, force: true });
