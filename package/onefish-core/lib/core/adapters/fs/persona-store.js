/**
 * Persona 文件存储适配器。
 *
 * 只负责路径/文件；人格规则在 application/persona。
 */
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

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

function statMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

export function createPersonaStore({ paths }) {
  const charactersDir = paths.charactersDir;

  function currentId() {
    const raw = readJson(paths.currentCharacterFile, null);
    return raw && SAFE_ID.test(String(raw.id || '')) ? String(raw.id) : '';
  }

  function getCharacter(id) {
    if (!SAFE_ID.test(String(id || ''))) return null;
    const dir = path.join(charactersDir, id);
    const personaFile = path.join(dir, 'persona.md');
    if (!fs.existsSync(dir)) return null;
    return {
      id,
      dir,
      personaFile,
      manifest: readJson(path.join(dir, 'character.json'), null),
    };
  }

  function readPersona(file) {
    return readText(file);
  }

  function readFallback() {
    return { text: readText(paths.fallbackPersona), source: paths.fallbackPersona };
  }

  function writePersona(file, text) {
    writeTextAtomic(file, text);
  }

  function writeFallback(text) {
    writeTextAtomic(paths.fallbackPersona, text);
  }

  function listCharacters() {
    const rows = [];
    try {
      for (const name of fs.readdirSync(charactersDir)) {
        if (!SAFE_ID.test(name)) continue;
        const dir = path.join(charactersDir, name);
        const personaFile = path.join(dir, 'persona.md');
        if (!fs.existsSync(personaFile)) continue;
        rows.push({
          id: name,
          dir,
          personaFile,
          manifest: readJson(path.join(dir, 'character.json'), {}),
          updatedAt: statMtime(personaFile),
        });
      }
    } catch {}
    return rows;
  }

  return {
    currentId,
    getCharacter,
    readPersona,
    readFallback,
    writePersona,
    writeFallback,
    listCharacters,
    statMtime,
  };
}
