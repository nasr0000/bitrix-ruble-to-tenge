// ruble-to-tenge-mig.js
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const WEBHOOK = "https://itnasr.bitrix24.kz/rest/1/ryf2hig29n6p3f1w/";
const RUBLE_FIELD = "UF_CRM_1753277551304"; // поле "Сумма в рублях"

// ===== Helpers =====
function toNum(s) {
  if (!s) return NaN;
  return parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
}

async function withRetry(fn, tries = 2, delayMs = 400) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ===== MiG parser (RUB → KZT, Покупка) =====
async function getRubRateFromMig() {
  const url = "https://mig.kz/api/v1/gadget/html";
  const { data: html } = await axios.get(url, { timeout: 10000, headers: {
    "User-Agent": "Mozilla/5.0 (RateFetcher/1.0)"
  }});

  const text = String(html)
    .replace(/&nbsp;/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Берём всё, что идёт ПОСЛЕ первого "RUB"
  const parts = text.split("RUB");
  const rubBlock = parts.length > 1 ? parts.slice(1).join("RUB") : "";
  if (!rubBlock) throw new Error("RUB not found in MiG");

  // Варианты подписи "Покупка"
  const buyPatterns = [
    /Покупка[^0-9]{0,30}([\d\s.,]+)/i,     // ru
    /Сатып алу[^0-9]{0,30}([\d\s.,]+)/i,   // kk
    /Buy[^0-9]{0,30}([\d\s.,]+)/i          // en
  ];

  // 1) Пытаемся найти в rubBlock
  for (const rx of buyPatterns) {
    const m = rubBlock.match(rx);
    if (m && m[1]) {
      const val = toNum(m[1]);
      if (!isNaN(val) && val > 0) return val;
    }
  }

  // 2) Фолбэк: по всему тексту “RUB … Покупка … число”
  for (const rx of buyPatterns) {
    const m = text.match(new RegExp(`RUB[^P]{0,120}${rx.source}`, "i"));
    if (m && m[1]) {
      const val = toNum(m[1]);
      if (!isNaN(val) && val > 0) return val;
    }
  }

  // 3) Альтернативный порядок: "Продажа ... Покупка ..."
  const alt = rubBlock.match(/Продажа[^0-9]{0,30}([\d\s.,]+)[^R]*Покупка[^0-9]{0,30}([\d\s.,]+)/i);
  if (alt && alt[2]) {
    const val = toNum(alt[2]);
    if (!isNaN(val) && val > 0) return val;
  }

  // Для диагностики выведем кусок текста (не весь)
  console.warn("MiG parse warn. rubBlock:", rubBlock.slice(0, 400));
  throw new Error("RUB buy rate not found");
}

app.get("/", (req, res) => {
  res.send("🚀 Сервер работает! Ожидаю POST от Bitrix24...");
});

app.get("/ping", (req, res) => {
  res.send("✅ Сервер отвечает! Время: " + new Date().toISOString());
});

// Удобный дебаг-эндпоинт, чтобы смотреть текущий курс с MiG
app.get("/rate", async (_req, res) => {
  try {
    const rate = await withRetry(getRubRateFromMig, 2);
    res.json({ source: "MiG", rub_kzt_buy: rate });
  } catch (err) {
    const msg = err?.response?.data || err.message || String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/", async (req, res) => {
  const dealId = req.body?.data?.FIELDS?.ID;
  if (!dealId) return res.status(400).send("❌ Не передан ID сделки");

  try {
    // Получаем сделку
    const getRes = await axios.post(`${WEBHOOK}crm.deal.get`, { id: dealId });
    const deal = getRes.data?.result;
    const rubRaw = deal?.[RUBLE_FIELD];
    if (!rubRaw) return res.status(200).send("⚠️ Поле с рублями пустое");

    const rub = toNum(rubRaw);
    if (isNaN(rub)) return res.status(200).send("❌ Некорректное значение рубля");

    // Курс RUB→KZT (покупка)
    const rate = await withRetry(getRubRateFromMig, 2);
    if (!rate) return res.status(500).send("❌ Курс не получен с MiG");

    const tenge = Math.round(rub * rate);

    // Обновляем сумму сделки
    await axios.post(`${WEBHOOK}crm.deal.update`, {
      id: dealId,
      fields: { OPPORTUNITY: tenge, CURRENCY_ID: "KZT" },
    });

    console.log(`✅ Сделка #${dealId}: ₽${rub} × ${rate} = ${tenge} ₸`);

    // Обновляем товары
    const productRes = await axios.post(`${WEBHOOK}crm.deal.productrows.get`, { id: dealId });
    const productRows = productRes.data?.result;

    if (Array.isArray(productRows) && productRows.length > 0) {
      const updatedRows = productRows.map((row) => ({
        ...row,
        PRICE: tenge,
        PRICE_BRUTTO: tenge,
        PRICE_NETTO: tenge,
        CURRENCY_ID: "KZT",
      }));

      await axios.post(`${WEBHOOK}crm.deal.productrows.set`, {
        id: dealId,
        rows: updatedRows,
      });

      console.log(`🛒 Обновлены цены товаров в сделке #${dealId} → ${tenge} ₸`);
    } else {
      console.warn(`⚠️ В сделке #${dealId} нет товаров для обновления`);
    }

    res.send(`✅ Обновлено: ₽${rub} × ${rate} = ${tenge} ₸`);
  } catch (err) {
    const msg = err?.response?.data || err.message || String(err);
    console.error("❌ Ошибка:", msg);
    res.status(500).send("❌ Ошибка сервера: " + (typeof msg === "string" ? msg : JSON.stringify(msg)));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Сервер запущен на порту", PORT));
