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
      "Открывает ресторан и возвращает его меню. Принимает URL или slug из search_restaurants.",
    inputSchema: {
      restaurant: z
        .string()
        .describe("URL ресторана или его slug (из результатов поиска)"),
      limit: z.number().int().min(1).max(200).optional().default(80),
    },
  },
  async ({ restaurant, limit }) => {
    const { restaurant: name, items } = await eda.getMenu(restaurant);
    if (!items.length) {
      return fail(
        `Меню для «${name}» не распознано. Возможно, ресторан недоступен по текущему адресу.`
      );
    }
    return json({
      restaurant: name,
      count: items.length,
      items: items.slice(0, limit).map((i) => ({
        name: i.name,
        price: i.price,
        weight: i.weight,
        category: i.category,
        // Позиции с опциями требуют выбора вкуса/размера при add_to_cart (options).
        hasOptions: i.hasOptions,
        description: i.description,
      })),
    });
  }
);

// --- Корзина и заказ -------------------------------------------------------
server.registerTool(
  "add_to_cart",
  {
    title: "Добавить в корзину",
    description:
      "Добавляет позицию в корзину по названию (сначала get_menu на нужном ресторане). " +
      "Меню подгружается лениво — инструмент сам прокручивает страницу до позиции. " +
      "Если у блюда `hasOptions` (вкус/размер/добавки) — передай выбор в `options`, " +
      "например options: [\"Острый\"]; иначе кнопка добавления будет заблокирована.",
    inputSchema: {
      item: z.string().describe("Название блюда как в меню (get_menu)"),
      quantity: z.number().int().min(1).max(20).optional().default(1),
      options: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          "Обязательные опции блюда по тексту: вкус/размер/добавки (напр. [\"Острый\", \"Большой\"])"
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
    description: "Возвращает содержимое корзины и итоговую сумму.",
    inputSchema: {},
  },
  async () => {
    const cart = await eda.getCart();
    return json({
      total: cart.total,
      items: cart.items.map((i) => ({ name: i.name, price: i.price })),
    });
  }
);

server.registerTool(
  "place_order",
  {
    title: "Оформить заказ",
    description:
      "Оформляет заказ из корзины. ПО УМОЛЧАНИЮ безопасный dry-run: доходит до кнопки " +
      "оформления, но НЕ подтверждает. Для реального заказа передайте confirm=true.",
    inputSchema: {
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe("true = реально оформить заказ и списать оплату"),
      comment: z.string().optional().describe("Комментарий курьеру/ресторану"),
    },
  },
  async ({ confirm, comment }) => {
    const res = await eda.placeOrder({ confirm, comment });
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
