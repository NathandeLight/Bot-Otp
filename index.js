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

const app = express();
const bot = new TelegramBot(token, { polling: true });

const pendingOrders = {};   // order_id -> chatId
const searchResults = {};  // chatId -> hasil pencarian layanan sementara
const userState = {};      // chatId -> { step, country_id, country_name }

// Negara populer buat tombol cepat (bisa disesuaikan)
const POPULAR_COUNTRIES = [
  { id: 7, name: 'Indonesia' },
  { id: 188, name: 'USA' },
  { id: 1, name: 'Russia' },
  { id: 23, name: 'India' },
  { id: 17, name: 'United Kingdom' },
  { id: 5, name: 'Philippines' },
  { id: 11, name: 'Vietnam' },
  { id: 8, name: 'Malaysia' },
];

async function otpApiGet(path) {
  const res = await fetch(`${OTP_BASE_URL}/${path}`, {
    headers: { 'X-Api-Key': OTP_API_KEY }
  });
  return res.json();
}

async function otpApiPost(path, body) {
  const res = await fetch(`${OTP_BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'X-Api-Key': OTP_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function countryButtons() {
  const buttons = POPULAR_COUNTRIES.map(c => ([{ text: c.name, callback_data: `negara_${c.id}` }]));
  buttons.push([{ text: '🔍 Cari negara lain', callback_data: 'cari_negara' }]);
  return buttons;
}

// ---------- /start ----------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = { step: null };
  bot.sendMessage(chatId, 'Halo! Pilih negara untuk nomor OTP:', {
    reply_markup: { inline_keyboard: countryButtons() }
  });
});

// ---------- Tombol ditekan ----------
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Pilih negara populer
  if (data.startsWith('negara_')) {
    const countryId = parseInt(data.split('_')[1]);
    const countryName = POPULAR_COUNTRIES.find(c => c.id === countryId)?.name || `ID ${countryId}`;
    userState[chatId] = { step: 'awaiting_service', country_id: countryId, country_name: countryName };
    bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, `Negara: ${countryName}\n\nKetik nama aplikasi/layanan yang mau di-OTP (misal: Shopee, WhatsApp, Telegram):`);
  }

  // Minta cari negara lain
  if (data === 'cari_negara') {
    userState[chatId] = { step: 'awaiting_country_search' };
    bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, 'Ketik nama negara yang kamu mau:');
  }

  // Pilih negara dari hasil pencarian
  if (data.startsWith('negarahasil_')) {
    const idx = parseInt(data.split('_')[1]);
    const results = userState[chatId]?.searchCountries;
    if (!results || !results[idx]) {
      return bot.answerCallbackQuery(query.id, { text: 'Sesi kadaluarsa, coba /start lagi.' });
    }
    const chosen = results[idx];
    userState[chatId] = { step: 'awaiting_service', country_id: chosen.country_id, country_name: chosen.country_name };
    bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, `Negara: ${chosen.country_name}\n\nKetik nama aplikasi/layanan yang mau di-OTP:`);
  }

  // Pilih layanan hasil pencarian -> order
  if (data.startsWith('pilih_')) {
    const idx = parseInt(data.split('_')[1]);
    const matches = searchResults[chatId];
    if (!matches || !matches[idx]) {
      return bot.answerCallbackQuery(query.id, { text: 'Sesi kadaluarsa, coba lagi.' });
    }
    const chosen = matches[idx];
    const state = userState[chatId];
    bot.answerCallbackQuery(query.id, { text: `Memproses order ${chosen.service_name}...` });

    try {
      const orderRes = await otpApiPost('order.php', {
        platform_id: chosen.platform_id,
        country_id: state.country_id
      });

      if (!orderRes.success) {
        return bot.sendMessage(chatId, `Gagal order: ${orderRes.message || 'terjadi kesalahan'}`);
      }

      const { order_id, phone } = orderRes.data;
      pendingOrders[order_id] = chatId;

      bot.sendMessage(chatId,
        `✅ Order berhasil!\n\nNegara: ${state.country_name}\nLayanan: ${chosen.service_name}\nHarga: Rp${chosen.price}\nNomor: ${phone}\nOrder ID: ${order_id}\n\nSegera pakai nomor ini di aplikasi tujuan. OTP akan otomatis dikirim ke sini kalau sudah masuk.`
      );
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Terjadi kesalahan saat memproses order.');
    }
    delete searchResults[chatId];
  }
});

// ---------- Pesan teks biasa (bukan command) ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const state = userState[chatId];
  if (!state) return;

  // Lagi nyari negara
  if (state.step === 'awaiting_country_search') {
    try {
      const countriesRes = await otpApiGet('countries.php');
      if (!countriesRes.success) return bot.sendMessage(chatId, 'Gagal ambil daftar negara.');

      const matches = countriesRes.data
        .filter(c => c.country_name.toLowerCase().includes(text.toLowerCase()))
        .slice(0, 8);

      if (matches.length === 0) {
        return bot.sendMessage(chatId, `Negara "${text}" tidak ditemukan. Coba nama lain.`);
      }

      userState[chatId] = { step: 'awaiting_country_search', searchCountries: matches };
      const buttons = matches.map((c, i) => ([{ text: c.country_name, callback_data: `negarahasil_${i}` }]));
      bot.sendMessage(chatId, `Ditemukan ${matches.length} negara:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Terjadi kesalahan saat mencari negara.');
    }
    return;
  }

  // Lagi nyari layanan
  if (state.step === 'awaiting_service') {
    try {
      bot.sendMessage(chatId, `Mencari layanan "${text}"...`);

      const servicesRes = await otpApiGet(`services.php?country_id=${state.country_id}`);
      if (!servicesRes.success) return bot.sendMessage(chatId, 'Gagal ambil daftar layanan.');

      const matches = servicesRes.data
        .filter(s => s.service_name.toLowerCase().includes(text.toLowerCase()) && s.stock > 0)
        .sort((a, b) => a.price - b.price)
        .slice(0, 8);

      if (matches.length === 0) {
        return bot.sendMessage(chatId, `Layanan "${text}" tidak ditemukan atau stok habis. Coba nama lain.`);
      }

      searchResults[chatId] = matches;
      const buttons = matches.map((s, i) => ([{ text: `${s.service_name} - Rp${s.price}`, callback_data: `pilih_${i}` }]));
      bot.sendMessage(chatId, `Ditemukan ${matches.length} layanan, pilih salah satu:`, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Terjadi kesalahan saat mencari layanan.');
    }
    return;
  }
});

// ---------- Webhook dari OTP Instan ----------
app.post('/webhook/otp', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-signature'] || '';
  const expected = crypto.createHmac('sha256', OTP_WEBHOOK_SECRET).update(req.body).digest('hex');

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
