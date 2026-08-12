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
const IPAYMU_VA = process.env.IPAYMU_VA;
const IPAYMU_API_KEY = process.env.IPAYMU_API_KEY;
const IPAYMU_URL = 'https://sandbox.ipaymu.com/api/v2/payment/direct';

const app = express();
const bot = new TelegramBot(token, { polling: true });

const pendingOrders = {};
const pendingTopups = {};
const searchResults = {};
const userState = {};

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
  const res = await fetch(`${OTP_BASE_URL}/${path}`, { headers: { 'X-Api-Key': OTP_API_KEY } });
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

function generateIpaymuSignature(method, body) {
  const bodyEncrypt = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').toLowerCase();
  const stringToSign = `${method}:${IPAYMU_VA}:${bodyEncrypt}:${IPAYMU_API_KEY}`;
  return crypto.createHmac('sha256', IPAYMU_API_KEY).update(stringToSign).digest('hex');
}

function countryButtons() {
  const buttons = POPULAR_COUNTRIES.map(c => ([{ text: c.name, callback_data: `negara_${c.id}` }]));
  buttons.push([{ text: '🔍 Cari negara lain', callback_data: 'cari_negara' }]);
  return buttons;
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = { step: null };
  bot.sendMessage(chatId, 'Halo! Pilih negara untuk nomor OTP, atau ketik /topup <jumlah> buat isi saldo.', {
    reply_markup: { inline_keyboard: countryButtons() }
  });
});

bot.onText(/\/topup (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const amount = parseInt(match[1].trim());

  if (isNaN(amount) || amount < 1000) {
    return bot.sendMessage(chatId, 'Format: /topup <jumlah>\nContoh: /topup 50000');
  }

  const body = {
    name: `User ${chatId}`,
    phone: '081234567890',
    email: `user${chatId}@example.com`,
    amount: amount,
    paymentMethod: 'qris',
    paymentChannel: 'qris',
    notifyUrl: 'https://bot-otp-production.up.railway.app/webhook/topup',
    referenceId: `TOPUP-${chatId}-${Date.now()}`
  };

  const signature = generateIpaymuSignature('POST', body);

  try {
    const res = await fetch(IPAYMU_URL, {
      method: 'POST',
      headers: {
        'va': IPAYMU_VA,
        'signature': signature,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const result = await res.json();

    if (!result.Success) {
      return bot.sendMessage(chatId, `Gagal membuat QR: ${result.Message}`);
    }

    const d = result.Data;
    pendingTopups[d.TransactionId] = chatId;

    const qrRes = await fetch(d.QrImage);
    const qrBuffer = Buffer.from(await qrRes.arrayBuffer());

await bot.sendPhoto(chatId, qrBuffer, {
      caption: `💳 Topup Rp${amount.toLocaleString('id-ID')}\n\nScan QR di atas buat bayar.\nBerlaku sampai: ${d.Expired}\n\nSaldo otomatis masuk setelah pembayaran dikonfirmasi.`
    }, {
      filename: 'qris.png',
      contentType: 'image/png'
    });
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Gagal menghubungi iPaymu.');
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('negara_')) {
    const countryId = parseInt(data.split('_')[1]);
    const countryName = POPULAR_COUNTRIES.find(c => c.id === countryId)?.name || `ID ${countryId}`;
    userState[chatId] = { step: 'awaiting_service', country_id: countryId, country_name: countryName };
    bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, `Negara: ${countryName}\n\nKetik nama aplikasi/layanan yang mau di-OTP:`);
  }

  if (data === 'cari_negara') {
    userState[chatId] = { step: 'awaiting_country_search' };
    bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, 'Ketik nama negara yang kamu mau:');
  }

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

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const state = userState[chatId];
  if (!state) return;

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

app.post('/webhook/topup', express.urlencoded({ extended: true }), (req, res) => {
  console.log('Notifikasi topup diterima:', JSON.stringify(req.body));

  const { trx_id, status } = req.body;
  const chatId = pendingTopups[trx_id];

  if (chatId && status === '1') {
    bot.sendMessage(chatId, `✅ Pembayaran berhasil! Saldo kamu sudah ditambahkan.`);
    delete pendingTopups[trx_id];
  }

  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send('Bot order jalan!');
});

app.listen(port, () => {
  console.log(`Server jalan di port ${port}`);
});
