import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Корень проекта (на уровень выше dist/ или src/). */
export const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Каталог с пользовательскими данными сервера — вне папки с кодом, чтобы
 * профиль/скриншоты не зависели от места установки (важно для `npx`, где код
 * лежит в кэше npm). По умолчанию `~/.yandex-eda-mcp`.
 * Переопределяется переменной YANDEX_EDA_DATA_DIR.
 */
export const DATA_DIR =
  process.env.YANDEX_EDA_DATA_DIR || path.join(os.homedir(), ".yandex-eda-mcp");

/**
 * Каталог с персистентным профилем Chromium. Здесь хранятся cookies и
 * localStorage Яндекса, поэтому авторизация переживает перезапуски.
 * Приоритет: YANDEX_EDA_PROFILE / YANDEX_EDA_PROFILE_DIR → `~/.yandex-eda-mcp/profile`.
 * Ради обратной совместимости, если нового каталога ещё нет, а старый
 * `<проект>/.profile` существует (прежняя схема), используем его.
 */
function resolveProfileDir(): string {
  const explicit =
    process.env.YANDEX_EDA_PROFILE || process.env.YANDEX_EDA_PROFILE_DIR;
  if (explicit) return explicit;
  const home = path.join(DATA_DIR, "profile");
  const legacy = path.join(PROJECT_ROOT, ".profile");
  if (!fs.existsSync(home) && fs.existsSync(legacy)) return legacy;
  return home;
}

export const PROFILE_DIR = resolveProfileDir();

/** Куда складывать скриншоты для диагностики. */
export const SCREENSHOT_DIR =
  process.env.YANDEX_EDA_SCREENSHOT_DIR || path.join(DATA_DIR, "screenshots");

/** Базовый URL Яндекс Еды. */
export const BASE_URL = process.env.YANDEX_EDA_BASE_URL || "https://eda.yandex.ru";

/** URL страницы паспорта для авторизации. */
export const PASSPORT_URL = "https://passport.yandex.ru/auth";

/**
 * Headless по умолчанию включён. Для интерактивного логина скрипт login
 * принудительно запускает браузер в headed-режиме.
 * Управляется переменной YANDEX_EDA_HEADLESS ("0"/"false" = headed).
 */
export function isHeadless(): boolean {
  const v = (process.env.YANDEX_EDA_HEADLESS || "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

/**
 * Автоматически открывать окно входа, если сервер видит, что профиль не
 * авторизован. Включено по умолчанию — чтобы «склонировал и пользуешься».
 * Отключается через YANDEX_EDA_AUTO_LOGIN=0 (например, для CI/headless-серверов).
 */
export function isAutoLogin(): boolean {
  const v = (process.env.YANDEX_EDA_AUTO_LOGIN || "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

/** Сколько ждать, пока пользователь завершит вход в открывшемся окне, мс. */
export const LOGIN_TIMEOUT = Number(process.env.YANDEX_EDA_LOGIN_TIMEOUT || 180000);

/** Локаль/таймзона под РФ, чтобы сайт не подсовывал чужой регион. */
export const LOCALE = "ru-RU";
export const TIMEZONE = "Europe/Moscow";

/** Таймаут навигации/ожиданий по умолчанию, мс. */
export const DEFAULT_TIMEOUT = Number(process.env.YANDEX_EDA_TIMEOUT || 30000);

/** User-Agent обычного десктопного Chrome, чтобы меньше палиться в headless. */
export const USER_AGENT =
  process.env.YANDEX_EDA_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
