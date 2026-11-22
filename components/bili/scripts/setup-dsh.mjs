#!/usr/bin/env node
/**
 * 把 B站组件注册到当前 DSH profile（幂等）。
 *
 *   node scripts/setup-dsh.mjs [profile] [--dry-run]
 *
 * 做四件事：
 *   1. ~/.dsh/plugins/onefish-component-bili -> components/bili
 *   2. profile/node_modules/onefish-component-bili -> 上面的链接
 *   3. profile package.json：dependency + bundles 加 onefish-component-bili
 *   4. profile cordis.patch.yml：挂 mcp-onefish-bili（绝对路径 node + lib/mcp.mjs）
 *
 * 只改 DSH profile 的注册信息，不改 Core，也不改核心数据。
 * 凭据默认继续读旧 surfcore 的 credentials.json（config.credentialsFile 可改），不复制、不打印。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, readConfigFile, writeConfigFile } from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const BUNDLE = 'onefish-component-bili';
const MCP_BEGIN = '# === onefish-component-bili MCP BEGIN ===';
const MCP_END = '# === onefish-component-bili MCP END ===';

let profile = '';
let dryRun = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run' || arg === '-n') dryRun = true;
  else if (!profile) profile = arg;
}
profile = profile || process.env.DSH_PROFILE || 'desktop';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function log(message) {
  console.log(`[setup-onefish-bili]${dryRun ? ' (dry-run)' : ''} ${message}`);
}

function fatal(message) {
  console.error(`[setup-onefish-bili] ERROR: ${message}`);
  process.exit(1);
}

function ensureDir(dir) {
  if (dryRun) return;
  fs.mkdirSync(dir, { recursive: true });
}

function backupFile(file) {
  if (dryRun || !fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-onefish-component-bili-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function ensureDirLink(linkPath, targetPath, label) {
  if (dryRun) {
    log(`将创建 ${label}：${linkPath} -> ${targetPath}`);
    return linkPath;
  }
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
    let content = fs.readFileSync(file, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  if (dryRun) return;
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
  const pkg = readJson(file, null);
  if (!pkg) fatal(`profile package.json 不存在或无法解析：${file}`);
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

function seedComponentConfig(stateDir, configFile) {
  if (fs.existsSync(configFile)) {
    log(`组件配置已存在：${configFile}`);
    return readConfigFile(configFile);
  }
  // 从旧 surfcore bili.config.json 取主人 mid/称呼，其余走默认值。
  const legacy = readJson(path.join(DSH_HOME, 'surfcore', 'bili.config.json'), null);
  const owner = legacy?.owner && typeof legacy.owner === 'object' ? legacy.owner : {};
  const seed = normalizeConfig({
    owner: { mid: String(owner.mid ?? ''), name: String(owner.name ?? '主人') },
  });
  if (dryRun) {
    log(`将写入组件配置：${configFile}（owner.mid ${seed.owner.mid ? '来自旧配置' : '未设置'}）`);
    return seed;
  }
  writeConfigFile(configFile, seed);
  log(`组件配置已写入：${configFile}`);
  return seed;
}

function patchProfileMcp(profileDir) {
  const file = path.join(profileDir, 'cordis.patch.yml');
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch {}
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const blockRe = new RegExp(`${MCP_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MCP_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`, 'm');
  content = content.replace(blockRe, '').replace(/\s+$/g, '');

  const nodeExe = findNodeExe();
  const mcpEntry = path.join(PACKAGE_ROOT, 'lib', 'mcp.mjs');
  if (!fs.existsSync(mcpEntry)) fatal(`找不到 MCP 入口：${mcpEntry}`);
  const stateDir = path.resolve(
    String(process.env.ONEFISH_COMPONENT_STATE_DIR || process.env.ONEFISH_BILI_STATE_DIR || '').trim()
      || path.join(DSH_HOME, 'onefish-data', 'components', 'bili')
  );
  const configFile = path.resolve(
    String(process.env.ONEFISH_COMPONENT_CONFIG_FILE || '').trim()
      || path.join(stateDir, 'config.json')
  );
  ensureDir(stateDir);
  seedComponentConfig(stateDir, configFile);

  const block = [
    MCP_BEGIN,
    '- insert:',
    '    - id: mcp-onefish-bili',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: onefish-bili',
    '        transport: stdio',
    `        command: ${yamlQuote(nodeExe)}`,
    '        args:',
    `          - ${yamlQuote(mcpEntry)}`,
    '        env:',
    `          ONEFISH_COMPONENT_STATE_DIR: ${yamlQuote(stateDir)}`,
    `          ONEFISH_COMPONENT_CONFIG_FILE: ${yamlQuote(configFile)}`,
    '        toolCallTimeoutMs: 600000',
    MCP_END,
    '',
  ].join('\n');

  if (dryRun) {
    log(`将写入 profile MCP：${file}`);
    console.log(block);
    return { stateDir, configFile };
  }
  backupFile(file);
  fs.writeFileSync(file, `${content ? `${content}\n\n` : ''}${block}`, 'utf8');
  log(`profile MCP 已写入：${file}`);
  return { stateDir, configFile };
}

if (profile === '.' || profile === '..' || profile === 'node_modules'
  || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile)) {
  fatal(`非法 profile：${JSON.stringify(profile)}`);
}

const profileDir = path.join(DSH_HOME, 'profiles', profile);
if (!fs.existsSync(path.join(PACKAGE_ROOT, 'package.json'))) fatal(`组件包不存在：${PACKAGE_ROOT}`);
if (!fs.existsSync(path.join(profileDir, 'package.json'))) fatal(`profile 不存在：${profileDir}`);

log(`profile：${profile}`);
log(`组件：${PACKAGE_ROOT}`);

const installLink = ensureDirLink(path.join(DSH_HOME, 'plugins', BUNDLE), PACKAGE_ROOT, 'bundle install link');
ensureDirLink(path.join(profileDir, 'node_modules', BUNDLE), installLink, 'profile node_modules link');
patchProfilePackage(profileDir, installLink);
const mcpInfo = patchProfileMcp(profileDir);

log('');
log('注册完成。下一步：');
log('  1) 组件配置（凭据路径 / owner.mid / 轮询间隔）：npm run settings -- show');
log(`     配置文件：${mcpInfo?.configFile || '(见 profile MCP env)'}`);
log('  2) 完全退出 DSH，再打开');
log('  3) 在 DSH 工具列表里应出现 mcp__onefish-bili__bili_* 工具');
log('');
log('凭据：默认继续读 ~/.dsh/surfcore/bili/credentials.json；不会写进仓库，也不会出现在 prompt 里。');
