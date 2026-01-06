// ruble-to-tenge-mig-like-usd.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const WEBHOOK = "https://itnasr.bitrix24.kz/rest/1/ryf2hig29n6p3f1w/";

// поле "Сумма в рублях"
const RUBLE_FIELD = "UF_CRM_1753277551304";

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

  // Формат MiG может быть разный, поэтому 2 паттерна:
  // 1) "число RUB число" (buy sell)
  let m = text.match(
    /(\d{1,4}(?:[.,]\d{1,4})?)\s*RUB\s*(\d{1,4}(?:[.,]\d{1,4})?)/i
  );
  // 2) "RUB число число"
  if (!m) {
    m = text.match(
      /RUB\s*(\d{1,4}(?:[.,]\d{1,4})?)\s*(\d{1,4}(?:[.,]\d{1,4})?)/i
    );
  }
  if (!m) throw new Error("MiG: RUB not found");

  const buy = toNum(m[1]);
  const sell = toNum(m[2]); // SELL — используем его

  // sanity-check: RUB→KZT обычно в районе 3–10 (очень грубо)
  // Если MiG поменял верстку и мы не то схватили — отсекаем.
  if (
    !Number.isFinite(buy) ||
    !Number.isFinite(sell) ||
    sell < 0.5 ||
    sell > 50 ||
    buy > sell
  ) {
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

    // 2) Если в webhook нет поля — берём через crm.deal.get (fallback)
    let dealFromGet = null;
    if (!Number.isFinite(rub)) {
      const dealResp = await http.post(`${WEBHOOK}crm.deal.get`, { id: dealId });
      dealFromGet = dealResp.data?.result;

      rubRaw = dealFromGet?.[RUBLE_FIELD];
      rub = parseRub(rubRaw);
    }

    if (!Number.isFinite(rub)) return res.status(200).send("Ruble field is empty or invalid");

    // 3) Курс и расчёт
    const sell = await getRubSellFromMig();
    const tenge = Math.round(rub * sell);

    // 4) SKIP если уже так стоит
    if (
      dealFromGet &&
      String(dealFromGet?.OPPORTUNITY) === String(tenge) &&
      String(dealFromGet?.CURRENCY_ID || "") === "KZT"
    ) {
      return res.send(`SKIP: already ${tenge} ₸ (rate ${sell})`);
    }

    // 5) Обновляем ТОЛЬКО сделку
    await http.post(`${WEBHOOK}crm.deal.update`, {
      id: dealId,
      fields: { OPPORTUNITY: tenge, CURRENCY_ID: "KZT" },
    });

    res.send(`OK: ₽${rub} × ${sell} = ${tenge} ₸`);
  } catch (e) {
    res.status(500).send("Server error: " + (e?.message || e));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {});
