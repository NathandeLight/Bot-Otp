require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot = TelegramBotModule.default || TelegramBotModule;

const token = process.env.BOT_TOKEN;
const port = process.env.PORT || 3000;
const OTP_API_KEY = process.env.OTP_API_KEY;
const OTP_WEBHOOK_SECRET = process.env.OTP_WEBHOOK_SECRET;
const OTP_BASE_URL = 'https://otpinstan.com/api/reseller/s1';
const DEFAULT_COUNTRY_ID = 7; // Indonesia

const app = express();
const bot = new TelegramBot(token, { polling: true });

// Nyimpen order_id -> chatId di memori (hilang kalau server restart, tapi cukup buat mulai)
const pendingOrders = {};

// ---------- Helper: panggil API OTP Instan ----------
async function otpApiGet(path) {
  const res = await fetch(`${OTP_BASE_URL}/${path}`, {
    headers: { 'X-Api-Key': OTP_API_KEY }
  });
  return res.json();
}

async function otpApiPost(path, body) {
  const res = await fetch(`${OTP_BASE_URL}/${path}`, {
    method: 'POST',
    headers: {
      'X-Api-Key': OTP_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ---------- Bot commands ----------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Halo! Selamat datang di bot order OTP.\n\nKetik /order <nama layanan> untuk order nomor.\nContoh: /order Shopee');
});

bot.onText(/\/order (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim().toLowerCase();

  try {
    bot.sendMessage(chatId, `Mencari layanan "${match[1]}"...`);

    const servicesRes = await otpApiGet(`services.php?country_id=${DEFAULT_COUNTRY_ID}`);
    if (!servicesRes.success) {
      return bot.sendMessage(chatId, 'Gagal ambil daftar layanan. Coba lagi nanti.');
    }

    // Cari layanan yang namanya cocok, ambil yang stok > 0 dan termurah
    const matches = servicesRes.data
      .filter(s => s.service_name.toLowerCase().includes(query) && s.stock > 0)
      .sort((a, b) => a.price - b.price);

    if (matches.length === 0) {
      return bot.sendMessage(chatId, `Layanan "${match[1]}" tidak ditemukan atau stok habis.`);
    }

    const chosen = matches[0];

    const orderRes = await otpApiPost('order.php', {
      platform_id: chosen.platform_id,
      country_id: DEFAULT_COUNTRY_ID
    });

    if (!orderRes.success) {
      return bot.sendMessage(chatId, `Gagal order: ${orderRes.message || 'terjadi kesalahan'}`);
    }

    const { order_id, phone } = orderRes.data;
    pendingOrders[order_id] = chatId;

    bot.sendMessage(chatId,
      `✅ Order berhasil!\n\nLayanan: ${chosen.service_name}\nHarga: Rp${chosen.price}\nNomor: ${phone}\nOrder ID: ${order_id}\n\nSegera pakai nomor ini di aplikasi tujuan. OTP akan otomatis dikirim ke sini kalau sudah masuk.`
    );
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Terjadi kesalahan saat memproses order.');
  }
});

bot.onText(/^\/order$/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Format: /order <nama layanan>\nContoh: /order Shopee');
});

// ---------- Webhook dari OTP Instan ----------
// Pakai express.raw khusus di route ini supaya bisa verifikasi signature dari raw body
app.post('/webhook/otp', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-signature'] || '';
  const expected = crypto
    .createHmac('sha256', OTP_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (signature !== expected) {
    return res.status(401).send('Invalid signature');
  }

  const data = JSON.parse(req.body.toString());

  if (data.event === 'otp.received') {
    const chatId = pendingOrders[data.order_id];
    if (chatId) {
      bot.sendMessage(chatId, `📩 OTP masuk!\n\nLayanan: ${data.service}\nKode OTP: ${data.otp_code}\n\nPesan lengkap: ${data.sms_text}`);
      delete pendingOrders[data.order_id];
    }
  }

  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send('Bot order jalan!');
});

app.listen(port, () => {
  console.log(`Server jalan di port ${port}`);
});
