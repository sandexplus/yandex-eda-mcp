import type { Page, Response, BrowserContext, Locator } from "playwright";
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

/** Товар магазина (retail). */
export interface ShopProduct {
  name: string;
  price?: number | string;
  /** Цена по акции/скидке, если есть. */
  promoPrice?: number | string;
  weight?: string;
  inStock?: boolean;
  description?: string;
}

/** Позиция в корзине (с количеством и выбранными опциями). */
export interface CartItem {
  name: string;
  quantity?: number;
  price?: number | string;
  subtotal?: number | string;
  /** Выбранные опции (вкус/размер/добавки). */
  options?: string[];
}

/** Группа опций блюда (вкус/размер/добавки) с вариантами выбора. */
export interface OptionGroup {
  name: string;
  /** Обязательна ли группа (нужно выбрать хотя бы один вариант). */
  required: boolean;
  min?: number;
  max?: number;
  options: { name: string; price?: number | string }[];
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
    // Даём шапке дорисоваться, иначе можно прочитать промежуточное состояние.
    await page
      .locator("header button")
      .first()
      .waitFor({ state: "visible", timeout: 6000 })
      .catch(() => {});
    await page.waitForTimeout(600);
    const ctrl = this.addressControl(page);
    const txt = ((await ctrl.textContent().catch(() => "")) || "").trim();
    // «Укажите адрес» — это НЕ адрес, а приглашение его задать.
    if (!txt || /Укажите адрес/i.test(txt)) return null;
    return txt;
  }

  /**
   * Открывает список сохранённых адресов. Работает в ОБОИХ состояниях:
   * • есть активный адрес → попап «Куда доставить?» по клику на адрес в шапке;
   * • адреса нет → модалка «Укажите адрес»; фокус на поле ввода показывает
   *   сохранённые/недавние (zerosuggest) как li[role="option"].
   */
  private async openSavedPopup(page: Page): Promise<boolean> {
    if (
      await page
        .locator('button:has-text("Куда доставить?")')
        .isVisible()
        .catch(() => false)
    )
      return true;

    const ctrl = this.addressControl(page);
    await ctrl.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    const label = ((await ctrl.textContent().catch(() => "")) || "").trim();

    // Активный адрес есть → попап «Куда доставить?».
    if (label && !/Укажите адрес/i.test(label)) {
      for (let i = 0; i < 3; i++) {
        await ctrl.click({ timeout: 4000 }).catch(() => {});
        const ok = await page
          .locator('button:has-text("Куда доставить?")')
          .first()
          .waitFor({ state: "visible", timeout: 3000 })
          .then(() => true, () => false);
        if (ok) {
          await page.waitForTimeout(700);
          return true;
        }
      }
    }

    // Активного адреса нет → модалка ввода + фокус на поле (zerosuggest покажет
    // сохранённые/недавние адреса строками li[role="option"]).
    if (await this.openAddressModal(page)) {
      const input = page.locator(SELECTORS.addressInput[0]).first();
      await input.click().catch(() => {});
      const appeared = await page
        .locator('li[role="option"]')
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true, () => false);
      if (appeared) {
        await page.waitForTimeout(600);
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
        '[data-testid="desktop-popup"],[class*="popup" i],[class*="Popup" i],[role="dialog"]'
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
    // Совпавший элемент — кнопка попапа (активный адрес) ИЛИ строка модалки
    // li[role="option"] (состояние «нет адреса»).
    await page
      .locator(
        '[data-testid="desktop-popup"] button, [class*="popup" i] button, [class*="Popup" i] button, [role="dialog"] button, li[role="option"]'
      )
      .filter({ hasText: needle })
      .first()
      .click({ timeout: 4000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    // Из модалки «Укажите адрес» после выбора может быть экран карты с «Ок».
    const okBtn = page.locator('button:has-text("Ок"):not([disabled])').first();
    if (await okBtn.isVisible().catch(() => false)) {
      await okBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
    }
    await page
      .locator('button:has-text("Куда доставить?")')
      .waitFor({ state: "hidden", timeout: 4000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
    const shown = best.label ? `${best.label} — ${best.address}` : best.address;
    if (!(await this.hasAddress(page))) {
      return {
        ok: false,
        message: `Выбрал «${shown}», но адрес не применился — повтори или уточни.`,
      };
    }
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

  /** Разбирает optionsGroups блюда из API в удобный вид. */
  private parseOptionGroups(raw: any): OptionGroup[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((g: any) => ({
        name: textVal(g?.name) || "",
        required: !!(g?.required ?? g?.isRequired ?? g?.mandatory),
        min: g?.minSelected ?? g?.minSelectedOptions ?? g?.min,
        max: g?.maxSelected ?? g?.maxSelectedOptions ?? g?.max,
        options: (g?.options || g?.items || [])
          .map((o: any) => ({
            name: textVal(o?.name) || "",
            price: o?.price ?? o?.decimalPrice ?? undefined,
          }))
          .filter((o: any) => o.name),
      }))
      .filter((g: OptionGroup) => g.options.length);
  }

  /**
   * Возвращает группы опций конкретного блюда (вкус/размер/добавки с вариантами),
   * чтобы агент показал выбор пользователю и передал нужный вариант в add_to_cart.
   * Читает из API меню — надёжно, без клика по карточке.
   */
  async getItemOptions(
    restaurantUrlOrSlug: string,
    itemName: string
  ): Promise<{ restaurant: string; item: string | null; groups: OptionGroup[] }> {
    const { restaurant, items } = await this.getMenu(restaurantUrlOrSlug);
    const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").trim();
    const q = norm(itemName);
    const item =
      items.find((i) => norm(i.name) === q) ||
      items.find((i) => norm(i.name).includes(q)) ||
      items.find((i) => q.includes(norm(i.name)));
    if (!item) return { restaurant, item: null, groups: [] };
    return {
      restaurant,
      item: item.name,
      groups: this.parseOptionGroups((item.raw as any)?.optionsGroups),
    };
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
          `«${itemName}» требует выбора обязательных опций (вкус/размер/добавки). ` +
          `Вызови get_item_options для этого блюда, чтобы увидеть точные варианты, ` +
          `затем add_to_cart с options: [...] (например options: ["Воппер Беконез"]).`,
      };
    }
    await addBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
    const optNote = options.length ? ` (${options.join(", ")})` : "";
    return { ok: true, message: `Добавлено: ${itemName} ×${quantity}${optNote}` };
  }

  // --- Магазины (retail) -----------------------------------------------------

  /** Резолвит магазин (имя/slug/retail-путь) в путь `/retail/{brand}?placeSlug=...`. */
  private async resolveShopPath(page: Page, shop: string): Promise<string | null> {
    const s = shop.trim();
    if (/\/retail\//.test(s)) {
      if (s.startsWith("http")) {
        const u = new URL(s);
        return u.pathname + u.search;
      }
      return s.startsWith("/") ? s : "/" + s;
    }
    // 1) Карточка магазина на главной («Магазины») — быстро, но требует адреса.
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const href = await page.evaluate((q: string) => {
      const norm = (x: string) => x.toLowerCase().replace(/ё/g, "е");
      const links = [...document.querySelectorAll('a[href*="/retail/"]')].filter(
        (a) => !/\/d\//.test(a.getAttribute("href") || "")
      );
      const m = links.find((a) => norm(a.textContent || "").includes(norm(q)));
      return m ? m.getAttribute("href") : null;
    }, s);
    if (href) return href;

    // 2) Через поиск заведений (работает и без активного адреса, и для магазинов
    //    не с главной): находим магазин, открываем его — сайт редиректит на
    //    retail-страницу, из URL берём brand + placeSlug.
    const found = await this.searchRestaurants(s, "shop", true).catch(() => []);
    const shopRes = found[0];
    if (shopRes?.url || shopRes?.slug) {
      const target = shopRes.url || `${BASE_URL}/restaurant/${shopRes.slug}`;
      await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3000);
      const cur = page.url();
      if (/\/retail\//.test(cur)) {
        const u = new URL(cur);
        const ps = u.searchParams.get("placeSlug");
        return u.pathname + (ps ? `?placeSlug=${ps}` : "");
      }
    }
    return null;
  }

  /** Категории магазина из ответа goods (все, с признаком верхнего уровня). */
  private parseShopCategories(
    bodies: unknown[]
  ): { name: string; id: string | number; top: boolean }[] {
    const out: { name: string; id: string | number; top: boolean }[] = [];
    const seen = new Set<string>();
    for (const b of bodies as any[]) {
      const cats = b?.payload?.categories;
      if (!Array.isArray(cats)) continue;
      for (const c of cats) {
        const name = textVal(c?.name);
        if (!name || c?.id == null || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, id: c.id, top: !c.parentId });
      }
    }
    return out;
  }

  /** Товары из ответов магазина (search: blocks[].payload.products; goods: categories[].items). */
  private parseProducts(bodies: unknown[]): ShopProduct[] {
    const out: ShopProduct[] = [];
    const seen = new Set<string>();
    const push = (p: any) => {
      const name = textVal(p?.name);
      const price = p?.price ?? p?.decimalPrice;
      if (!name || price == null) return;
      // У retail-товаров `id` часто 0 (неуникален) — дедупим по public_id/uid.
      const key = String(p.public_id ?? p.uid ?? p.id ?? name);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name,
        price,
        promoPrice: p.promoPrice ?? p.decimalPromoPrice ?? undefined,
        weight: p.weight ?? p.measure,
        inStock: p.inStock ?? p.available,
        description: textVal(p.description) || undefined,
      });
    };
    const walk = (node: any, depth = 0) => {
      if (!node || depth > 10) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      if (typeof node === "object") {
        const price = node.price ?? node.decimalPrice;
        if (node.name && price != null && !Array.isArray(node.items)) push(node);
        for (const k of ["products", "items", "payload", "blocks", "categories", "data", "result"]) {
          if (node[k]) walk(node[k], depth + 1);
        }
      }
    };
    bodies.forEach((b) => walk(b));
    return out;
  }

  /**
   * Работа с магазином (retail). Без query/category — отдаёт список категорий;
   * с query — ищет товары по запросу; с category — товары этой категории.
   * `shop` — имя («Пятёрочка»), slug или retail-путь.
   */
  async searchProducts(
    shop: string,
    query?: string,
    category?: string
  ): Promise<{
    shop: string;
    mode: "search" | "category" | "categories";
    categories?: string[];
    products?: ShopProduct[];
    note?: string;
  }> {
    await this.ensureLoggedIn();
    const page = await this.page();
    const path = await this.resolveShopPath(page, shop);
    if (!path) {
      return {
        shop,
        mode: "categories",
        categories: [],
        note: `Магазин «${shop}» не найден на главной. Уточни название (Пятёрочка, Магнит, Лента…) или передай его retail-URL.`,
      };
    }
    const brand = (path.match(/\/retail\/([^/?]+)/) || [])[1] || "";
    const placeSlug = (path.match(/placeSlug=([^&]+)/) || [])[1] || "";
    const shopUrl = `${BASE_URL}/retail/${brand}?placeSlug=${placeSlug}`;

    // Поиск по запросу.
    if (query && query.trim()) {
      const q = query.trim();
      const bodies = await collectJson(
        page,
        /\/api\/v\d+\/menu\/search/,
        async () => {
          await page.goto(`${shopUrl}&query=${encodeURIComponent(q)}`, {
            waitUntil: "domcontentloaded",
          });
          await page.waitForTimeout(3500);
        },
        2500
      );
      return { shop, mode: "search", products: this.parseProducts(bodies) };
    }

    // Категории (для отдачи или резолва).
    const catBodies = await collectJson(
      page,
      /\/api\/v2\/menu\/goods/,
      async () => {
        await page.goto(shopUrl, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(4000);
      },
      2500
    );
    const cats = this.parseShopCategories(catBodies);
    const topCats = cats.filter((c) => c.top);
    const displayNames = (topCats.length ? topCats : cats).map((c) => c.name);

    // Просмотр конкретной категории (резолвим по ВСЕМ категориям, включая под-).
    if (category && category.trim()) {
      const norm = (x: string) => x.toLowerCase().replace(/ё/g, "е");
      const cat =
        cats.find((c) => norm(c.name) === norm(category)) ||
        cats.find((c) => norm(c.name).includes(norm(category))) ||
        cats.find((c) => norm(category).includes(norm(c.name)));
      if (!cat) {
        return {
          shop,
          mode: "category",
          categories: displayNames,
          products: [],
          note: `Категория «${category}» не найдена. Выбери из списка categories.`,
        };
      }
      const bodies = await collectJson(
        page,
        /\/api\/v2\/menu\/goods/,
        async () => {
          await page.goto(
            `${BASE_URL}/retail/${brand}/catalog/${cat.id}?placeSlug=${placeSlug}`,
            { waitUntil: "domcontentloaded" }
          );
          await page.waitForTimeout(4000);
        },
        2500
      );
      return { shop, mode: "category", products: this.parseProducts(bodies) };
    }

    // Ни query, ни category — отдаём список категорий (верхний уровень).
    return { shop, mode: "categories", categories: displayNames };
  }

  /**
   * Открывает корзину, чтобы подгрузился full-carts и появилась панель с
   * «Очистить». Принудительно грузим главную (иначе на устаревшей странице
   * кнопки корзины может не быть), затем открываем drawer кликом по «Корзина»
   * (эта кнопка есть только когда в корзине что-то есть).
   */
  private async openCart(page: Page): Promise<void> {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    // Кнопка «Корзина»/«Корзины · N» появляется через пару секунд после загрузки
    // и только когда в корзине что-то есть — ждём её явно.
    const cartBtn = page
      .locator('button:has-text("Корзин"), [data-testid="cart-button"]')
      .first();
    const has = await cartBtn
      .waitFor({ state: "visible", timeout: 7000 })
      .then(() => true, () => false);
    if (has) {
      await cartBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }

  /** Собирает названия выбранных опций позиции корзины (рекурсивно). */
  private flattenCartOptions(raw: any): string[] | undefined {
    const out: string[] = [];
    const walk = (o: any, depth = 0) => {
      if (!o || depth > 5) return;
      if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
      if (typeof o === "object") {
        const n = textVal(o.name);
        if (n) out.push(n);
        for (const k of ["options", "modifiers", "group_options", "items"]) {
          if (o[k]) walk(o[k], depth + 1);
        }
      }
    };
    walk(raw);
    return out.length ? [...new Set(out)] : undefined;
  }

  /** Разбирает корзину из ответа full-carts (`cart.items[]`). */
  private parseCart(bodies: unknown[]): {
    items: CartItem[];
    total?: number | string;
    subtotal?: number | string;
    deliveryFee?: number | string;
    place?: string;
    placeSlug?: string;
  } {
    for (const body of bodies as any[]) {
      const cart = body?.cart;
      if (cart && Array.isArray(cart.items)) {
        const items: CartItem[] = cart.items.map((it: any) => ({
          name: textVal(it?.name) || "",
          quantity: it?.quantity ?? it?.count,
          price: it?.price ?? it?.decimal_price,
          subtotal: it?.subtotal,
          options: this.flattenCartOptions(it?.item_options),
        }));
        return {
          items,
          total: cart.total ?? cart.decimal_total,
          subtotal: cart.subtotal ?? cart.decimal_subtotal,
          deliveryFee: cart.delivery_fee ?? cart.decimal_delivery_fee,
          place: textVal(cart.place?.name) || cart.place_slug,
          placeSlug: cart.place_slug ?? cart.place?.slug,
        };
      }
    }
    return { items: [] };
  }

  /** Читает состав корзины (через API full-carts). */
  async getCart(): Promise<{
    items: CartItem[];
    total?: number | string;
    subtotal?: number | string;
    deliveryFee?: number | string;
    place?: string;
  }> {
    await this.ensureLoggedIn();
    const page = await this.page();
    const bodies = await collectJson(
      page,
      /cart\/v\d+\/full-carts/,
      async () => {
        await this.openCart(page);
      },
      2000
    );
    return this.parseCart(bodies);
  }

  /**
   * Полностью очищает корзину (кнопка «Очистить»). Нужна, чтобы поменять уже
   * добавленную позицию с опциями — Яндекс Еда не даёт редактировать опции в
   * корзине, поэтому старую позицию удаляем и добавляем заново.
   */
  async clearCart(): Promise<{ ok: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = await this.page();
    // Яндекс Еда держит отдельную корзину на каждое заведение. В оверлее «Корзины»
    // у каждой — иконка-кнопка удаления (без текста). На каждой итерации грузим
    // главную заново, ждём кнопку корзины, открываем оверлей и удаляем одну.
    let removed = 0;
    for (let i = 0; i < 8; i++) {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      const cartsBtn = page
        .locator('button:has-text("Корзин"), [data-testid="cart-button"]')
        .first();
      const has = await cartsBtn
        .waitFor({ state: "visible", timeout: 7000 })
        .then(() => true, () => false);
      if (!has) break; // корзин больше нет
      await cartsBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
      const trash = page
        .locator(
          '[data-testid="desktop-popup"] button:has(svg), [role="dialog"] button:has(svg), [class*="opup" i] button:has(svg)'
        )
        .filter({ hasNotText: /ресторан|Оформить|заказ|Корзин/i })
        .first();
      if (!(await trash.count()) || !(await trash.isVisible().catch(() => false)))
        break;
      await trash.click().catch(() => {});
      await page.waitForTimeout(1500);
      const confirm = page
        .locator(
          'button:has-text("Удалить"), button:has-text("Очистить"), button:has-text("Да")'
        )
        .first();
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      removed++;
    }
    return {
      ok: true,
      message: removed
        ? `Корзина очищена (удалено корзин: ${removed}).`
        : "Корзина уже пуста.",
    };
  }

  /**
   * Точечно удаляет из корзины одну позицию по названию (и, если задано, по
   * опциям — одно и то же блюдо может быть в корзине в нескольких вариантах с
   * разными опциями). Уменьшает счётчик строки в панели корзины до нуля.
   */
  async removeFromCart(
    itemName: string,
    options: string[] = []
  ): Promise<{ ok: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = await this.page();
    const bodies = await collectJson(
      page,
      /cart\/v\d+\/full-carts/,
      async () => {
        await this.openCart(page);
      },
      2000
    );
    const cart = this.parseCart(bodies);
    if (!cart.items.length) return { ok: false, message: "Корзина пуста." };

    const norm = (s?: string | null) =>
      (s || "").toLowerCase().replace(/ё/g, "е").trim();
    const qn = norm(itemName);
    let matches = cart.items.filter(
      (it) => norm(it.name).includes(qn) || qn.includes(norm(it.name))
    );
    if (!matches.length) {
      return {
        ok: false,
        message: `В корзине нет «${itemName}». Есть: ${cart.items
          .map((i) => i.name)
          .join(", ")}.`,
      };
    }
    if (options.length) {
      matches = matches.filter((it) =>
        options.every((o) =>
          (it.options || []).some((io) => norm(io).includes(norm(o)))
        )
      );
      if (!matches.length) {
        return {
          ok: false,
          message: `«${itemName}» с опциями [${options.join(", ")}] в корзине не найден.`,
        };
      }
    }
    if (matches.length > 1) {
      const variants = matches
        .map((m) => (m.options?.length ? m.options.join("+") : "без опций"))
        .join(" | ");
      return {
        ok: false,
        message: `«${itemName}» в корзине в нескольких вариантах: ${variants}. Уточни опции для удаления (options).`,
      };
    }
    const chosen = matches[0];

    // Идём на страницу заведения — там панель корзины со строками и счётчиками.
    if (cart.placeSlug) {
      await page
        .goto(`${BASE_URL}/restaurant/${cart.placeSlug}`, {
          waitUntil: "domcontentloaded",
        })
        .catch(() => {});
      await page.waitForTimeout(3500);
    }
    // Находим строку по названию (+ опциям в тексте строки) и жмём «−» до нуля.
    const nameEls = page
      .locator('[data-testid="cart-item-name"]')
      .filter({ hasText: chosen.name });
    const cnt = await nameEls.count();
    let row: Locator | null = null;
    for (let i = 0; i < cnt; i++) {
      const r = nameEls
        .nth(i)
        .locator('xpath=ancestor::*[.//*[@data-testid="amount-select-decrement"]][1]');
      const t = norm(await r.textContent().catch(() => ""));
      if (!options.length || options.every((o) => t.includes(norm(o)))) {
        row = r;
        break;
      }
    }
    if (!row) {
      return {
        ok: false,
        message: `Строка «${chosen.name}» в панели корзины не найдена (вёрстка изменилась?).`,
      };
    }
    const dec = row.locator('[data-testid="amount-select-decrement"]').first();
    const qty = Number(chosen.quantity) || 1;
    for (let k = 0; k < qty; k++) {
      if (!(await dec.count())) break;
      await dec.click().catch(() => {});
      await page.waitForTimeout(1200);
      const cf = page
        .locator('button:has-text("Удалить"), button:has-text("Убрать")')
        .first();
      if (await cf.isVisible().catch(() => false)) {
        await cf.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
    }
    const optNote = chosen.options?.length ? ` (${chosen.options.join(", ")})` : "";
    return { ok: true, message: `Удалено из корзины: ${chosen.name}${optNote}` };
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
