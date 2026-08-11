require('dotenv').config();
const express = require('express');
const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot = TelegramBotModule.default || TelegramBotModule;

const token = process.env.BOT_TOKEN;
const port = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// mode polling dulu buat testing lokal (nanti diganti webhook pas deploy)
const bot = new TelegramBot(token, { polling: true });

// Respon saat user kirim /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Halo! Selamat datang di bot order otomatis. Ketik /order untuk mulai pesan.');
});

// Respon saat user kirim /order
bot.onText(/\/order/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Fitur order lagi disiapkan. Nanti di sini kita sambungkan ke API web-nya.');
});

app.get('/', (req, res) => {
  res.send('Bot order jalan!');
});

app.listen(port, () => {
  console.log(`Server jalan di port ${port}`);
});
