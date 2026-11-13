/**
 * 组件状态目录适配器：只负责创建/返回 components/<id>/。
 */
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[a-z][a-z0-9-]{1,39}$/;

export function createComponentStore({ paths }) {
  function dir(id) {
    if (!SAFE_ID.test(String(id || ''))) throw new Error(`invalid component id: ${id}`);
    return path.join(paths.componentsDir, id);
  }

  function ensure(id) {
    const target = dir(id);
    fs.mkdirSync(target, { recursive: true });
    return target;
  }

  return { dir, ensure };
}
