// ruble-to-tenge-mig.js (optimized, deal-only)
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const WEBHOOK = "https://itnasr.bitrix24.kz/rest/1/ryf2hig29n6p3f1w/";
const AMOUNT_FIELD = "UF_CRM_1753277551304"; // одно поле: "Сумма в валюте" (используем как RUB в этом проекте)

const http = axios.create({
  timeout: 8000,
  headers: { "User-Agent": "itnasr-b24-rub2kzt" },
});

// ===== Helpers =====
function toNum(val) {
  if (val == null) return NaN;
  return parseFloat(String(val).replace(/\s/g, "").replace(",", "."));
}

function parseMoney(val) {
  if (val == null) return NaN;
  const n = parseFloat(String(val).replace(/[^0-9.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

/* ---- MiG: SELL RUB→KZT с кэшем ---- */
let migCache = { sell: null, ts: 0 };
const MIG_TTL_MS = 120 * 1000;

async function getRubSellFromMig() {
  const now = Date.now();
  if (migCache.sell && now - migCache.ts < MIG_TTL_MS) return migCache.sell;

  const { data: html } = await http.get("https://mig.kz/api/v1/gadget/html");
  const text = String(html)
    .replace(/&nbsp;/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Пробуем найти два числа рядом с RUB
  // В зависимости от разметки могут быть варианты
  let m =
    text.match(/RUB\s*(\d{1,3}(?:[.,]\d{1,4})?)\s*(\d{1,3}(?:[.,]\d{1,4})?)/i) ||
    text.match(/(\d{1,3}(?:[.,]\d{1,4})?)\s*RUB\s*(\d{1,3}(?:[.,]\d{1,4})?)/i);

  if (!m) throw new Error("MiG: RUB not found");

  const a = toNum(m[1]);
  const b = toNum(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`MiG: invalid RUB values a=${a} b=${b}`);

  // Обычно sell >= buy, берём большее как sell
  const sell = Math.max(a, b);
  const buy = Math.min(a, b);

  // Валидация (рубль обычно ~3-10 тг)
  if (!Number.isFinite(sell) || sell < 1 || sell > 50 || buy > sell) {
    throw new Error(`MiG: invalid RUB rates buy=${buy} sell=${sell}`);
  }

  migCache = { sell, ts: now };
  return sell;
}

// ===== Health endpoints =====
app.get("/", (_req, res) => res.send("🚀 RUB→KZT сервер работает. Ожидаю POST от Bitrix24..."));
app.get("/ping", (_req, res) => res.send("✅ OK " + new Date().toISOString()));
app.get("/rate", async (_req, res) => {
  try {
    const sell = await getRubSellFromMig();
    res.json({ source: "MiG", rub_kzt_sell: sell, cache_age_ms: Date.now() - migCache.ts });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ===== Webhook =====
app.post("/", async (req, res) => {
  const dealId = req.body?.data?.FIELDS?.ID;
  if (!dealId) return res.status(400).send("No deal ID");

  try {
    // 1) Быстро: пробуем взять сумму из webhook
    let raw = req.body?.data?.FIELDS?.[AMOUNT_FIELD];
    let rub = parseMoney(raw);

    // 2) Fallback: если не пришло — берём из сделки
    let dealFromGet = null;
    if (!Number.isFinite(rub)) {
      const dealResp = await http.post(`${WEBHOOK}crm.deal.get`, { id: dealId });
      dealFromGet = dealResp.data?.result;
      raw = dealFromGet?.[AMOUNT_FIELD];
      rub = parseMoney(raw);
    }

    if (!Number.isFinite(rub)) return res.status(200).send("Ruble amount is empty or invalid");

    // 3) Курс и расчёт
    const sell = await getRubSellFromMig();
    const tenge = Math.round(rub * sell);

    // 4) Не обновляем лишний раз (только если уже делали get)
    if (dealFromGet && String(dealFromGet?.OPPORTUNITY) === String(tenge) && dealFromGet?.CURRENCY_ID === "KZT") {
      return res.send(`SKIP: already ${tenge} ₸ (rate ${sell})`);
    }

    // 5) Обновляем только сделку
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
app.listen(PORT, () => console.log("🚀 Server started on", PORT));
