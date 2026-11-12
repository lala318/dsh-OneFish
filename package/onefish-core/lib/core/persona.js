/**
 * 人格服务：读取/切换/编辑当前角色的人格卡。
 *
 * MVP 复用现有角色包目录：
 *   characters/<id>/character.json
 *   characters/<id>/persona.md
 *   characters/current.json
 * 没有角色系统时：只读 core 自己的 core/persona.md，或使用内置中性人格；
 * 不自动读取旧 SurfCore 角色包 / 仓库 roles/，避免测试污染线上数据。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_PROMPT_CHARS = 6000;

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readText(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return text;
  } catch {
    return '';
  }
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function safeId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(String(value || ''));
}

function readCurrentId(paths) {
  const raw = readJson(paths.currentCharacterFile, null);
  if (!raw || !safeId(raw.id)) return '';
  if (!fs.existsSync(path.join(paths.charactersDir, raw.id))) return '';
  return String(raw.id);
}

function readManifest(paths, id) {
  return readJson(path.join(paths.charactersDir, id, 'character.json'), null);
}

function fallbackPersona(paths) {
  const direct = readText(paths.fallbackPersona);
  if (direct.trim()) return { text: direct, source: paths.fallbackPersona, name: 'OneFish' };
  // Core 测试/冷启动不继承旧角色包，也不读仓库 roles/，避免和线上数据互相污染。
  return {
    text: '# OneFish\n\n你是一个有长期记忆的助手。先理解主人要什么，再给结论。',
    source: '(built-in)',
    name: 'OneFish',
  };
}

export function createPersonaService({ paths, logger = () => {} }) {
  function current() {
    const id = readCurrentId(paths);
    if (!id) return null;
    const dir = path.join(paths.charactersDir, id);
    const manifest = readManifest(paths, id) || {};
    const personaFile = path.join(dir, 'persona.md');
    return {
      id,
      name: String(manifest.name || manifest.personaMeta?.name || id),
      personaFile,
      manifest,
      dir,
    };
  }

  function get() {
    const cur = current();
    if (cur) {
      const text = readText(cur.personaFile);
      if (text.trim()) {
        return {
          id: cur.id,
          name: cur.name,
          text,
          source: cur.personaFile,
          updatedAt: (() => { try { return fs.statSync(cur.personaFile).mtimeMs; } catch { return 0; } })(),
        };
      }
    }
    const fallback = fallbackPersona(paths);
    return {
      id: '',
      name: fallback.name,
      text: fallback.text,
      source: fallback.source,
      updatedAt: 0,
    };
  }

  function list() {
    const rows = [];
    try {
      for (const name of fs.readdirSync(paths.charactersDir)) {
        const dir = path.join(paths.charactersDir, name);
        const personaFile = path.join(dir, 'persona.md');
        if (!fs.existsSync(personaFile)) continue;
        const manifest = readJson(path.join(dir, 'character.json'), {}) || {};
        rows.push({
          id: name,
          name: String(manifest.name || manifest.personaMeta?.name || name),
          updatedAt: (() => { try { return fs.statSync(personaFile).mtimeMs; } catch { return 0; } })(),
        });
      }
    } catch {}
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function update(text) {
    const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!clean) throw new Error('人格卡不能为空');
    const cur = current();
    if (cur) {
      writeTextAtomic(cur.personaFile, `${clean}\n`);
      return get();
    }
    writeTextAtomic(paths.fallbackPersona, `${clean}\n`);
    return get();
  }

  function block({ maxChars = MAX_PROMPT_CHARS } = {}) {
    const persona = get();
    const text = String(persona.text || '').trim();
    if (!text) return '';
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…（人格卡过长，已截断）` : text;
    return `【当前人格卡：${persona.name}】\n${clipped}`;
  }

  function health() {
    const cur = current();
    const persona = get();
    return {
      id: cur?.id || '',
      name: persona.name,
      source: persona.source,
      chars: String(persona.text || '').length,
      hasCharacter: Boolean(cur),
    };
  }

  return { current, get, list, update, block, health };
}
