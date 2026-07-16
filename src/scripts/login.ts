/**
 * Интерактивный вход в аккаунт Яндекса из терминала.
 *
 * Теперь это лишь тонкая обёртка над eda.interactiveLogin(): открывается видимое
 * окно браузера в персистентном профиле, вы входите руками (логин/пароль/SMS/
 * капча), сессия сохраняется, и MCP-сервер дальше работает headless.
 *
 * Обычно отдельный запуск не нужен — сервер открывает окно входа сам при первом
 * обращении к сайту (или по инструменту `login`). Этот скрипт оставлен для
 * ручного входа: `npm run login`.
 */
import { eda } from "../eda.js";
import { browserManager } from "../browser.js";
import { PROFILE_DIR, LOGIN_TIMEOUT } from "../config.js";

async function main() {
  console.log("=".repeat(60));
  console.log("Вход в Яндекс для yandex-eda-mcp");
  console.log(`Профиль: ${PROFILE_DIR}`);
  console.log("=".repeat(60));
  console.log(
    "\n➡  Откроется окно браузера. Войдите в свой аккаунт Яндекса и убедитесь,\n" +
      "   что на eda.yandex.ru вы залогинены. Окно закроется автоматически.\n" +
      `   Ожидание входа: до ${Math.round(LOGIN_TIMEOUT / 1000)} с.`
  );

  const res = await eda.interactiveLogin();
  await browserManager.close().catch(() => {});
  console.log(res.ok ? `\n✅ ${res.message}` : `\n❌ ${res.message}`);
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Ошибка логина:", err);
  process.exit(1);
});
