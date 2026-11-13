/**
 * 人格用例：读取/编辑当前角色的人格卡。
 *
 * 文件读写由 adapters/fs/persona-store 注入；这里只做规则和回退。
 * 没有角色系统时：只读 core 自己的 core/persona.md，或使用内置中性人格；
 * 不自动读取旧 SurfCore 角色包 / 仓库 roles/，避免测试污染线上数据。
 */
const MAX_PROMPT_CHARS = 6000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function fallbackPersona(store) {
  const direct = store.readFallback();
  if (String(direct.text || '').trim()) {
    return { text: direct.text, source: direct.source, name: 'OneFish' };
  }
  return {
    text: '# OneFish\n\n你是一个有长期记忆的助手。先理解主人要什么，再给结论。',
    source: '(built-in)',
    name: 'OneFish',
  };
}

export function createPersonaService({ store, logger = () => {} } = {}) {
  if (!store) throw new Error('persona store is required');

  function current() {
    const id = store.currentId();
    if (!id || !SAFE_ID.test(id)) return null;
    const rec = store.getCharacter(id);
    if (!rec) return null;
    const manifest = rec.manifest || {};
    return {
      id,
      name: String(manifest.name || manifest.personaMeta?.name || id),
      personaFile: rec.personaFile,
      manifest,
      dir: rec.dir,
    };
  }

  function get() {
    const cur = current();
    if (cur) {
      const text = store.readPersona(cur.personaFile);
      if (String(text).trim()) {
        return {
          id: cur.id,
          name: cur.name,
          text,
          source: cur.personaFile,
          updatedAt: store.statMtime(cur.personaFile),
        };
      }
    }
    const fallback = fallbackPersona(store);
    return {
      id: '',
      name: fallback.name,
      text: fallback.text,
      source: fallback.source,
      updatedAt: 0,
    };
  }

  function list() {
    return store.listCharacters()
      .map((row) => {
        const manifest = row.manifest || {};
        return {
          id: row.id,
          name: String(manifest.name || manifest.personaMeta?.name || row.id),
          updatedAt: Number(row.updatedAt || 0),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function update(text) {
    const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!clean) throw new Error('人格卡不能为空');
    const cur = current();
    if (cur) {
      store.writePersona(cur.personaFile, `${clean}\n`);
      return get();
    }
    store.writeFallback(`${clean}\n`);
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
