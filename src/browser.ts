import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import {
  PROFILE_DIR,
  LOCALE,
  TIMEZONE,
  USER_AGENT,
  DEFAULT_TIMEOUT,
  isHeadless,
} from "./config.js";

/**
 * Менеджер персистентного контекста Chromium.
 *
 * Используется launchPersistentContext с общим каталогом профиля — благодаря
 * этому авторизация в Яндексе (cookies + localStorage) сохраняется между
 * запусками. Один раз логинимся headed-скриптом, дальше MCP-сервер работает
 * headless в том же профиле.
 */
export class BrowserManager {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;

  /** Гарантирует, что контекст запущен, и возвращает его (с дедупликацией). */
  async getContext(headlessOverride?: boolean): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;

    this.launching = this.launch(headlessOverride).finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(headlessOverride?: boolean): Promise<BrowserContext> {
    if (!fs.existsSync(PROFILE_DIR)) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }

    const headless =
      typeof headlessOverride === "boolean" ? headlessOverride : isHeadless();

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      locale: LOCALE,
      timezoneId: TIMEZONE,
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--lang=ru-RU",
      ],
    });

    context.setDefaultTimeout(DEFAULT_TIMEOUT);
    context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);

    // Небольшая маскировка автоматизации: webdriver = undefined.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    this.context = context;
    return context;
  }

  /**
   * Перезапускает контекст в нужном режиме видимости (headless/headed) на том
   * же профиле. Нужно для авто-логина: вход требует видимого окна, дальше
   * работаем headless.
   */
  async reopen(headless: boolean): Promise<BrowserContext> {
    await this.close();
    return this.getContext(headless);
  }

  /** Возвращает первую открытую страницу или создаёт новую. */
  async getPage(): Promise<Page> {
    const ctx = await this.getContext();
    const pages = ctx.pages();
    if (pages.length > 0) return pages[0];
    return ctx.newPage();
  }

  /** Закрывает контекст (например, при завершении процесса). */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}

/** Единый экземпляр на процесс. */
export const browserManager = new BrowserManager();
