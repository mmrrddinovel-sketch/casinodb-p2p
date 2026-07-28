const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// === СТАРТ ===
bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const isOwner = userId === process.env.OWNER_TG_ID;

  let menu = '🏦 P2P Процессинг для казино\n\n';
  if (isOwner) {
    menu += '🔹 /add_trader @username 10 — добавить трейдера\n';
    menu += '🔹 /add_casino Название — создать API ключ\n';
    menu += '🔹 /balance — мой баланс\n';
    menu += '🔹 /stats — статистика\n';
    menu += '🔹 /freeze_insurance @username СУММА ПРИЧИНА — заморозить страховку\n';
  } else {
    menu += '🔹 /deposit — пополнить депозит (100 USDT)\n';
    menu += '🔹 /mybalance — мой баланс\n';
    menu += '🔹 /confirm ID — подтвердить оплату\n';
    menu += '🔹 /myorders — мои заявки\n';
  }
  ctx.reply(menu);
});

// === ДОБАВИТЬ ТРЕЙДЕРА (только владелец) ===
bot.command('add_trader', async (ctx) => {
  if (String(ctx.from.id) !== process.env.OWNER_TG_ID) return ctx.reply('❌ Только владелец');
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Используй: /add_trader @username 10');

  const username = args[1].replace('@', '');
  const commission = parseFloat(args[2]) || 10;

  try {
    const user = await bot.telegram.getChat(username);
    const tg_id = String(user.id);

    const { error } = await supabase
      .from('traders')
      .insert({ tg_id, cards: [{}], commission_percent: commission, active: true });

    if (error) return ctx.reply('Ошибка: ' + error.message);
    ctx.reply(`✅ Трейдер @${username} добавлен с комиссией ${commission}%`);
  } catch (e) {
    ctx.reply('❌ Пользователь не найден: ' + e.message);
  }
});

// === ДОБАВИТЬ КАЗИНО (только владелец) ===
bot.command('add_casino', async (ctx) => {
  if (String(ctx.from.id) !== process.env.OWNER_TG_ID) return ctx.reply('❌ Только владелец');
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Используй: /add_casino Название');

  const name = args.slice(1).join(' ');
  const tg_id = String(ctx.from.id);

  const response = await fetch(process.env.API_URL + '/api/merchant/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tg_id, name })
  });
  const data = await response.json();
  if (data.api_key) {
    ctx.reply(`✅ Казино "${name}" создано!\nAPI Key: ${data.api_key}\nSecret: ${data.secret_key}\nСохрани!`);
  } else {
    ctx.reply('❌ Ошибка: ' + JSON.stringify(data));
  }
});

// === ДЕПОЗИТ (трейдер) ===
bot.command('deposit', async (ctx) => {
  const tg_id = String(ctx.from.id);

  const { data: existing } = await supabase
    .from('deposits')
    .select('id, status')
    .eq('trader_id', tg_id)
    .eq('status', 'pending')
    .single();

  if (existing) {
    return ctx.reply('⏳ У тебя уже есть незавершённый депозит.');
  }

  const response = await fetch(process.env.API_URL + '/api/deposit/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trader_tg_id: tg_id, amount_usdt: 100 })
  });
  const data = await response.json();

  if (data.address) {
    ctx.reply(
      `💳 Депозит 100 USDT:\n` +
      `Адрес: ${data.address}\n` +
      `Memo: ${data.memo}\n` +
      `После оплаты: /confirm_deposit ${data.deposit_id} ХЭШ`
    );
  } else {
    ctx.reply('❌ ' + (data.error || 'Ошибка'));
  }
});

// === ПОДТВЕРДИТЬ ДЕПОЗИТ (только владелец) ===
bot.command('confirm_deposit', async (ctx) => {
  if (String(ctx.from.id) !== process.env.OWNER_TG_ID) return ctx.reply('❌ Только владелец');
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Используй: /confirm_deposit ID_ДЕПОЗИТА ХЭШ');

  const deposit_id = args[1];
  const tx_hash = args[2];

  const response = await fetch(process.env.API_URL + '/api/deposit/confirm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': process.env.ADMIN_KEY
    },
    body: JSON.stringify({ deposit_id, tx_hash })
  });
  const result = await response.json();

  if (result.ok) {
    ctx.reply(`✅ Депозит ${deposit_id} подтверждён. Трейдер активирован.`);
  } else {
    ctx.reply('❌ ' + (result.error || 'Ошибка'));
  }
});

// === ПОДТВЕРДИТЬ ОПЛАТУ (трейдер) ===
bot.command('confirm', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) return ctx.reply('Используй: /confirm ID_ЗАЯВКИ');

  const orderId = args[1];
  const trader_tg_id = String(ctx.from.id);

  const response = await fetch(process.env.API_URL + '/api/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId, trader_tg_id })
  });
  const result = await response.json();

  if (result.ok) {
    ctx.reply(`✅ Заявка ${orderId} подтверждена! Комиссия: ${result.commission} RUB`);
  } else {
    ctx.reply('❌ ' + (result.error || 'Ошибка'));
  }
});

// === МОЙ БАЛАНС (трейдер) ===
bot.command('mybalance', async (ctx) => {
  const tg_id = String(ctx.from.id);
  const { data } = await supabase
    .from('traders')
    .select('deposit_usdt, insurance_usdt, total_earned_usdt, violations')
    .eq('tg_id', tg_id)
    .single();

  if (!data) return ctx.reply('Ты не зарегистрирован как трейдер.');
  ctx.reply(
    `💰 Твой баланс:\n` +
    `Рабочий: ${data.deposit_usdt} USDT\n` +
    `Страховой: ${data.insurance_usdt} USDT\n` +
    `Заработано: ${data.total_earned_usdt} USDT\n` +
    `Нарушений: ${data.violations}`
  );
});

// === МОЙ БАЛАНС (владелец) ===
bot.command('balance', async (ctx) => {
  if (String(ctx.from.id) !== process.env.OWNER_TG_ID) return ctx.reply('❌ Только владелец');
  const { data } = await supabase
    .from('merchants')
    .select('balance_usdt')
    .eq('tg_id', process.env.OWNER_TG_ID)
    .single();
  ctx.reply(`💰 Твой баланс: ${data?.balance_usdt || 0} USDT`);
});

// === ЗАМОРОЗИТЬ СТРАХОВКУ (владелец) ===
bot.command('freeze_insurance', async (ctx) => {
  if (String(ctx.from.id) !== process.env.OWNER_TG_ID) return ctx.reply('❌ Только владелец');
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Используй: /freeze_insurance @username СУММА ПРИЧИНА');

  const username = args[1].replace('@', '');
  const amount = parseFloat(args[2]);
  const reason = args.slice(3).join(' ') || 'нарушение';

  try {
    const user = await bot.telegram.getChat(username);
    const trader_tg_id = String(user.id);

    const response = await fetch(process.env.API_URL + '/api/insurance/freeze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': process.env.ADMIN_KEY
      },
      body: JSON.stringify({ trader_tg_id, amount_usdt: amount, reason })
    });
    const result = await response.json();
    if (result.ok) {
      ctx.reply(`🔒 Заморожено ${amount} USDT у @${username}. Остаток: ${result.remaining_insurance} USDT`);
    } else {
      ctx.reply('❌ ' + result.error);
    }
  } catch (e) {
    ctx.reply('❌ Пользователь не найден');
  }
});

bot.launch();
// Принудительно открываем порт для Render
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Bot is running');
}).listen(3000, () => {
  console.log('Bot is alive on port 3000');
});p
