'use strict';

/**
 * 验证厂商专属适配（providerProfiles）：
 *  - auto 按 provider / transport / model 正确识别 deepseek / openai / claude；
 *  - 无匹配返回空串（不注入）；
 *  - 显式 none / 自定义文本覆盖。
 */

const { PROFILES, resolveProfile, resolveSpeed, detectProvider } = require('../src/providerProfiles');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); }

check('auto: deepseek → 注入 deepseek profile', () => eq(resolveProfile({ provider: 'deepseek' }), PROFILES.deepseek.text));
check('auto: openai → 注入 openai profile', () => eq(resolveProfile({ provider: 'openai' }), PROFILES.openai.text));
check('auto: claude provider → 注入 claude profile', () => eq(resolveProfile({ provider: 'claude' }), PROFILES.claude.text));
check('auto: transport=anthropic → 注入 claude profile', () => eq(resolveProfile({ transport: 'anthropic' }), PROFILES.claude.text));
check('auto: model 含 deepseek（中转透传）→ 注入 deepseek profile', () => eq(resolveProfile({ provider: 'openrouter', model: 'deepseek/deepseek-chat' }), PROFILES.deepseek.text));
check('auto: model 含 claude → 注入 claude profile', () => eq(resolveProfile({ provider: 'openrouter', model: 'anthropic/claude-sonnet' }), PROFILES.claude.text));
check('auto: 无匹配 provider/model → 返回空串', () => eq(resolveProfile({ provider: 'zhipu', model: 'glm-4-flash' }), ''));
check('auto: 空 cfg → 返回空串', () => eq(resolveProfile(), ''));
check('显式 none → 返回空串', () => eq(resolveProfile({ providerProfile: 'none', provider: 'deepseek' }), ''));
check('显式 off → 返回空串', () => eq(resolveProfile({ providerProfile: 'off', provider: 'deepseek' }), ''));
check('显式 deepseek → 注入 deepseek profile（即使 provider=openai）', () => eq(resolveProfile({ providerProfile: 'deepseek', provider: 'openai' }), PROFILES.deepseek.text));
check('显式自定义文本 → 原样返回', () => eq(resolveProfile({ providerProfile: 'CUSTOM', provider: 'deepseek' }), 'CUSTOM'));

// —— 速度层 ——
check('speed: deepseek 有专属 timeout/maxTokens', () => {
  const s = resolveSpeed({ provider: 'deepseek' });
  eq(s, PROFILES.deepseek.speed);
});
check('speed: claude timeout 更长（慢厂商）', () => {
  eq(resolveSpeed({ provider: 'claude' }).timeout, 120000);
});
check('speed: 本地模型走 LOCAL_SPEED', () => {
  eq(resolveSpeed({ provider: 'llamacpp', local: true }).timeout, 120000);
});
check('speed: 未识别厂商返回 null（用全局默认）', () => {
  eq(resolveSpeed({ provider: 'zhipu' }), null);
});
check('detectProvider: model 含 deepseek → deepseek', () => eq(detectProvider({ provider: 'openrouter', model: 'deepseek/deepseek-chat' }), 'deepseek'));
check('detectProvider: 未识别 → null', () => eq(detectProvider({ provider: 'zhipu', model: 'glm-4-flash' }), null));

console.log('\n[providerProfiles] 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
