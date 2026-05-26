/**
 * 火山引擎 Billing API 服务
 *
 * 封装 QueryBalanceAcct 接口，查询火山引擎账户余额。
 * 签名方法对齐官方 Node.js 示例（HMAC-SHA256, Volcengine Signature V4）。
 * 文档：https://www.volcengine.com/docs/6369/67269
 */

import { createHmac, createHash } from 'node:crypto';
import { getDatabase } from '../database/index.js';

const API_HOST = 'billing.volcengineapi.com';
const SERVICE = 'billing';
const REGION = 'cn-beijing';

function getDateTimeNow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function hmacKey(key, s) {
  return createHmac('sha256', key).update(s, 'utf8').digest();
}

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function uriEscape(str) {
  try {
    return encodeURIComponent(str)
      .replace(/[^A-Za-z0-9_.~\-%]+/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/\*/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return '';
  }
}

function queryParamsToString(params) {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const val = params[key];
      if (val === undefined || val === null) return undefined;
      const escapedKey = uriEscape(key);
      if (!escapedKey) return undefined;
      return `${escapedKey}=${uriEscape(String(val))}`;
    })
    .filter(Boolean)
    .join('&');
}

/**
 * 计算签名并构建 Authorization header（对齐官方 Node.js 签名示例）
 */
function sign(accessKeyId, secretAccessKey, method, query, bodySha) {
  const datetime = getDateTimeNow();
  const date = datetime.substring(0, 8); // YYYYMMDD

  // 构建待签名 headers
  const signedHeadersObj = {
    'host': API_HOST,
    'x-date': datetime,
    'x-content-sha256': bodySha || sha256Hex(''),
    'content-type': 'application/x-www-form-urlencoded',
  };
  const signedHeaderKeys = Object.keys(signedHeadersObj).sort();
  const signedHeadersStr = signedHeaderKeys.join(';');
  const canonicalHeadersStr = signedHeaderKeys
    .map((k) => `${k}:${signedHeadersObj[k]}`)
    .join('\n');

  // 1. 规范请求
  const canonicalRequest = [
    method.toUpperCase(),
    '/',
    queryParamsToString(query) || '',
    `${canonicalHeadersStr}\n`,
    signedHeadersStr,
    bodySha || sha256Hex(''),
  ].join('\n');

  // 2. 待签名字符串
  const credentialScope = `${date}/${REGION}/${SERVICE}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    datetime,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // 3. 派生签名密钥
  const kDate = hmacKey(secretAccessKey, date);
  const kRegion = hmacKey(kDate, REGION);
  const kService = hmacKey(kRegion, SERVICE);
  const kSigning = hmacKey(kService, 'request');

  // 4. 计算签名
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  // 5. Authorization
  const authorization = [
    'HMAC-SHA256',
    `Credential=${accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeadersStr},`,
    `Signature=${signature}`,
  ].join(' ');

  return { authorization, xDate: datetime };
}

/**
 * 查询火山引擎账户余额
 * @param {{ accessKeyId?: string, secretAccessKey?: string }} [credentials] - 可选，不传则使用激活的Key组
 */
export async function queryBalanceAcct(credentials) {
  let accessKeyId, secretAccessKey;
  if (credentials?.accessKeyId && credentials?.secretAccessKey) {
    accessKeyId = credentials.accessKeyId;
    secretAccessKey = credentials.secretAccessKey;
  } else {
    const db = getDatabase();
    const activeGroup = db.prepare('SELECT volc_access_key, volc_secret_key FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
    if (!activeGroup || !activeGroup.volc_access_key || !activeGroup.volc_secret_key) {
      throw new Error('无激活的火山Key组，或Key组未配置 volc_access_key / volc_secret_key');
    }
    accessKeyId = activeGroup.volc_access_key;
    secretAccessKey = activeGroup.volc_secret_key;
  }

  const method = 'GET';
  const query = { Action: 'QueryBalanceAcct', Version: '2022-01-01' };
  const bodySha = sha256Hex('');

  const { authorization, xDate } = sign(accessKeyId, secretAccessKey, method, query, bodySha);

  const qs = queryParamsToString(query);
  const url = `https://${API_HOST}/?${qs}`;

  console.log(`[volc-billing] 请求 QueryBalanceAcct host=${API_HOST} x-date=${xDate}`);

  const res = await fetch(url, {
    method,
    headers: {
      'Host': API_HOST,
      'X-Date': xDate,
      'X-Content-Sha256': bodySha,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': authorization,
    },
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) {
    const errMsg = body?.ResponseMetadata?.Error?.Message || `HTTP ${res.status}`;
    throw new Error(`火山引擎 API 返回错误：${errMsg}`);
  }
  if (body.ResponseMetadata?.Error) {
    const err = body.ResponseMetadata.Error;
    throw new Error(err.Message || err.Code || '火山引擎 API 返回错误');
  }

  const result = body.Result || {};
  return {
    accountID: Number(result.AccountID) || 0,
    availableBalance: result.AvailableBalance || '0',
    cashBalance: result.CashBalance || '0',
    arrearsBalance: result.ArrearsBalance || '0',
    creditLimit: result.CreditLimit || '0',
    freezeAmount: result.FreezeAmount || '0',
  };
}

export default { queryBalanceAcct };
