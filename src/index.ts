#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { eda } from "./eda.js";
import { browserManager } from "./browser.js";

/**
 * MCP-сервер Яндекс Еды.
 *
 * Транспорт — stdio, поэтому в stdout нельзя писать ничего, кроме протокола.
 * Любые логи шлём в stderr.
 */
const server = new McpServer({
  name: "yandex-eda-mcp",
  version: "0.1.0",
});

// Сериализуем ВСЕ вызовы инструментов: MCP-клиент может слать их параллельно,
// а браузер/контекст один. Без сериализации операции затирают друг друга —
// гонки навигации, «Target page/context closed», ложный «Укажите адрес» и
// ложный ре-логин. Оборачиваем registerTool так, чтобы каждый обработчик
// выполнялся строго после предыдущего (по цепочке промисов).
let opChain: Promise<unknown> = Promise.resolve();
const _registerTool = server.registerTool.bind(server) as any;
(server as any).registerTool = (name: string, config: any, handler: any) =>
  _registerTool(name, config, (...args: any[]) => {
    const run = opChain.then(
      () => handler(...args),
      () => handler(...args)
    );
    opChain = run.then(
      () => {},
      () => {}
    );
    return run;
  });

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function json(data: unknown) {
  return ok(JSON.stringify(data, null, 2));
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// --- Авторизация -----------------------------------------------------------
server.registerTool(
  "login_status",
  {
    title: "Статус авторизации",
    description:
      "Проверяет, авторизован ли текущий профиль браузера в Яндексе. " +
      "Если не авторизован — вызовите инструмент `login` (откроется окно входа).",
    inputSchema: {},
  },
  async () => {
    const res = await eda.isLoggedIn();
    return json(res);
  }
);

server.registerTool(
  "login",
  {
    title: "Войти в Яндекс",
    description:
      "Открывает видимое окно браузера для входа в аккаунт Яндекса (логин/пароль/" +
      "SMS/капча). После входа сессия сохраняется в профиль, и сервер работает " +
      "headless. Нужно один раз на компьютере. Обычно вызывается автоматически " +
      "при первом обращении к сайту, но можно и вручную.",
    inputSchema: {},
  },
  async () => {
    const res = await eda.interactiveLogin();
    return res.ok ? ok(res.message) : fail(res.message);
  }
);

// --- Адрес доставки --------------------------------------------------------
server.registerTool(
  "get_address",
  {
    title: "Текущий адрес доставки",
    description:
      "Возвращает текущий адрес доставки (метку сохранённого адреса, например «Дом», " +
      "или улицу). Полезно спросить у пользователя «ищем тут?» перед поиском.",
    inputSchema: {},
  },
  async () => {
    const addr = await eda.getCurrentAddress();
    return ok(addr ? `Текущий адрес: ${addr}` : "Адрес не задан.");
  }
);

server.registerTool(
  "list_saved_addresses",
  {
    title: "Сохранённые адреса",
    description:
      "Возвращает сохранённые в аккаунте адреса доставки (с метками «Дом», " +
      "«На работу» и деталями — подъезд/этаж/квартира). Их можно выбрать через " +
      "set_address без повторного ввода на карте.",
    inputSchema: {},
  },
  async () => {
    const list = await eda.getSavedAddresses();
    if (!list.length)
      return ok("Сохранённых адресов не найдено (или нет активного адреса).");
    return json({ count: list.length, addresses: list });
  }
);

server.registerTool(
  "set_address",
  {
    title: "Задать адрес доставки",
    description:
      "Устанавливает адрес доставки. По умолчанию СНАЧАЛА ищет совпадение среди " +
      "сохранённых адресов (по метке «дом»/«работа» или улице) и выбирает его " +
      "мгновенно, СОХРАНЯЯ квартиру/подъезд/этаж — без повторного тыканья по карте. " +
      "Если сохранённого нет — вводит новый адрес через поиск на карте.",
    inputSchema: {
      address: z
        .string()
        .describe("Адрес или метка: «домой», «на работу», «Москва, Тверская 1»"),
      preferSaved: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "true (по умолч.) — сперва искать среди сохранённых; false — сразу вводить новый"
        ),
    },
  },
  async ({ address, preferSaved }) => {
    const res = await eda.setAddress(address, { preferSaved });
    return res.ok ? ok(res.message) : fail(res.message);
  }
);

// --- Рестораны и меню ------------------------------------------------------
server.registerTool(
  "search_restaurants",
  {
    title: "Поиск заведений",
    description:
      "Отдаёт заведения, доставляющие на текущий адрес, с рейтингом и временем " +
      "доставки (цена доставки — если распознана).\n" +
      "• Для запроса «кто вообще доставляет / покажи подборку» вызывай БЕЗ `query` — " +
      "вернётся весь каталог. НЕ придумывай ключевые слова (пицца/бургер): без них и так все.\n" +
      "• `query` задавай только когда пользователь ищет конкретное (кухня, блюдо, название).\n" +
      "• `type` разделяет выдачу: `restaurant` (по умолчанию, готовая еда) и `shop` " +
      "(магазины/аптеки/цветы). Каталог смешанный — поэтому по умолчанию отдаём только рестораны.\n" +
      "• По умолчанию возвращаются только ОТКРЫТЫЕ сейчас (доставляют прямо сейчас). " +
      "Закрытые/предзаказ скрыты — не предлагай их и не пытайся собрать корзину в закрытом. " +
      "`includeClosed: true` вернёт и закрытые (у них `open: false`).\n" +
      "Требуется заранее установленный адрес (set_address).",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe(
          "Конкретный запрос: кухня/блюдо/название. Пусто = весь каталог (для общей подборки — оставляй пустым)"
        ),
      type: z
        .enum(["restaurant", "shop", "all"])
        .optional()
        .default("restaurant")
        .describe(
          "restaurant — рестораны (готовая еда, по умолч.); shop — магазины/аптеки/цветы; all — всё вперемешку"
        ),
      includeClosed: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "false (по умолч.) — только открытые сейчас; true — включая закрытые/предзаказ"
        ),
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
  },
  async ({ query, type, includeClosed, limit }) => {
    const list = await eda.searchRestaurants(query, type, includeClosed);
    const sliced = list.slice(0, limit).map((r) => ({
      name: r.name,
      rating: r.rating,
      deliveryTime: r.deliveryTime,
      deliveryPrice: r.deliveryPrice,
      open: r.open,
      type: r.business,
      url: r.url ?? r.slug,
      categories: r.categories,
    }));
    if (!sliced.length) {
      const hint =
        type === "shop" ? "магазинов" : type === "all" ? "заведений" : "ресторанов";
      const closedNote = includeClosed
        ? ""
        : " Возможно, сейчас всё закрыто — попробуйте includeClosed: true.";
      return fail(
        `Не нашёл открытых ${hint}. Убедитесь, что задан адрес (set_address) и вы вошли (login).${closedNote}`
      );
    }
    return json({ count: sliced.length, type, restaurants: sliced });
  }
);

server.registerTool(
  "get_menu",
  {
    title: "Меню ресторана",
    description:
      "Возвращает ПОЛНОЕ меню ресторана, сгруппированное по категориям (URL или slug " +
      "из search_restaurants). По умолчанию компактно — без описаний, чтобы влезли " +
      "все позиции (у крупных ресторанов их 200+): не делай выводов «такого нет», " +
      "пока не просмотрел все категории. `full: true` добавит описания блюд. " +
      "У позиций с `hasOptions` при добавлении нужен выбор вкуса/размера (options).",
    inputSchema: {
      restaurant: z
        .string()
        .describe("URL ресторана или его slug (из результатов поиска)"),
      full: z
        .boolean()
        .optional()
        .default(false)
        .describe("true — добавить описания блюд (дороже по объёму)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .default(400)
        .describe("Максимум позиций (по умолч. 400 — обычно всё меню)"),
    },
  },
  async ({ restaurant, full, limit }) => {
    const { restaurant: name, items } = await eda.getMenu(restaurant);
    if (!items.length) {
      return fail(
        `Меню для «${name}» не распознано. Возможно, ресторан недоступен по текущему адресу.`
      );
    }
    const capped = items.slice(0, limit);
    // Группируем по категориям, сохраняя порядок меню.
    const byCat = new Map<string, any[]>();
    for (const i of capped) {
      const cat = i.category || "Прочее";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push({
        name: i.name,
        price: i.price,
        ...(i.weight ? { weight: i.weight } : {}),
        ...(i.hasOptions ? { hasOptions: true } : {}),
        ...(full && i.description ? { description: i.description } : {}),
      });
    }
    const categories = [...byCat].map(([cat, list]) => ({
      category: cat,
      items: list,
    }));
    return json({
      restaurant: name,
      count: capped.length,
      totalItems: items.length,
      truncated: items.length > capped.length || undefined,
      categoriesCount: categories.length,
      categories,
    });
  }
);

server.registerTool(
  "get_item_options",
  {
    title: "Опции блюда",
    description:
      "Возвращает группы обязательных/дополнительных опций блюда (вкус, размер, " +
      "гарнир, добавки) с вариантами и ценами. Вызывай для позиций с `hasOptions` " +
      "ПЕРЕД add_to_cart: покажи варианты пользователю (или выбери) и передай нужные " +
      "в add_to_cart через `options`. Обязательные группы помечены `required: true`.",
    inputSchema: {
      restaurant: z.string().describe("URL или slug ресторана"),
      item: z.string().describe("Название блюда (как в get_menu)"),
    },
  },
  async ({ restaurant, item }) => {
    const res = await eda.getItemOptions(restaurant, item);
    if (!res.item) {
      return fail(`Блюдо «${item}» не найдено в меню «${res.restaurant}».`);
    }
    if (!res.groups.length) {
      return ok(`У «${res.item}» нет опций — можно добавлять сразу (add_to_cart).`);
    }
    return json({ restaurant: res.restaurant, item: res.item, optionGroups: res.groups });
  }
);

// --- Магазины (retail) -----------------------------------------------------
server.registerTool(
  "search_products",
  {
    title: "Товары в магазине",
    description:
      "Работа с МАГАЗИНОМ (Пятёрочка, Магнит, Лента, Лавка…) — в отличие от ресторанов, " +
      "у магазина тысячи товаров, поэтому меню не выгружают целиком, а ищут/смотрят по " +
      "категориям:\n" +
      "• без `query` и `category` → список категорий магазина (посмотреть, что есть);\n" +
      "• `query` (напр. «молоко 3.2») → поиск товаров по запросу — ГЛАВНЫЙ путь для " +
      "«добавь X из магазина»;\n" +
      "• `category` (из списка категорий) → товары этой категории.\n" +
      "Возвращает товары с ценой, ценой по акции (promoPrice), весом и наличием (inStock). " +
      "Чтобы ДОБАВИТЬ товар в корзину — add_product (не add_to_cart). " +
      "Требуется заданный адрес. Магазин задаётся именем.",
    inputSchema: {
      shop: z
        .string()
        .describe("Магазин: имя («Пятёрочка», «Магнит»), slug или retail-URL"),
      query: z
        .string()
        .optional()
        .describe("Что искать среди товаров (напр. «молоко 3.2», «хлеб бородинский»)"),
      category: z
        .string()
        .optional()
        .describe("Название категории из списка (для просмотра её товаров)"),
      limit: z.number().int().min(1).max(60).optional().default(25),
    },
  },
  async ({ shop, query, category, limit }) => {
    const res = await eda.searchProducts(shop, query, category);
    if (res.mode === "categories") {
      if (!res.categories?.length)
        return fail(res.note || `Категории магазина «${shop}» не получены.`);
      return json({ shop: res.shop, categories: res.categories.slice(0, 60) });
    }
    const products = (res.products || []).slice(0, limit);
    if (!products.length) {
      return fail(
        res.note ||
          `В «${res.shop}» ничего не нашёл${query ? ` по «${query}»` : ""}. Проверь адрес (set_address) и название.`
      );
    }
    return json({ shop: res.shop, mode: res.mode, count: products.length, products });
  }
);

server.registerTool(
  "add_product",
  {
    title: "Добавить товар магазина в корзину",
    description:
      "Добавляет ТОВАР МАГАЗИНА (retail) в корзину — для магазинов используй это, а " +
      "НЕ add_to_cart (та только для ресторанов). Сам открывает магазин с поиском " +
      "товара, находит карточку по названию и жмёт «+». Название бери из результатов " +
      "search_products (чем точнее, тем лучше).",
    inputSchema: {
      shop: z.string().describe("Магазин: имя («Пятёрочка», «Магнит»), slug или retail-URL"),
      product: z
        .string()
        .describe("Название товара как в search_products (напр. «Огурцы среднеплодные вес»)"),
      quantity: z.number().int().min(1).max(30).optional().default(1),
    },
  },
  async ({ shop, product, quantity }) => {
    const res = await eda.addShopProduct(shop, product, quantity);
    return res.ok ? ok(res.message) : fail(res.message);
  }
);

// --- Корзина и заказ -------------------------------------------------------
server.registerTool(
  "add_to_cart",
  {
    title: "Добавить в корзину",
    description:
      "Добавляет блюдо РЕСТОРАНА в корзину по названию (сначала get_menu на нужном " +
      "ресторане). Для товаров МАГАЗИНА это НЕ работает — там add_product. " +
      "Меню подгружается лениво — инструмент сам прокручивает страницу до позиции. " +
      "Если у блюда `hasOptions` — СНАЧАЛА вызови get_item_options, чтобы узнать точные " +
      "варианты, и передай выбранные в `options` (значения должны совпадать с вариантами " +
      "из get_item_options). Без обязательных опций кнопка добавления заблокирована. " +
      "Чтобы ПОМЕНЯТЬ опции уже добавленной позиции — Яндекс Еда не даёт их редактировать, " +
      "поэтому удали её (remove_from_cart, при нескольких вариантах — с options) и добавь " +
      "заново с новыми options.",
    inputSchema: {
      item: z.string().describe("Название блюда как в меню (get_menu)"),
      quantity: z.number().int().min(1).max(20).optional().default(1),
      options: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          "Выбранные опции — тексты вариантов из get_item_options (напр. [\"Воппер Беконез\"])"
        ),
    },
  },
  async ({ item, quantity, options }) => {
    const res = await eda.addToCart(item, quantity, options);
    return res.ok ? ok(res.message) : fail(res.message);
  }
);

server.registerTool(
  "view_cart",
  {
    title: "Показать корзину",
    description:
      "Возвращает содержимое корзины: позиции (с количеством и выбранными опциями), " +
      "подытог, стоимость доставки и итог.",
    inputSchema: {},
  },
  async () => {
    const cart = await eda.getCart();
    if (!cart.items.length) return ok("Корзина пуста.");
    return json({
      place: cart.place,
      total: cart.total,
      subtotal: cart.subtotal,
      deliveryFee: cart.deliveryFee,
      items: cart.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price,
        subtotal: i.subtotal,
        ...(i.options && i.options.length ? { options: i.options } : {}),
      })),
    });
  }
);

server.registerTool(
  "remove_from_cart",
  {
    title: "Удалить позицию из корзины",
    description:
      "Точечно удаляет ОДНУ позицию из корзины по названию (в отличие от clear_cart, " +
      "который сносит всё). Одно и то же блюдо может лежать в корзине в нескольких " +
      "вариантах с разными опциями (они видны в view_cart) — тогда укажи `options`, " +
      "чтобы удалить нужный вариант. Это правильный способ ПОМЕНЯТЬ позицию: " +
      "remove_from_cart нужный вариант → add_to_cart с новыми опциями.",
    inputSchema: {
      item: z.string().describe("Название позиции как в корзине (view_cart)"),
      options: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          "Опции варианта для точного совпадения, если блюдо в корзине в нескольких вариантах (из view_cart)"
        ),
    },
  },
  async ({ item, options }) => {
    const res = await eda.removeFromCart(item, options);
    return res.ok ? ok(res.message) : fail(res.message);
  }
);

server.registerTool(
  "clear_cart",
  {
    title: "Очистить корзину",
    description:
      "Полностью очищает корзину (ВСЕ позиции и все корзины). Если в корзине есть и " +
      "другие позиции, а поменять надо одну — используй remove_from_cart, а не это. " +
      "Яндекс Еда не даёт редактировать опции в корзине, поэтому для смены варианта: " +
      "remove_from_cart (или clear_cart, если корзина только из этой позиции) → add_to_cart заново.",
    inputSchema: {},
  },
  async () => {
    const res = await eda.clearCart();
    return res.ok ? ok(res.message) : fail(res.message);
  }
);

server.registerTool(
  "list_payment_methods",
  {
    title: "Способы оплаты",
    description:
      "Показывает доступные способы оплаты (карты, Карта Пэй, СБП) и текущий выбранный. " +
      "Нужна НЕПУСТАЯ корзина (способы видны только на экране оформления). " +
      "ВАЖНО: СБП требует ручного подтверждения в приложении банка и НЕ оформится " +
      "автоматически — для авто-заказа выбирайте карту/Карту Пэй (параметр payment у place_order).",
    inputSchema: {},
  },
  async () => {
    const res = await eda.getPaymentMethods();
    return res.methods.length ? ok(res.message) : fail(res.message);
  }
);

server.registerTool(
  "place_order",
  {
    title: "Оформить заказ",
    description:
      "Оформляет заказ из корзины. ПО УМОЛЧАНИЮ безопасный dry-run: доходит до кнопки " +
      "«Оплатить», но НЕ подтверждает. Для реального заказа передайте confirm=true. " +
      "Через payment можно заранее выбрать способ оплаты (см. list_payment_methods). " +
      "СБП автоматически НЕ проходит (нужно приложение банка) — для авто-заказа payment должен быть картой.",
    inputSchema: {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("true = реально оформить заказ и списать оплату"),
      comment: z.string().optional().describe("Комментарий курьеру/ресторану"),
      payment: z
        .string()
        .optional()
        .describe(
          'Способ оплаты по названию, напр. "Карта Пэй" или "СБП" (см. list_payment_methods)'
        ),
    },
  },
  async ({ confirm, comment, payment }) => {
    const res = await eda.placeOrder({ confirm, comment, payment });
    return res.ok ? ok(res.message) : fail(res.message);
  }
);

// --- Навигация и отладка ---------------------------------------------------
server.registerTool(
  "navigate",
  {
    title: "Перейти по адресу",
    description: "Переходит по пути или полному URL внутри Яндекс Еды.",
    inputSchema: {
      path: z.string().describe("Путь (/orders) или полный URL"),
    },
  },
  async ({ path }) => {
    const res = await eda.goto(path);
    return json(res);
  }
);

server.registerTool(
  "debug_snapshot",
  {
    title: "Снимок страницы (отладка)",
    description:
      "Возвращает URL, заголовок и текст текущей страницы, а также сохраняет скриншот. " +
      "Помогает подстроить селекторы при изменении вёрстки сайта.",
    inputSchema: {
      screenshot: z.boolean().optional().default(true),
    },
  },
  async ({ screenshot }) => {
    const snap = await eda.snapshot();
    let file: string | undefined;
    if (screenshot) file = await eda.screenshot("debug");
    return json({ ...snap, screenshot: file });
  }
);

// --- Запуск ----------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[yandex-eda-mcp] сервер запущен (stdio)\n");
}

async function shutdown() {
  await browserManager.close().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  process.stderr.write(`[yandex-eda-mcp] фатальная ошибка: ${err?.stack || err}\n`);
  process.exit(1);
});
