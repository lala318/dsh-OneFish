#!/usr/bin/env node
/**
 * 注册 OneFish Core 到当前 DSH profile（幂等）。
 *
 *   node scripts/setup-onefish-core.mjs [profile]
 *
 * 做四件事：
 *   1. ~/.dsh/plugins/onefish-core -> OneFish/package/onefish-core
 *   2. profile/node_modules/onefish-core -> 上面的链接
 *   3. profile package.json：dependency + bundles 加 onefish-core
 *   4. profile cordis.patch.yml：挂 mcp-onefish-core（绝对路径 node + mcp-core.mjs）
 *
 * 不删除旧 surfcore 注册；重启 DSH 后两个插件并存，便于回退。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const BUNDLE = 'onefish-core';

function log(message) {
  console.log(`[setup-onefish-core] ${message}`);
}

function fatal(message) {
  console.error(`[setup-onefish-core] ERROR: ${message}`);
  process.exit(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-onefish-core-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function ensureDirLink(linkPath, targetPath, label) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const current = path.resolve(fs.readlinkSync(linkPath));
      if (current.toLowerCase() === path.resolve(targetPath).toLowerCase()) return linkPath;
      fs.unlinkSync(linkPath);
    } else {
      fatal(`${label} 已存在且不是链接：${linkPath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`${label} 检查失败：${error?.message ?? error}`);
  }
  ensureDir(path.dirname(linkPath));
  fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  log(`${label} 已创建：${linkPath}`);
  return linkPath;
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function findNodeExe() {
  const candidates = [
    process.env.DSH_NODE,
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    process.execPath,
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return fs.existsSync(candidate) && /node(\.exe)?$/i.test(candidate); } catch { return false; }
  }) || process.execPath;
}

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function patchProfilePackage(profileDir, linkDir) {
  const file = path.join(profileDir, 'package.json');
  const pkg = readJson(file, null) || {
    name: `dsh-profile-${path.basename(profileDir)}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  };
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  const linkValue = `link:${linkDir.replace(/\\/g, '/')}`;
  const changed = [];
  if (pkg.dependencies[BUNDLE] !== linkValue) {
    pkg.dependencies[BUNDLE] = linkValue;
    changed.push(`dependency ${BUNDLE} -> ${linkValue}`);
  }
  if (!pkg.dsh.profile.bundles.includes(BUNDLE)) {
    pkg.dsh.profile.bundles.push(BUNDLE);
    changed.push(`bundle added: ${BUNDLE}`);
  }
  if (changed.length) {
    backupFile(file);
    writeJson(file, pkg);
    for (const line of changed) log(line);
  } else {
    log(`profile package.json 已是最新：${file}`);
  }
}

function patchProfileMcp(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const begin = '# === onefish-core MCP BEGIN ===';
  const end = '# === onefish-core MCP END ===';
  const blockRe = /# === onefish-core MCP BEGIN ===[\s\S]*?# === onefish-core MCP END ===\r?\n?/m;
  text = text.replace(blockRe, '').replace(/\s+$/g, '');

  const nodeExe = findNodeExe();
  const mcpEntry = path.join(PACKAGE_ROOT, 'lib', 'mcp-core.mjs');
  if (!fs.existsSync(mcpEntry)) fatal(`找不到 MCP 入口：${mcpEntry}`);

  const block = [
    begin,
    '- insert:',
    '    - id: mcp-onefish-core',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: onefish-core',
    '        transport: stdio',
    `        command: ${yamlQuote(nodeExe)}`,
    '        args:',
    `          - ${yamlQuote(mcpEntry)}`,
    '        toolCallTimeoutMs: 120000',
    end,
    '',
  ].join('\n');

  const next = `${text ? `${text}\n\n` : ''}${block}`;
  backupFile(file);
  fs.writeFileSync(file, next, 'utf8');
  log(`profile MCP 已写入：${file}`);
}

let profile = process.argv[2] || '';
if (!profile) {
  try {
    const { detectProfile } = await import('./detect-profile.mjs');
    profile = await detectProfile();
  } catch {
    profile = String(process.env.DSH_PROFILE ?? '').trim() || 'desktop';
  }
}

if (profile === '.' || profile === '..' || profile === 'node_modules'
  || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile)) {
  fatal(`非法 profile：${JSON.stringify(profile)}`);
}

const pluginDir = PACKAGE_ROOT;
const profileDir = path.join(DSH_HOME, 'profiles', profile);
if (!fs.existsSync(path.join(pluginDir, 'package.json'))) fatal(`插件包不存在：${pluginDir}`);
if (!fs.existsSync(path.join(profileDir, 'package.json'))) fatal(`profile 不存在：${profileDir}`);
if (!fs.existsSync(path.join(PACKAGE_ROOT, 'presets', 'onefish-core.patch.yml'))) {
  fatal('缺少 presets/onefish-core.patch.yml');
}

log(`profile：${profile}`);
log(`插件：${pluginDir}`);

const installLink = ensureDirLink(path.join(DSH_HOME, 'plugins', BUNDLE), pluginDir, 'bundle install link');
ensureDirLink(path.join(profileDir, 'node_modules', BUNDLE), installLink, 'profile node_modules link');
patchProfilePackage(profileDir, installLink);
patchProfileMcp(profileDir);

log('');
log('注册完成。下一步：');
log('  1) 完全退出 DSH，再打开');
log('  2) 设置里应出现 OneFish（OneFish Core）');
log('  3) 在 DSH 对话窗口选择 preset「OneFish Core」开始对话');
log('  4) 旧 SurfCore 仍保留，可随时切回');
