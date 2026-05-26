/**
 * 阿里云 BSS OpenAPI 服务
 *
 * 封装 QueryAccountBalance 接口，查询阿里云账户余额。
 * 文档：https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance
 */

import { createRequire } from 'node:module';
import { getDatabase } from '../database/index.js';

const require = createRequire(import.meta.url);
const BssOpenApiClient = require('@alicloud/bssopenapi20171214').default;
const { Config: OpenApiConfig } = require('@alicloud/openapi-client');

function getCredentials() {
  const db = getDatabase();
  const akRow = db.prepare("SELECT value FROM system_config WHERE key = 'bss_access_key_id'").get();
  const skRow = db.prepare("SELECT value FROM system_config WHERE key = 'bss_access_key_secret'").get();
  return {
    accessKeyId: akRow?.value || '',
    accessKeySecret: skRow?.value || '',
  };
}

function createClient() {
  const { accessKeyId, accessKeySecret } = getCredentials();
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('阿里云 AccessKey 未配置，请在管理后台设置 bss_access_key_id / bss_access_key_secret');
  }
  const config = new OpenApiConfig({
    accessKeyId,
    accessKeySecret,
  });
  config.endpoint = 'business.aliyuncs.com';
  return new BssOpenApiClient(config);
}

/**
 * 查询阿里云账户余额
 * @returns {{ availableAmount: string, availableCashAmount: string, creditAmount: string, currency: string, mybankCreditAmount: string, quotaLimit: string }}
 */
export async function queryAccountBalance() {
  const client = createClient();
  const resp = await client.queryAccountBalance();
  const body = resp?.body;
  if (!body) {
    throw new Error('BSS API 返回空响应');
  }
  if (body.code && body.code !== '200') {
    throw new Error(body.message || `BSS API 错误 (${body.code})`);
  }
  const data = body.data || {};
  return {
    availableAmount: data.availableAmount || '0',
    availableCashAmount: data.availableCashAmount || '0',
    creditAmount: data.creditAmount || '0',
    currency: data.currency || 'CNY',
    mybankCreditAmount: data.mybankCreditAmount || '0',
    quotaLimit: data.quotaLimit || '0',
  };
}

export default { queryAccountBalance };
