import type { Page, Response, BrowserContext } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { browserManager } from "./browser.js";
import {
  BASE_URL,
  PASSPORT_URL,
  SCREENSHOT_DIR,
  DEFAULT_TIMEOUT,
  LOGIN_TIMEOUT,
  isAutoLogin,
} from "./config.js";

/**
 * Обёртка над страницей Яндекс Еды.
 *
 * Стратегия чтения данных: слушаем сетевые ответы сайта и парсим внутренний
 * JSON-API (устойчиво к смене CSS-классов). Действия (адрес, корзина, заказ)
 * выполняем через DOM, потому что они требуют кликов.
 *
 * ВАЖНО: конкретные URL внутреннего API и селекторы могут меняться Яндексом.
 * Все «магические» места вынесены в константы ниже — при поломке правьте их,
 * а инструмент `debug_snapshot` в MCP поможет увидеть актуальную структуру.
 */

// --- Подстраиваемые константы под текущую версию сайта ---------------------
// Проверено на вёрстке eda.yandex.ru (десктоп-редизайн, 2026). При поломке
// используйте `debug_snapshot` и скрипты в docs, чтобы обновить селекторы/пути.
const SELECTORS = {
  // Признак авторизации — аватар/меню аккаунта в шапке.
  loggedInMarker: [
    '[data-testid="user-menu"]',
    'header [class*="userpic" i]',
    'header img[alt*="ватар" i]',
    'header a[href*="passport.yandex"]',
  ],
  // Кнопка/ссылка "Войти".
  loginButton: [
    'button:has-text("Войти")',
    '[data-testid="login-button"]',
    'a[href*="passport.yandex.ru/auth"]',
  ],
  // Кнопка в шапке, открывающая окно адреса, когда адрес НЕ задан.
  addressTrigger: ['button:has-text("Укажите адрес")'],
  // Поле ввода адреса в модалке «Куда доставить заказ?».
  addressInput: [
    '[data-testid="address-input"]',
    'input[placeholder*="улиц" i]',
    'input[placeholder*="адрес" i]',
  ],
  // Подсказка адреса (строки react-autosuggest в модалке).
  addressSuggestion: [
    'li[role="option"]',
    '.react-autosuggest__suggestion',
    '[data-testid*="suggest-item"]',
  ],
  // Кнопка подтверждения адреса на экране с картой (активна после выбора).
  addressConfirm: ['button:has-text("Ок"):not([disabled])'],
  // Карточка заведения в каталоге/поиске.
  placeCard: [
    '[data-testid="snippet-header"]',
    'a[href*="/restaurant/"]',
    'a[href*="/r/"]',
  ],
  // Кнопка добавления товара в корзину на странице меню.
  addItemButton: [
    '[data-testid="add-to-cart"]',
    'button[aria-label*="Добавить" i]',
    'button:has-text("Добавить")',
  ],
  // Кнопка перехода в корзину / оформления.
  goToCart: [
    '[data-testid="cart-button"]',
    'button:has-text("Корзина")',
    'a[href*="/cart"]',
  ],
  // Финальная кнопка подтверждения заказа.
  placeOrderButton: [
    '[data-testid="checkout-submit"]',
    'button:has-text("Оформить заказ")',
    'button:has-text("Заказать")',
  ],
};

// Паттерны внутреннего API для перехвата ответов (актуальные эндпоинты 2026).
const API = {
  // Каталог главной строится «layout-constructor», заведения — в его каруселях.
  catalog: /layout-constructor\/v\d+\/layout/,
  // Полнотекстовый поиск по ресторанам/блюдам.
  search: /full-text-search\/v\d+\/search/,
  // Меню конкретного ресторана.
  menu: /\/api\/v\d+\/menu\/retrieve/,
  // Корзина.
  cart: /(cart\/v\d+|multi-carts|eats-cart)/,
  // Оформление заказа.
  order: /(order\/create|orders|checkout)/,
};

/**
 * Многие текстовые поля нового API — это объекты вида `{ value, color }` или
 * `{ text: { value } }`, а не строки. Достаём человекочитаемую строку.
 */
function textVal(x: any): string | undefined {
  if (x == null) return undefined;
  if (typeof x === "string") return x;
  if (typeof x === "object")
    return x.value ?? x.text?.value ?? x.title ?? x.text ?? undefined;
  return undefined;
}

/**
 * Открыто ли заведение по тексту времени доставки. У открытых это ETA с «мин»
 * («10 – 20 мин»); у закрытых — «Закрыто» или расписание предзаказа
 * («Сегодня 13:00»). undefined — если текст не распознан.
 */
function isOpenByEta(deliveryTime?: string): boolean | undefined {
  if (!deliveryTime) return undefined;
  if (/мин/i.test(deliveryTime)) return true;
  return false;
}

/**
 * Оценивает, насколько сохранённый адрес подходит под запрос пользователя
 * (больше — лучше, 0 — не подходит). Понимает метки (дом/работа) и совпадение
 * по названию улицы и номеру дома.
 */
function scoreSavedAddress(query: string, item: SavedAddress): number {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
  const q = norm(query);
  const label = norm(item.label || "");
  const addr = norm(item.address || "");
  if (/\b(дом|домой|home)\b/.test(q) && /дом/.test(label)) return 4;
  if (/(работ|офис|office|work)/.test(q) && /(работ|офис)/.test(label)) return 4;
  if (label && q.includes(label)) return 4;
  const stop =
    /^(улиц|улица|город|дом|д|кв|проспект|переулок|переул|шоссе|бульвар|москва|россия|подъезд|этаж)$/;
  const tokens = (q.match(/[а-яa-z0-9]+/g) || []).filter(
    (t) => t.length >= 3 && !stop.test(t)
  );
  if (!tokens.length) return 0;
  const hits = tokens.filter((t) => addr.includes(t)).length;
  if (hits >= 2) return 3;
  if (hits === 1 && tokens.length === 1) return 2;
  return 0;
}
// ---------------------------------------------------------------------------

export interface Restaurant {
  name: string;
  slug?: string;
  url?: string;
  /** Тип заведения: "restaurant" (готовая еда) или "shop" (магазин/аптека/цветы). */
  business?: string;
  rating?: number | string;
  deliveryTime?: string;
  /** Стоимость доставки, если удалось распознать (например «Доставка 0₽»). */
  deliveryPrice?: string;
  /**
   * Открыт ли сейчас (доставляет прямо сейчас). false — закрыт/только предзаказ
   * (время доставки «Закрыто» или расписание вида «Сегодня 13:00»).
   * undefined — определить не удалось.
   */
  open?: boolean;
  categories?: string[];
  minOrder?: string;
  raw?: unknown;
}

/** Тип заведений для выдачи. */
export type PlaceType = "restaurant" | "shop" | "all";

export interface MenuItem {
  name: string;
  price?: number | string;
  description?: string;
  weight?: string;
  id?: string | number;
  /** Категория меню, к которой относится позиция. */
  category?: string;
  /** Требует выбора обязательных опций (вкус/размер/добавки) при добавлении. */
  hasOptions?: boolean;
  raw?: unknown;
}

/** Сохранённый адрес доставки из аккаунта (метка + строка адреса). */
export interface SavedAddress {
  /** «Дом», «На работу» и т.п., если у адреса задана метка. */
  label?: string;
  /** Строка адреса, напр. «улица Циолковского, д. 27, кв. 109». */
  address: string;
}

/** Пытается вытащить первый локатор из списка кандидатов, который присутствует. */
async function firstVisible(page: Page, selectors: string[], timeout = 4000) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "visible", timeout });
      return loc;
    } catch {
      /* пробуем следующий */
    }
  }
  return null;
}

/**
 * Выполняет действие `action` и параллельно собирает JSON-ответы, чьи URL
 * матчат `pattern`. Возвращает массив распарсенных тел.
 */
async function collectJson(
  page: Page,
  pattern: RegExp,
  action: () => Promise<void>,
  settleMs = 1500
): Promise<unknown[]> {
  const bodies: unknown[] = [];
  const handler = async (res: Response) => {
    if (!pattern.test(res.url())) return;
    try {
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("application/json")) bodies.push(await res.json());
    } catch {
      /* тело недоступно/не JSON — игнорируем */
    }
  };
  page.on("response", handler);
  try {
    await action();
    // Даём догрузиться отложенным запросам.
    await page.waitForTimeout(settleMs);
  } finally {
    page.off("response", handler);
  }
  return bodies;
}

export class YandexEda {
  /**
   * Вход подтверждён в этом процессе. Как только сессия найдена/выполнен вход —
   * больше не дёргаем проверку и не открываем окно на каждое действие (это
   * защита от любой флакости детекта куки). Сбрасывается только явным `login`.
   */
  private authConfirmed = false;

  private async page(): Promise<Page> {
    return browserManager.getPage();
  }

  private async ensureOnSite(page: Page): Promise<void> {
    if (!page.url().startsWith(BASE_URL)) {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    }
  }

  /**
   * Авторитетная проверка авторизации — по куке сессии Яндекса `Session_id`.
   * Надёжнее DOM-селекторов: не зависит от вёрстки и от анти-бот-заглушек,
   * которые Яндекс показывает свежему гостю в headless (из-за них старый
   * детект по кнопке «Войти» ошибочно считал гостя залогиненным).
   */
  async isAuthenticated(): Promise<boolean> {
    const ctx = await browserManager.getContext();
    return this.hasSessionCookie(ctx);
  }

  /** Проверяет, авторизован ли пользователь (по куке сессии). */
  async isLoggedIn(): Promise<{ loggedIn: boolean; details: string }> {
    const authed = await this.isAuthenticated();
    return authed
      ? { loggedIn: true, details: "Активная сессия Яндекса (кука Session_id)." }
      : {
          loggedIn: false,
          details: "Куки сессии нет — требуется вход. Вызовите инструмент `login`.",
        };
  }

  /**
   * Жёсткий признак «точно не авторизован»: на странице видна кнопка «Войти» и
   * нет маркера аккаунта. Используется для авто-логина, чтобы не открывать окно
   * входа при неоднозначной вёрстке.
   */
  private async needsLogin(page: Page): Promise<boolean> {
    await this.ensureOnSite(page);
    const marker = await firstVisible(page, SELECTORS.loggedInMarker, 2500);
    if (marker) return false;
    const loginBtn = await firstVisible(page, SELECTORS.loginButton, 1500);
    return !!loginBtn;
  }

  /**
   * Есть ли в контексте валидная кука сессии Яндекса. Passport после входа
   * ставит `Session_id` на `.yandex.ru`. Проверка НЕразрушающая — только читает
   * куки, не трогая открытую пользователем страницу входа.
   */
  private async hasSessionCookie(ctx: BrowserContext): Promise<boolean> {
    const cookies = await ctx.cookies().catch(() => []);
    return cookies.some((c) => c.name === "Session_id" && !!c.value);
  }

  /**
   * Закрывает headed-контекст и уходит в headless, ПЕРЕНОСЯ куки напрямую —
   * чтобы не зависеть от того, успела ли сессия дописаться в профиль на диск
   * (иначе новый headless-контекст мог бы не увидеть свежий Session_id, и сервер
   * снова открывал бы окно входа на каждое действие).
   */
  private async goHeadlessWithSession(fromCtx: BrowserContext): Promise<void> {
    const cookies = await fromCtx.cookies().catch(() => []);
    const headless = await browserManager.reopen(true);
    if (cookies.length) await headless.addCookies(cookies).catch(() => {});
    this.authConfirmed = true; // сессия найдена — фиксируем, окно больше не нужно
  }

  /**
   * Интерактивный вход: поднимает видимое окно браузера в том же профиле,
   * ведёт на страницу входа Яндекса и ждёт, пока пользователь авторизуется
   * (логин/пароль/SMS/капча). Готовность ловим по появлению куки `Session_id`,
   * не трогая страницу входа. После входа возвращаемся в headless, перенося куки.
   */
  async interactiveLogin(
    timeoutMs = LOGIN_TIMEOUT
  ): Promise<{ ok: boolean; message: string }> {
    // Проверяем БЕЗ открытия окна — вдруг уже авторизованы.
    if (await this.isAuthenticated()) {
      this.authConfirmed = true;
      return { ok: true, message: "Уже авторизованы — вход не потребовался." };
    }

    // Видимое окно обязательно — капча/SMS в headless невозможны.
    const ctx = await browserManager.reopen(false);
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // Сессия могла появиться в профиле между проверками.
    if (await this.hasSessionCookie(ctx)) {
      await this.goHeadlessWithSession(ctx);
      return { ok: true, message: "Уже авторизованы — вход не потребовался." };
    }

    // Ведём на страницу входа и БОЛЬШЕ НЕ трогаем её — пользователь спокойно
    // вводит логин/пароль/SMS/капчу. Готовность ловим по куке сессии, а не
    // перезагрузкой страницы (иначе вход невозможно завершить).
    await page
      .goto(PASSPORT_URL, { waitUntil: "domcontentloaded" })
      .catch(() => {});

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if (await this.hasSessionCookie(ctx)) {
        await page.waitForTimeout(1500); // дать докатиться остальным кукам
        await this.goHeadlessWithSession(ctx);
        return {
          ok: true,
          message:
            "Вход выполнен, сессия сохранена. Дальше работаю headless — окно больше не откроется.",
        };
      }
    }

    await browserManager.reopen(true);
    return {
      ok: false,
      message:
        "Не дождался входа за отведённое время. Вызовите инструмент `login` ещё раз и завершите вход в открывшемся окне.",
    };
  }

  /**
   * Гарантирует, что перед действием на сайте профиль авторизован. Проверка по
   * куке `Session_id` (авторитетно). Если сессии нет и авто-логин включён —
   * открывает окно входа. Иначе бросает понятную ошибку.
   */
  async ensureLoggedIn(): Promise<void> {
    if (this.authConfirmed) return; // уже входили в этом процессе — не дёргаем окно
    if (await this.isAuthenticated()) {
      this.authConfirmed = true;
      return;
    }
    if (!isAutoLogin()) {
      throw new Error(
        "Профиль не авторизован. Вызовите инструмент `login` (или задайте YANDEX_EDA_AUTO_LOGIN=1)."
      );
    }
    const res = await this.interactiveLogin();
    if (!res.ok) throw new Error(res.message);
  }

  /** Задан ли адрес доставки (в шапке нет кнопки «Укажите адрес»). */
  private async hasAddress(page: Page): Promise<boolean> {
    return (await page.locator(SELECTORS.addressTrigger.join(", ")).count()) === 0;
  }

  /**
   * Кнопка адресного контрола в шапке. Показывает либо «Укажите адрес», либо
   * метку сохранённого адреса («Дом», «На работу»), либо саму улицу. Кнопку
   * «Сейчас» (время доставки) и вкладки исключаем.
   */
  private addressControl(page: Page) {
    return page
      .locator("header button")
      .filter({
        hasText:
          /Укажите адрес|Дом|работ|дача|офис|,|улиц|проспект|переул|шоссе|бульвар|Москв/i,
      })
      .filter({ hasNotText: /Сейчас|Заказать|Сходить/ })
      .first();
  }

  /** Текущий адрес доставки (как показано в шапке: метка или улица). */
  async getCurrentAddress(): Promise<string | null> {
    const page = await this.page();
    await this.ensureOnSite(page);
    if (!(await this.hasAddress(page))) return null;
    const ctrl = this.addressControl(page);
    const txt = ((await ctrl.textContent().catch(() => "")) || "").trim();
    return txt || null;
  }

  /** Открывает попап со списком сохранённых адресов (нужен активный адрес). */
  private async openSavedPopup(page: Page): Promise<boolean> {
    if (
      await page
        .locator('button:has-text("Куда доставить?")')
        .isVisible()
        .catch(() => false)
    )
      return true;
    const ctrl = this.addressControl(page);
    // Ждём готовности шапки (при первом обращении она рендерится не сразу).
    if (
      !(await ctrl
        .waitFor({ state: "visible", timeout: 8000 })
        .then(() => true, () => false))
    )
      return false;
    const label = ((await ctrl.textContent().catch(() => "")) || "").trim();
    if (/Укажите адрес/i.test(label)) return false; // адреса нет — нет и списка
    for (let i = 0; i < 3; i++) {
      await ctrl.click({ timeout: 4000 }).catch(() => {});
      const ok = await page
        .locator('button:has-text("Куда доставить?")')
        .first()
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => true, () => false);
      if (ok) {
        await page.waitForTimeout(700); // дать отрисоваться списку
        return true;
      }
    }
    return false;
  }

  /** Читает сохранённые адреса, повторяя, если список ещё не отрисовался. */
  private async readSavedItemsStable(page: Page): Promise<SavedAddress[]> {
    let items = await this.readSavedItems(page);
    if (!items.length) {
      await page.waitForTimeout(900);
      items = await this.readSavedItems(page);
    }
    return items;
  }

  /** Читает элементы попапа сохранённых адресов (метка + строка адреса). */
  private async readSavedItems(page: Page): Promise<SavedAddress[]> {
    return page.evaluate(() => {
      const pop = document.querySelector(
        '[class*="popup" i],[class*="Popup" i],[role="dialog"]'
      );
      if (!pop) return [] as any[];
      const out: any[] = [];
      const seen = new Set<string>();
      for (const b of pop.querySelectorAll('button,[role="option"],li')) {
        const full = (b.textContent || "").trim();
        if (!full || /Куда доставить/i.test(full)) continue;
        const lines = [
          ...new Set(
            [...b.querySelectorAll("span,div,p")]
              .map((x) => (x.textContent || "").trim())
              .filter(Boolean)
          ),
        ];
        const meaningful = lines.filter((l) => l !== full);
        let label: string | undefined;
        let address = full;
        const si = meaningful.findIndex((l) =>
          /улиц|проспект|переул|шоссе|бульвар|д\.\s?\d/i.test(l)
        );
        if (si >= 0) {
          address = meaningful[si];
          const before = meaningful
            .slice(0, si)
            .find((l) => l.length < 25 && !/улиц|д\./i.test(l));
          if (before) label = before;
          const det = meaningful
            .slice(si + 1)
            .find((l) => /подъезд|этаж|кв\./i.test(l));
          if (det && !address.includes(det)) address = address + ", " + det;
        }
        const key = (label || "") + "|" + address;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label: label || undefined, address });
      }
      return out;
    });
  }

  /** Возвращает сохранённые в аккаунте адреса доставки. */
  async getSavedAddresses(): Promise<SavedAddress[]> {
    await this.ensureLoggedIn();
    const page = await this.page();
    await this.ensureOnSite(page);
    if (!(await this.openSavedPopup(page))) return [];
    const items = await this.readSavedItemsStable(page);
    await page.keyboard.press("Escape").catch(() => {});
    return items;
  }

  /**
   * Пытается выбрать существующий сохранённый адрес под запрос. Клик по
   * сохранённому применяет его мгновенно, СОХРАНЯЯ квартиру/подъезд/этаж —
   * без экрана карты и повторного ввода.
   */
  async selectSavedAddress(
    query: string
  ): Promise<{ ok: boolean; message: string; matched?: SavedAddress }> {
    const page = await this.page();
    await this.ensureOnSite(page);
    if (!(await this.openSavedPopup(page))) {
      return {
        ok: false,
        message: "Список сохранённых адресов недоступен (нет активного адреса?).",
      };
    }
    const items = await this.readSavedItemsStable(page);
    const scored = items
      .map((it) => ({ it, s: scoreSavedAddress(query, it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (!scored.length) {
      await page.keyboard.press("Escape").catch(() => {});
      return {
        ok: false,
        message: `Среди сохранённых адресов нет подходящего под «${query}».`,
      };
    }
    const best = scored[0].it;
    const needle = best.label || best.address.split(",")[0];
    await page
      .locator(
        '[class*="popup" i] button, [class*="Popup" i] button, [role="dialog"] button'
      )
      .filter({ hasText: needle })
      .first()
      .click({ timeout: 4000 })
      .catch(() => {});
    await page
      .locator('button:has-text("Куда доставить?")')
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const shown = best.label ? `${best.label} — ${best.address}` : best.address;
    return {
      ok: true,
      message: `Выбран сохранённый адрес: ${shown}`,
      matched: best,
    };
  }

  /** Открывает модалку «Куда доставить заказ?» с полем ввода нового адреса. */
  private async openAddressModal(page: Page): Promise<boolean> {
    const input = page.locator(SELECTORS.addressInput[0]).first();
    const visible = () => input.isVisible().catch(() => false);
    const wait = () =>
      input.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    if (await visible()) return true;

    // Если открыт попап сохранённых — его заголовок ведёт к поиску нового.
    const toSearch = page.locator('button:has-text("Куда доставить?")').first();
    if (await toSearch.isVisible().catch(() => false)) {
      await toSearch.click().catch(() => {});
      if (await wait()) return true;
    }

    // Состояние «адрес не задан»: кнопка «Укажите адрес» открывает поиск сразу.
    const trigger = page.locator(SELECTORS.addressTrigger.join(", ")).first();
    if (await trigger.count()) {
      await trigger.click().catch(() => {});
      if (await wait()) return true;
    }

    // Состояние «адрес задан»: клик по адресу открывает попап сохранённых,
    // а его заголовок «Куда доставить?» ведёт к поиску нового адреса.
    const ctrl = this.addressControl(page);
    if (await ctrl.count()) {
      await ctrl.click().catch(() => {});
      await page.waitForTimeout(1200);
      if (await visible()) return true;
      if (await toSearch.count()) await toSearch.click().catch(() => {});
      if (await wait()) return true;
    }
    return false;
  }

  /**
   * Устанавливает адрес доставки.
   *
   * Сначала (если preferSaved != false) пробует существующий сохранённый адрес
   * — клик по нему применяется мгновенно и сохраняет квартиру/подъезд. Если
   * подходящего сохранённого нет — вводит новый через поиск: модалка →
   * подсказка (↓ + Enter) → экран с картой → кнопка «Ок».
   */
  async setAddress(
    query: string,
    opts: { preferSaved?: boolean } = {}
  ): Promise<{ ok: boolean; message: string; usedSaved?: boolean }> {
    await this.ensureLoggedIn();
    const page = await this.page();
    await this.ensureOnSite(page);

    if (opts.preferSaved !== false) {
      const saved = await this.selectSavedAddress(query).catch(() => null);
      if (saved?.ok) return { ok: true, message: saved.message, usedSaved: true };
    }

    if (!(await this.openAddressModal(page))) {
      return {
        ok: false,
        message:
          "Не удалось открыть окно ввода адреса. Возможно, изменилась вёрстка — проверьте debug_snapshot.",
      };
    }

    const input = page.locator(SELECTORS.addressInput[0]).first();
    await input.click().catch(() => {});
    await input.fill("");
    await input.type(query, { delay: 60 });

    // Ждём выпадающие подсказки.
    const suggestion = page.locator(SELECTORS.addressSuggestion.join(", ")).first();
    try {
      await suggestion.waitFor({ state: "visible", timeout: 8000 });
    } catch {
      return {
        ok: false,
        message: `Подсказки по адресу «${query}» не появились. Уточните запрос (город, улица, дом).`,
      };
    }
    await page.waitForTimeout(1200); // дать догрузиться всем вариантам

    // Выбираем первую подсказку клавиатурой — надёжнее клика по строке.
    await input.press("ArrowDown").catch(() => {});
    await input.press("Enter").catch(() => {});
    const chosen = ((await input.inputValue().catch(() => query)) || query).trim();

    // Экран с картой: подтверждаем кнопкой «Ок» (активируется после выбора).
    const ok = page.locator(SELECTORS.addressConfirm.join(", ")).first();
    try {
      await ok.waitFor({ state: "visible", timeout: 8000 });
      await ok.click();
    } catch {
      // На части адресов подтверждение не требуется — продолжаем.
    }
    await page.waitForTimeout(2500);

    if (!(await this.hasAddress(page))) {
      return {
        ok: false,
        message: `Адрес «${chosen}» выбран, но не применился. Повторите или уточните запрос.`,
      };
    }
    return { ok: true, message: `Адрес установлен: ${chosen}` };
  }

  /**
   * Ищет заведения.
   *
   * - `query` пустой → отдаёт весь каталог для текущего адреса (для запроса
   *   «кто вообще доставляет» ключевые слова НЕ нужны — тут и так все).
   * - `query` задан → полнотекстовый поиск по названию/кухне/блюду.
   * - `type` фильтрует выдачу: "restaurant" (по умолч., готовая еда),
   *   "shop" (магазины/аптеки/цветы) или "all".
   * - По умолчанию закрытые (только предзаказ) отсеиваются; `includeClosed`
   *   их вернёт. Требуется заданный адрес.
   */
  async searchRestaurants(
    query?: string,
    type: PlaceType = "restaurant",
    includeClosed = false
  ): Promise<Restaurant[]> {
    await this.ensureLoggedIn();
    const page = await this.page();
    const q = query?.trim();

    let parsed: Restaurant[] = [];
    if (q) {
      const bodies = await collectJson(
        page,
        API.search,
        async () => {
          await page.goto(`${BASE_URL}/search?query=${encodeURIComponent(q)}`, {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(3500);
        },
        2500
      );
      parsed = this.parseSearchPlaces(bodies);
    } else {
      const bodies = await collectJson(
        page,
        API.catalog,
        async () => {
          await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(3500);
        },
        2500
      );
      parsed = this.parseCatalogPlaces(bodies);
    }

    if (!parsed.length) {
      // API ничего не отдал — последняя попытка из DOM (тип/статус неизвестны).
      return this.parseRestaurantsFromDom(page);
    }
    let result = this.filterByType(parsed, type);
    // Прячем закрытые/предзаказ (open === false), open===undefined оставляем.
    if (!includeClosed) result = result.filter((p) => p.open !== false);
    return result;
  }

  /** Оставляет заведения нужного типа по полю `business`. */
  private filterByType(places: Restaurant[], type: PlaceType): Restaurant[] {
    if (type === "all") return places;
    if (type === "shop")
      return places.filter((p) => p.business && p.business !== "restaurant");
    // По умолчанию — рестораны (готовая еда). Неизвестный business оставляем.
    return places.filter((p) => !p.business || p.business === "restaurant");
  }

  /** Заведения из каталога «layout-constructor» (карусели `data.*`). */
  private parseCatalogPlaces(bodies: unknown[]): Restaurant[] {
    const out: Restaurant[] = [];
    const seen = new Set<string>();
    for (const body of bodies as any[]) {
      const data = body?.data;
      if (!data || typeof data !== "object") continue;
      for (const key of Object.keys(data)) {
        if (!/carousel|places/i.test(key)) continue;
        const blocks = Array.isArray(data[key]) ? data[key] : [data[key]];
        for (const block of blocks) {
          const places = block?.payload?.places;
          if (!Array.isArray(places)) continue;
          for (const p of places) {
            const name = textVal(p?.name);
            const slug = p?.slug;
            if (!name || !slug || seen.has(slug)) continue;
            seen.add(slug);
            const eta = Array.isArray(p.left_meta)
              ? p.left_meta.find((m: any) => m?.payload?.semantic_type === "eta")
              : null;
            // Цена доставки иногда есть чипом («Доставка 0₽», «Бесплатная доставка»).
            const deliveryPrice = Array.isArray(p.chips)
              ? p.chips
                  .map((c: any) => textVal(c?.payload?.text))
                  .find((t: any) => t && /доставк|₽/i.test(t))
              : undefined;
            const deliveryTime = textVal(eta?.payload?.text);
            out.push({
              name,
              slug,
              business: p.brand?.business,
              url: `${BASE_URL}/restaurant/${slug}`,
              rating: textVal(p.features?.rating?.text),
              deliveryTime,
              deliveryPrice,
              open: isOpenByEta(deliveryTime),
            });
          }
        }
      }
    }
    return out;
  }

  /** Заведения из полнотекстового поиска (`blocks[type=places].payload[]`). */
  private parseSearchPlaces(bodies: unknown[]): Restaurant[] {
    const out: Restaurant[] = [];
    const seen = new Set<string>();
    for (const body of bodies as any[]) {
      const blocks = body?.blocks;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== "places") continue;
        const arr = Array.isArray(block.payload)
          ? block.payload
          : Object.values(block.payload || {});
        for (const p of arr as any[]) {
          const name = textVal(p?.title ?? p?.name);
          const slug = p?.slug;
          if (!name || !slug || seen.has(slug)) continue;
          seen.add(slug);
          // rating/время лежат сегментами в lower_meta: ["4.2 (161)", "·", "25 мин"].
          const lm: string[] = Array.isArray(p.lower_meta)
            ? p.lower_meta
                .map((m: any) => textVal(m?.payload?.text))
                .filter((t: any): t is string => !!t && t !== "·")
            : [];
          const rating = lm.find((t: string) => /^\d[.,]\d/.test(t));
          const deliveryTime =
            textVal(p.delivery?.text) ??
            lm.find((t: string) => /мин|\bч\b|\d{1,2}:\d{2}/i.test(t));
          const web = p.link?.web ? String(p.link.web).split("?")[0] : undefined;
          // Наличие available_from = предзаказ (ещё закрыт); иначе смотрим на ETA.
          const open = p.available_from ? false : isOpenByEta(deliveryTime);
          out.push({
            name,
            slug,
            business: p.business,
            url: web ? `${BASE_URL}${web}` : `${BASE_URL}/restaurant/${slug}`,
            rating,
            deliveryTime,
            open,
            categories: Array.isArray(p.tags)
              ? p.tags.map((t: any) => t.title || t).filter(Boolean)
              : undefined,
            minOrder: textVal(p.price_category),
          });
        }
      }
    }
    return out;
  }

  private async parseRestaurantsFromDom(page: Page): Promise<Restaurant[]> {
    const cards = page.locator(SELECTORS.placeCard.join(", "));
    const count = Math.min(await cards.count(), 40);
    const out: Restaurant[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const href = await card.getAttribute("href").catch(() => null);
      // Имя: заголовок сниппета, иначе первая строка текста карточки.
      let name = await card
        .locator('[data-testid="place-snippet-title"]')
        .first()
        .innerText()
        .catch(() => "");
      if (!name) {
        name =
          (await card.innerText().catch(() => "")).split("\n")[0]?.trim() || "";
      }
      name = name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        url: href ? new URL(href, BASE_URL).toString() : undefined,
      });
    }
    return out;
  }

  /** Открывает ресторан и возвращает его меню. */
  async getMenu(restaurantUrlOrSlug: string): Promise<{
    restaurant: string;
    items: MenuItem[];
  }> {
    await this.ensureLoggedIn();
    const page = await this.page();
    const url = restaurantUrlOrSlug.startsWith("http")
      ? restaurantUrlOrSlug
      : `${BASE_URL}/restaurant/${restaurantUrlOrSlug}`;

    const bodies = await collectJson(page, API.menu, async () => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    });

    const restaurant =
      (await page.locator("h1").first().innerText().catch(() => "")) ||
      restaurantUrlOrSlug;

    const items = this.parseMenuFromApi(bodies);
    return { restaurant: restaurant.trim(), items };
  }

  private parseMenuFromApi(bodies: unknown[]): MenuItem[] {
    const out: MenuItem[] = [];
    const seen = new Set<string>();
    const push = (it: any, category?: string) => {
      const price = it?.price ?? it?.decimalPrice ?? it?.decimal_price ?? it?.cost;
      const name = textVal(it?.name ?? it?.title);
      if (!name || price == null) return;
      const key = String(it.id ?? it.publicId ?? name);
      if (seen.has(key)) return;
      seen.add(key);
      const groups =
        it.optionsGroups ?? it.optionGroups ?? it.option_groups ?? it.options;
      out.push({
        name,
        price,
        description: textVal(it.description ?? it.shortDescription),
        weight: it.weight ?? it.measure,
        id: it.id ?? it.publicId,
        category,
        hasOptions:
          (Array.isArray(groups) && groups.length > 0) ||
          it.has_required_option_groups === true ||
          undefined,
        raw: it,
      });
    };

    // Основной путь: payload.categories[].items[] (+ вложенные подкатегории).
    for (const body of bodies as any[]) {
      const cats = body?.payload?.categories ?? body?.categories;
      if (!Array.isArray(cats)) continue;
      const collect = (cat: any) => {
        const catName = textVal(cat?.name);
        if (Array.isArray(cat?.items))
          cat.items.forEach((it: any) => push(it, catName));
        if (Array.isArray(cat?.categories)) cat.categories.forEach(collect);
      };
      cats.forEach(collect);
    }
    if (out.length) return out;

    // Фолбэк: рекурсивный обход, если структура изменилась.
    const walk = (node: any, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      if (typeof node === "object") {
        const price = node.price ?? node.decimalPrice ?? node.decimal_price ?? node.cost;
        if (node.name && price != null && !node.slug) push(node);
        for (const key of ["items", "menu", "categories", "payload", "result", "data", "products"]) {
          if (node[key]) walk(node[key], depth + 1);
        }
      }
    };
    bodies.forEach((b) => walk(b));
    return out;
  }

  /**
   * Находит карточку блюда по названию, прокручивая меню — сайт подгружает
   * позиции лениво, по мере прокрутки до их категории.
   */
  private async findMenuItemCard(page: Page, itemName: string) {
    const sel = '[data-testid="product-card-v2-root"]';
    const byName = () => page.locator(sel).filter({ hasText: itemName }).first();
    for (let step = 0; step < 20; step++) {
      if (await byName().count()) return byName();
      const atBottom = await page.evaluate(() => {
        const y = window.scrollY;
        window.scrollBy(0, 1100);
        return window.scrollY === y;
      });
      await page.waitForTimeout(500);
      if (atBottom) break;
    }
    return (await byName().count()) ? byName() : null;
  }

  /**
   * Добавляет позицию в корзину по названию (должна быть открыта страница
   * ресторана — сначала get_menu). Простые позиции добавляет счётчиком на
   * карточке; позиции с обязательными опциями открывает и выбирает переданные
   * `options` (напр. ["Острый"]).
   */
  async addToCart(
    itemName: string,
    quantity = 1,
    options: string[] = []
  ): Promise<{ ok: boolean; message: string }> {
    const page = await this.page();
    const card = await this.findMenuItemCard(page, itemName);
    if (!card) {
      return {
        ok: false,
        message: `Позиция «${itemName}» не найдена в меню даже после прокрутки. Проверьте, что открыт нужный ресторан (get_menu) и название совпадает.`,
      };
    }
    await card.scrollIntoViewIfNeeded().catch(() => {});

    // Простой случай: опции не заданы и на карточке есть счётчик «+».
    const plus = card
      .locator('[data-testid="product-card-v2-counter-increase-btn"]')
      .first();
    if (!options.length && (await plus.count())) {
      await plus.click().catch(() => {});
      await page.waitForTimeout(900);
      const modalOpened = await page
        .locator('[data-testid="product-full-card-name"]')
        .isVisible()
        .catch(() => false);
      if (!modalOpened) {
        // Добавилось прямо на карточке — докликиваем нужное количество.
        for (let i = 1; i < quantity; i++) {
          await plus.click().catch(() => {});
          await page.waitForTimeout(400);
        }
        return { ok: true, message: `Добавлено: ${itemName} ×${quantity}` };
      }
      // Иначе открылась карточка товара (нужны опции) — обрабатываем ниже.
    } else {
      await card.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    return this.addFromItemModal(page, itemName, quantity, options);
  }

  /** Добавляет из открытой карточки товара: выбор опций, количество, «Добавить». */
  private async addFromItemModal(
    page: Page,
    itemName: string,
    quantity: number,
    options: string[]
  ): Promise<{ ok: boolean; message: string }> {
    const nameVisible = await page
      .locator('[data-testid="product-full-card-name"]')
      .isVisible()
      .catch(() => false);
    if (!nameVisible) {
      return { ok: false, message: `Не удалось открыть карточку «${itemName}».` };
    }
    const modal = page
      .locator('[data-testid="desktop-popup"], [role="dialog"]')
      .first();
    // Кнопка «Добавить» (по тексту/по testid); активность — по isEnabled.
    const addBtn = modal
      .locator(
        '[data-testid="product-full-card-add-to-cart"], button:has-text("Добавить")'
      )
      .first();
    const ready = async () =>
      (await addBtn.count()) > 0 &&
      (await addBtn.isEnabled().catch(() => false));

    // Выбираем переданные опции по тексту (напр. «Воппер Беконез», «Большой»).
    // Опция — ряд с radio/checkbox; кликаем по самому тексту (Playwright попадёт
    // в нужный элемент, а не в скрытый input).
    for (const opt of options) {
      const byText = modal.getByText(opt, { exact: false }).first();
      if (await byText.count()) {
        await byText.scrollIntoViewIfNeeded().catch(() => {});
        await byText.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    // Количество (+ в карточке товара).
    const inc = modal.locator('[data-testid="amount-select-increment"]').first();
    for (let i = 1; i < quantity; i++) {
      if (await inc.count()) await inc.click().catch(() => {});
      await page.waitForTimeout(300);
    }

    if (!(await ready())) {
      await page.keyboard.press("Escape").catch(() => {});
      return {
        ok: false,
        message:
          `«${itemName}» требует выбора обязательных опций (вкус/размер/добавки), ` +
          `подобрать автоматически не вышло. Уточни у пользователя вариант и передай его в options ` +
          `(например options: ["Острый"]).`,
      };
    }
    await addBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
    const optNote = options.length ? ` (${options.join(", ")})` : "";
    return { ok: true, message: `Добавлено: ${itemName} ×${quantity}${optNote}` };
  }

  /** Читает состав корзины. */
  async getCart(): Promise<{ items: MenuItem[]; total?: string; raw?: unknown }> {
    const page = await this.page();
    const bodies = await collectJson(page, API.cart, async () => {
      const cartBtn = await firstVisible(page, SELECTORS.goToCart, 3000);
      if (cartBtn) await cartBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    });
    const items = this.parseMenuFromApi(bodies);
    // Пытаемся найти итоговую сумму в теле.
    let total: string | undefined;
    for (const b of bodies as any[]) {
      total =
        b?.total?.text ??
        b?.totalPrice ??
        b?.payload?.total?.text ??
        total;
      if (total) break;
    }
    return { items, total, raw: bodies[0] };
  }

  /**
   * Оформляет заказ. По умолчанию dryRun=true — НЕ подтверждает, а только
   * доходит до финального экрана и возвращает сводку. Для реального заказа
   * нужно явно передать confirm=true.
   */
  async placeOrder(opts: {
    confirm?: boolean;
    comment?: string;
  }): Promise<{ ok: boolean; placed: boolean; message: string }> {
    const page = await this.page();
    const cartBtn = await firstVisible(page, SELECTORS.goToCart, 4000);
    if (cartBtn) await cartBtn.click().catch(() => {});
    await page.waitForTimeout(1000);

    if (opts.comment) {
      const commentField = page
        .locator('textarea, input[placeholder*="комментар" i]')
        .first();
      if (await commentField.count()) {
        await commentField.fill(opts.comment).catch(() => {});
      }
    }

    const submit = await firstVisible(page, SELECTORS.placeOrderButton, 5000);
    if (!submit) {
      return {
        ok: false,
        placed: false,
        message:
          "Кнопка оформления не найдена. Проверьте, что корзина не пуста и адрес/оплата заданы.",
      };
    }

    if (!opts.confirm) {
      const label = await submit.innerText().catch(() => "Оформить заказ");
      return {
        ok: true,
        placed: false,
        message: `Dry-run: доступна кнопка «${label.trim()}». Заказ НЕ оформлен. Передайте confirm=true для реального оформления.`,
      };
    }

    const bodies = await collectJson(page, API.order, async () => {
      await submit.click();
      await page.waitForTimeout(3000);
    });
    const created = (bodies as any[]).some(
      (b) => b?.orderId || b?.order?.id || b?.payload?.orderId
    );
    return {
      ok: true,
      placed: true,
      message: created
        ? "Заказ оформлен ✅ (получен orderId от API)."
        : "Кнопка нажата, но подтверждение orderId не перехвачено — проверьте статус через get_orders.",
    };
  }

  /** Делает скриншот текущей страницы для диагностики. */
  async screenshot(name = "snapshot"): Promise<string> {
    const page = await this.page();
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    const safe = name.replace(/[^a-z0-9_-]/gi, "_");
    const file = path.join(SCREENSHOT_DIR, `${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }

  /** Возвращает текущий URL, заголовок и обрезанный текст страницы. */
  async snapshot(): Promise<{ url: string; title: string; text: string }> {
    const page = await this.page();
    const text = (await page.locator("body").innerText().catch(() => "")).slice(
      0,
      4000
    );
    return { url: page.url(), title: await page.title(), text };
  }

  /** Переход по произвольному пути сайта (для навигации/отладки). */
  async goto(pathOrUrl: string): Promise<{ url: string; title: string }> {
    const page = await this.page();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${BASE_URL}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(1000);
    return { url: page.url(), title: await page.title() };
  }
}

export const eda = new YandexEda();
