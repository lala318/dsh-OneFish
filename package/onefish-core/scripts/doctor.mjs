#!/usr/bin/env node
/**
 * OneFish Core 体检：不启动 DSH，直接查这台机器上能不能跑起来。
 *
 *   node scripts/doctor.mjs [profile]
 *
 * 和设置页「自检」查的是同一批东西，外加「插件有没有注册进 profile」——
 * 新装的人最容易卡在这一步：代码在，插件没挂上，界面里什么都没有。
 *
 * 退出码：0 全部通过或有提醒；1 有「异常」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const results = [];
function check(id, title, status, detail, hint = '') {
  results.push({ id, title, status, detail, hint });
}

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── 1. 运行时 ────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = major > 22 || (major === 22 && minor >= 13);
check('node', 'Node 运行时', nodeOk ? 'pass' : 'fail', `v${process.versions.node}`,
  nodeOk ? '' : '需要 Node ≥ 22.13；用 DSH 自带的运行时，或升级系统 Node');

// ── 2. 数据目录 ──────────────────────────────────────────────────
let core = null;
let coreError = '';
try {
  const coreUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'lib', 'core', 'index.js')).href;
  const mod = await import(coreUrl);
  core = mod.createCore({ repoRoot: PACKAGE_ROOT, logger: () => {} });
} catch (error) {
  coreError = String(error?.message ?? error);
}
if (!core) {
  check('core', '核心加载', 'fail', coreError, '先 npm install，再跑这个脚本');
} else {
  let writable = false;
  let writeError = '';
  try {
    const probe = path.join(core.paths.stateDir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    writable = true;
  } catch (error) {
    writeError = String(error?.message ?? error);
  }
  check('home', '数据目录可写', writable ? 'pass' : 'fail', writable ? core.paths.home : writeError,
    writable ? '' : '用 ONEFISH_CORE_HOME 指到一个可写目录');

  const configExists = fs.existsSync(core.paths.configFile);
  check('config', '配置文件', configExists ? 'pass' : 'warn',
    configExists ? core.paths.configFile : '还没有 config.json（用默认值也能跑）',
    configExists ? '' : '打开设置页保存一次，或跑 node scripts/doctor.mjs --init');

  const personaHealth = core.persona.health();
  const personaConfigured = personaHealth.hasCharacter || fs.existsSync(core.paths.fallbackPersona);
  check('persona', '人格卡', personaConfigured ? 'pass' : 'warn',
    personaConfigured ? `${personaHealth.name || '未命名'} · ${personaHealth.chars || 0} 字` : '还是内置的中性人格',
    personaConfigured ? '' : '去设置页「人格」写一张，或点「一键初始化」');

  const memoryHealth = core.memory.health();
  check('memory', '记忆', memoryHealth.total > 0 ? 'pass' : 'warn',
    `共 ${memoryHealth.total || 0} 条（core ${memoryHealth.core || 0} / active ${memoryHealth.active || 0} / knowledge ${memoryHealth.knowledge || 0}）`,
    memoryHealth.total > 0 ? '' : '先记几条，召回才有东西可挑');

  let embedding = null;
  try {
    embedding = typeof core.embedding.probe === 'function'
      ? await core.embedding.probe({ timeoutMs: 8000 })
      : core.embedding.status();
  } catch (error) {
    embedding = { ready: false, error: String(error?.message ?? error) };
  }
  check('embedding', '向量模型', embedding?.ready ? 'pass' : 'warn',
    embedding?.ready ? `已就绪（${embedding.model || embedding.backend || 'onnx'}）` : (embedding?.error ? `未就绪：${embedding.error}` : '未就绪，召回退化为词面匹配'),
    embedding?.ready ? '' : '需要本地模型文件；不装也能跑，只是召回变弱');

  check('archive', '档案', 'pass', `${core.archive.listDays().length} 天`, '');
}

// ── 3. 插件注册（新装最容易漏的一步）────────────────────────────
let profile = String(process.argv[2] || process.env.DSH_PROFILE || '').trim();
if (!profile) {
  try {
    const names = fs.readdirSync(path.join(DSH_HOME, 'profiles')).filter((name) => fs.existsSync(path.join(DSH_HOME, 'profiles', name, 'package.json')));
    profile = names.includes('desktop') ? 'desktop' : (names[0] || '');
  } catch {}
}
if (!profile) {
  check('profile', 'DSH profile', 'warn', `没在 ${path.join(DSH_HOME, 'profiles')} 下找到 profile`, '先启动一次 DSH，或在命令行传 profile 名');
} else if (!fs.existsSync(path.join(DSH_HOME, 'profiles', profile))) {
  check('profile', 'DSH profile', 'warn', `profile 目录不存在：${path.join(DSH_HOME, 'profiles', profile)}`,
    '还没装 DSH，或 DSH_HOME 指错了；装好后跑 npm run setup');
} else {
  const profileDir = path.join(DSH_HOME, 'profiles', profile);
  const pkg = readJson(path.join(profileDir, 'package.json'));
  const registered = Boolean(pkg?.dependencies?.['onefish-core']);
  const bundled = Boolean(Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('onefish-core'));
  check('profile', `插件注册（${profile}）`, registered && bundled ? 'pass' : 'fail',
    registered && bundled ? 'package.json 已登记 bundle' : `dependency=${registered ? '有' : '无'} bundle=${bundled ? '有' : '无'}`,
    registered && bundled ? '' : '跑 npm run setup，然后完全退出 DSH 再打开');

  const linkPath = path.join(profileDir, 'node_modules', 'onefish-core');
  let linked = false;
  try { linked = fs.existsSync(linkPath); } catch {}
  check('link', 'profile 链接', linked ? 'pass' : 'fail', linkPath, linked ? '' : '跑 npm run setup 重建链接');

  let patchText = '';
  try { patchText = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'); } catch {}
  const mcpOk = patchText.includes('mcp-onefish-core');
  check('mcp', 'MCP 注册', mcpOk ? 'pass' : 'fail',
    mcpOk ? 'cordis.patch.yml 里有 mcp-onefish-core' : 'cordis.patch.yml 里没有 mcp-onefish-core',
    mcpOk ? '' : '跑 npm run setup 补写 MCP 段');
}

const presetFile = path.join(PACKAGE_ROOT, 'presets', 'onefish-core.patch.yml');
check('preset', 'agent preset', fs.existsSync(presetFile) ? 'pass' : 'fail', presetFile,
  fs.existsSync(presetFile) ? '' : '包里缺 preset，重新拉一份仓库');

// ── 输出 ─────────────────────────────────────────────────────────
const mark = { pass: '✔', warn: '!', fail: '✘' };
console.log(`OneFish Core 体检 · ${os.hostname()} · profile=${profile || '(未识别)'}\n`);
for (const item of results) {
  console.log(`${mark[item.status] || '?'} ${item.title}：${item.detail}`);
  if (item.hint) console.log(`    → ${item.hint}`);
}
const failed = results.filter((item) => item.status === 'fail').length;
const warned = results.filter((item) => item.status === 'warn').length;
console.log(`\n通过 ${results.length - failed - warned} · 提醒 ${warned} · 异常 ${failed}`);

// --init：把能自动补的补上（和设置页「一键初始化」同义）
if (process.argv.includes('--init') && core) {
  console.log('\n[--init] 补人格卡与配置文件…');
  const personaConfigured = core.persona.health().hasCharacter || fs.existsSync(core.paths.fallbackPersona);
  if (!personaConfigured) {
    core.persona.update('# 新角色\n\n## 你是谁\n- 还没写。\n');
    console.log('  人格卡：已写一版空壳');
  } else {
    console.log('  人格卡：已有，没动');
  }
  if (!fs.existsSync(core.paths.configFile)) {
    fs.writeFileSync(core.paths.configFile, `${JSON.stringify(core.config, null, 2)}\n`, 'utf8');
    console.log(`  配置：已落盘 ${core.paths.configFile}`);
  } else {
    console.log('  配置：已存在，没动');
  }
}

process.exit(failed > 0 ? 1 : 0);
