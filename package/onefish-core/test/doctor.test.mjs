#!/usr/bin/env node
/**
 * doctor 脚本冒烟：在一套空目录里跑体检，不能崩、不能误报「异常」。
 *
 * 期望：Node/数据目录/预设 通过；配置/人格/记忆/向量/profile 是提醒（全都没配）。
 * 退出码 0（没有 fail）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onefish-core-doctor-'));

try {
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'doctor.mjs')], {
    env: {
      ...process.env,
      ONEFISH_CORE_HOME: temp,
      DSH_HOME: path.join(temp, 'dsh'),
      DSH_PROFILE: '',
    },
    encoding: 'utf8',
    timeout: 120_000,
  });

  const out = `${result.stdout || ''}${result.stderr || ''}`;
  assert.match(out, /OneFish Core 体检/, '应打印体检标题');
  assert.match(out, /Node 运行时：v/, '应报告 Node 版本');
  assert.match(out, /agent preset/, '应检查 preset 是否存在');
  assert.match(out, /通过 \d+ · 提醒 \d+ · 异常 0/, `空目录下不应有异常项：\n${out}`);
  assert.equal(result.status, 0, `退出码应为 0，实际 ${result.status}\n${out}`);

  // 再跑一次 --init，应该补出人格卡和配置文件
  const init = spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'doctor.mjs'), '--init'], {
    env: { ...process.env, ONEFISH_CORE_HOME: temp, DSH_HOME: path.join(temp, 'dsh'), DSH_PROFILE: '' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.match(`${init.stdout}`, /人格卡：已写一版空壳/);
  assert.ok(fs.existsSync(path.join(temp, 'persona.md')), '--init 应写出人格卡');
  assert.ok(fs.existsSync(path.join(temp, 'config.json')), '--init 应写出配置文件');

  console.log('✅ doctor 冒烟通过（空目录 / --init）');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
