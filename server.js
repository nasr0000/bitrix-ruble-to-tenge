// ruble-to-tenge-mig.js
const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const WEBHOOK = "https://itnasr.bitrix24.kz/rest/1/ryf2hig29n6p3f1w/";
const RUBLE_FIELD = "UF_CRM_1753277551304"; // поле "Сумма в рублях"

// Вспомогательная функция для чисел
function toNum(s) {
  if (!s) return NaN;
  return parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
}

// Получаем курс покупки RUB → KZT с mig.kz
async function getRubRateFromMig() {
  const url = "https://mig.kz/api/v1/gadget/html";
  const { data: html } = await axios.get(url, { timeout: 10000 });

  // Убираем теги и лишние пробелы
  const text = String(html)
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Ищем блок "RUB" и значение "Покупка"
  const rubBlock = text.split("RUB")[1];
  if (!rubBlock) throw new Error("RUB not found in MiG");

  const match = rubBlock.match(/Покупка\s*([\d.,]+)/i);
  if (!match) throw new Error("RUB buy rate not found");

  return toNum(match[1]);
}

app.get("/", (req, res) => {
  res.send("🚀 Сервер работает! Ожидаю POST от Bitrix24...");
});

app.get("/ping", (req, res) => {
  res.send("✅ Сервер отвечает! Время: " + new Date().toISOString());
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
    const rate = await getRubRateFromMig();
    if (!rate) return res.status(500).send("❌ Курс не получен с MiG");

    const tenge = Math.round(rub * rate);

    // Обновляем сумму сделки
    await axios.post(`${WEBHOOK}crm.deal.update`, {
      id: dealId,
      fields: {
        OPPORTUNITY: tenge,
        CURRENCY_ID: "KZT",
      },
    });

    console.log(`✅ Сделка #${dealId}: ₽${rub} × ${rate} = ${tenge} ₸`);

    // Обновляем товары
    const productRes = await axios.post(`${WEBHOOK}crm.deal.productrows.get`, { id: dealId });
    const productRows = productRes.data?.result;

    if (productRows && productRows.length > 0) {
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
      console.warn("⚠️ В сделке нет товаров для обновления");
    }

    res.send(`✅ Обновлено: ₽${rub} × ${rate} = ${tenge} ₸`);
  } catch (err) {
    console.error("❌ Ошибка:", err.message);
    res.status(500).send("❌ Ошибка сервера");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Сервер запущен на порту", PORT));
