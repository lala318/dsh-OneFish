/**
 * B站凭据读取。
 *
 * 只读文件、只把字段拼成请求头，不打印任何凭据内容；错误信息里也不带 cookie。
 * 账号凭据属于「公开面」的鱼账号，不写进仓库、不写进 prompt、不进日志。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyCredentialsFile } from './config.js';

export function candidateCredentialFiles(config = {}, stateDir = '', home = os.homedir()) {
  const out = [];
  const explicit = String(config?.credentialsFile || '').trim();
  if (explicit) out.push(explicit);
  if (stateDir) out.push(path.join(stateDir, 'credentials.json'));
  out.push(legacyCredentialsFile(home));
  return [...new Set(out)];
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function pick(data) {
  const sessdata = String(data?.sessdata ?? data?.SESSDATA ?? '').trim();
  const biliJct = String(data?.bili_jct ?? data?.biliJct ?? '').trim();
  const buvid3 = String(data?.buvid3 ?? data?.buvid ?? '').trim();
  const mid = String(data?.mid ?? data?.uid ?? '').trim();
  const name = String(data?.name ?? data?.uname ?? '').trim();
  return { sessdata, bili_jct: biliJct, buvid3, mid, name };
}

/**
 * 载入凭据。找不到或三件套不全时返回 null（调用方 fail closed）。
 * @returns {{sessdata:string,bili_jct:string,buvid3:string,mid:string,name:string,file:string}|null}
 */
export function loadCredentials({ config = {}, stateDir = '', home = os.homedir() } = {}) {
  for (const file of candidateCredentialFiles(config, stateDir, home)) {
    const data = readJson(file);
    if (!data) continue;
    const cred = pick(data);
    if (!cred.sessdata || !cred.bili_jct || !cred.buvid3) continue;
    return { ...cred, file };
  }
  return null;
}

/** 只给诊断用：凭据文件是否存在、字段是否齐。 */
export function credentialsStatus({ config = {}, stateDir = '', home = os.homedir() } = {}) {
  const files = candidateCredentialFiles(config, stateDir, home);
  const found = [];
  for (const file of files) {
    let exists = false;
    try { exists = fs.statSync(file).isFile(); } catch {}
    found.push({ file, exists });
  }
  const cred = loadCredentials({ config, stateDir, home });
  return {
    files: found.map((x) => ({ file: x.file, exists: x.exists })),
    usable: Boolean(cred),
    source: cred?.file || '',
    self: cred ? { mid: cred.mid || '(unknown)', name: cred.name || '(unknown)' } : null,
  };
}

export function cookieHeader(cred) {
  const parts = [];
  if (cred?.sessdata) parts.push(`SESSDATA=${cred.sessdata}`);
  if (cred?.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`);
  if (cred?.buvid3) parts.push(`buvid3=${cred.buvid3}`);
  return parts.join('; ');
}
