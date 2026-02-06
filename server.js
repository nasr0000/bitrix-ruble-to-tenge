const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const WEBHOOK = "https://itnasr.bitrix24.kz/rest/1/ryf2hig29n6p3f1w/";

// Поле "Сумма в рублях"
const RUBLE_FIELD = "UF_CRM_1753277551304";

// Тот самый коэффициент защиты (3% маржи для покрытия разницы курсов и комиссий)
const MARKUP_COEFFICIENT = 1.03; 

const http = axios.create({
  timeout: 8000,
  headers: { "User-Agent": "itnasr-b24-rub2kzt" },
});

/* ---- MiG: SELL RUB→KZT с кэшем ---- */
let migCache = { sell: null, ts: 0 };
const MIG_TTL_MS = 120 * 1000;

function toNum(s) {
  if (s == null) return NaN;
  return parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
}

function parseRub(val) {
  if (val == null) return NaN;
  const n = parseFloat(String(val).replace(/[^0-9.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

async function getRubSellFromMig() {
  const now = Date.now();
  if (migCache.sell && now - migCache.ts < MIG_TTL_MS) return migCache.sell;

  const { data: html } = await http.get("https://mig.kz/api/v1/gadget/html");

  const text = String(html)
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let m = text.match(/(\d{1,4}(?:[.,]\d{1,4})?)\s*RUB\s*(\d{1,4}(?:[.,]\d{1,4})?)/i);
  if (!m) {
    m = text.match(/RUB\s*(\d{1,4}(?:[.,]\d{1,4})?)\s*(\d{1,4}(?:[.,]\d{1,4})?)/i);
  }
  if (!m) throw new Error("MiG: RUB not found");

  const buy = toNum(m[1]);
  const sell = toNum(m[2]); 

  // Sanity-check: для рубля ставим разумные границы 3-10
  if (!Number.isFinite(buy) || !Number.isFinite(sell) || sell < 3 || sell > 15 || buy > sell) {
    throw new Error(`MiG: invalid values buy=${buy} sell=${sell}`);
  }

  migCache = { sell, ts: now };
  return sell;
}

/* ---- Webhook ---- */
app.post("/", async (req, res) => {
  const dealId = req.body?.data?.FIELDS?.ID;
  if (!dealId) return res.status(400).send("No deal ID");

  try {
    // 1) Пытаемся взять сумму ₽ прямо из webhook
    let rubRaw = req.body?.data?.FIELDS?.[RUBLE_FIELD];
    let rub = parseRub(rubRaw);

    // 2) Если в webhook нет поля — берём через crm.deal.get
    let dealFromGet = null;
    if (!Number.isFinite(rub)) {
      const dealResp = await http.post(`${WEBHOOK}crm.deal.get`, { id: dealId });
      dealFromGet = dealResp.data?.result;

      rubRaw = dealFromGet?.[RUBLE_FIELD];
      rub = parseRub(rubRaw);
    }

    if (!Number.isFinite(rub)) return res.status(200).send("Ruble field is empty or invalid");

    // 3) Курс и расчёт с учетом наценки
    const rawRate = await getRubSellFromMig();
    const effectiveRate = rawRate * MARKUP_COEFFICIENT;
    const tenge = Math.round(rub * effectiveRate);

    // 4) SKIP если уже так стоит
    if (
      dealFromGet &&
      String(dealFromGet?.OPPORTUNITY) === String(tenge) &&
      String(dealFromGet?.CURRENCY_ID || "") === "KZT"
    ) {
      return res.send(`SKIP: already ${tenge} ₸ (rate ${effectiveRate.toFixed(2)})`);
    }

    // 5) Обновляем сделку с комментарием
    await http.post(`${WEBHOOK}crm.deal.update`, {
      id: dealId,
      fields: { 
        OPPORTUNITY: tenge, 
        CURRENCY_ID: "KZT",
        COMMENTS: `Курс RUB/KZT: ${effectiveRate.toFixed(2)} (MiG: ${rawRate} + 3% коммисия сервиса). Обновлено: ${new Date().toLocaleTimeString()}`
      },
    });

    res.send(`OK: ₽${rub} × ${effectiveRate.toFixed(2)} = ${tenge} ₸`);
  } catch (e) {
    res.status(500).send("Server error: " + (e?.message || e));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}. RUB markup: 3%`);
});