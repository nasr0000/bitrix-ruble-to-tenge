const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const WEBHOOK = "https://itnasr.bitrix24.kz/rest/1/bucjza1li2wbp6lr/";
const RUBLE_FIELD = "UF_CRM_1753277551304"; // Сумма в рублях

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

    const rub = parseFloat(rubRaw.toString().replace(/[^0-9.]/g, ""));
    if (isNaN(rub)) return res.status(200).send("❌ Некорректное значение рубля");

    // Получаем курс RUB → KZT
    const kursRes = await axios.get("https://open.er-api.com/v6/latest/RUB");
    const rate = parseFloat(kursRes.data?.rates?.KZT);
    if (!rate || isNaN(rate)) return res.status(500).send("❌ Курс не получен");

    const tenge = Math.round(rub * rate);

    // Обновляем сумму сделки
    await axios.post(`${WEBHOOK}crm.deal.update`, {
      id: dealId,
      fields: {
        OPPORTUNITY: tenge,
        CURRENCY_ID: "KZT"
      }
    });

    console.log(`✅ Сделка #${dealId}: ₽${rub} × ${rate} = ${tenge} ₸`);

    // Обновляем цену товаров
    const productRes = await axios.post(`${WEBHOOK}crm.deal.productrows.get`, { id: dealId });
    const productRows = productRes.data?.result;

    if (productRows && productRows.length > 0) {
      const updatedRows = productRows.map(row => ({
        ...row,
        PRICE: tenge,
        PRICE_BRUTTO: tenge,
        PRICE_NETTO: tenge
      }));

      await axios.post(`${WEBHOOK}crm.deal.productrows.set`, {
        id: dealId,
        rows: updatedRows
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
