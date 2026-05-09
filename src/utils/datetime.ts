import { useEffect, useState } from 'react';

const TZ_KEY = 'seedance_timezone';
const DEFAULT_TZ = 'Asia/Shanghai';
const TZ_CHANGE_EVENT = 'seedance:tz-change';

export interface TimezoneOption {
  value: string;   // IANA name
  label: string;   // 显示给用户的标签
}

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: 'Asia/Shanghai',     label: '北京/上海 (UTC+8)' },
  { value: 'Asia/Hong_Kong',    label: '香港 (UTC+8)' },
  { value: 'Asia/Tokyo',        label: '东京/首尔 (UTC+9)' },
  { value: 'Asia/Singapore',    label: '新加坡 (UTC+8)' },
  { value: 'Asia/Bangkok',      label: '曼谷 (UTC+7)' },
  { value: 'Asia/Dubai',        label: '迪拜 (UTC+4)' },
  { value: 'Europe/London',     label: '伦敦 (UTC+0/+1)' },
  { value: 'Europe/Paris',      label: '巴黎/柏林 (UTC+1/+2)' },
  { value: 'America/New_York',  label: '纽约 (UTC-5/-4)' },
  { value: 'America/Los_Angeles', label: '洛杉矶 (UTC-8/-7)' },
  { value: 'Australia/Sydney',  label: '悉尼 (UTC+10/+11)' },
  { value: 'UTC',               label: 'UTC (UTC+0)' },
];

export function getUserTimezone(): string {
  try {
    return localStorage.getItem(TZ_KEY) || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export function setUserTimezone(tz: string): void {
  try {
    localStorage.setItem(TZ_KEY, tz);
    window.dispatchEvent(new CustomEvent(TZ_CHANGE_EVENT, { detail: tz }));
  } catch {
    /* ignore */
  }
}

/**
 * 监听时区变化的 hook，组件会在用户切换时区时自动重新渲染。
 */
export function useUserTimezone(): string {
  const [tz, setTz] = useState<string>(() => getUserTimezone());
  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === 'string') setTz(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === TZ_KEY) setTz(e.newValue || DEFAULT_TZ);
    };
    window.addEventListener(TZ_CHANGE_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TZ_CHANGE_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return tz;
}

/**
 * 把后端给的时间值解析为 Date。
 * SQLite CURRENT_TIMESTAMP 返回 "YYYY-MM-DD HH:MM:SS"（UTC 但无时区标记），
 * 浏览器原生 new Date() 会按本地时区解析，导致显示偏差，需要显式按 UTC 处理。
 */
export function parseServerDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(input).trim();
  if (!s) return null;
  // SQLite 朴素格式 "YYYY-MM-DD HH:MM:SS[.fff]"，无时区 → 当作 UTC
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  if (naive) {
    const d = new Date(`${naive[1]}T${naive[2]}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface FormatOptions extends Intl.DateTimeFormatOptions {
  /** 自定义时区，覆盖用户设置 */
  timeZone?: string;
  /** 解析失败时返回的回退串，默认 '-' */
  fallback?: string;
}

const FULL_DEFAULT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/**
 * 格式化时间字符串到用户时区。
 * 默认输出 "YYYY-MM-DD HH:MM:SS"（zh-CN locale + 用户时区）。
 */
export function formatDateTime(
  input: string | number | Date | null | undefined,
  opts: FormatOptions = {},
): string {
  const { fallback = '-', timeZone, ...rest } = opts;
  const d = parseServerDate(input);
  if (!d) return fallback;
  const useOpts: Intl.DateTimeFormatOptions = {
    ...FULL_DEFAULT,
    ...rest,
    timeZone: timeZone || getUserTimezone(),
  };
  try {
    return new Intl.DateTimeFormat('zh-CN', useOpts).format(d);
  } catch {
    // 用户设置了非法 timezone 时退回浏览器默认
    return new Intl.DateTimeFormat('zh-CN', { ...useOpts, timeZone: undefined }).format(d);
  }
}

/** 仅日期 YYYY-MM-DD */
export function formatDate(input: string | number | Date | null | undefined, fallback = '-'): string {
  return formatDateTime(input, {
    fallback,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: undefined, minute: undefined, second: undefined,
  });
}

/** 短时间 MM-DD HH:MM */
export function formatShortDateTime(input: string | number | Date | null | undefined, fallback = '-'): string {
  return formatDateTime(input, {
    fallback,
    year: undefined,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: undefined,
  });
}

/** 当前时间到给定时间的秒差（用于"已生成 N 秒"等场景），自动按 UTC 解析 */
export function elapsedSeconds(input: string | number | Date | null | undefined): number {
  const d = parseServerDate(input);
  if (!d) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}
