const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function generateApiKey() {
  return 'pk_' + crypto.randomBytes(16).toString('hex');
}
function generateSecretKey() {
  return 'sk_' + crypto.randomBytes(24).toString('hex');
}

// === 1. СОЗДАНИЕ ЗАЯВКИ (казино) ===
app.post('/api/order', async (req, res) => {
  const { amount_rub, player_id } = req.body;
  const api_key = req.headers['x-api-key'];

  if (!api_key) return res.status(401).json({ error: 'API ключ обязателен' });
  if (!amount_rub || amount_rub < 100) return res.status(400).json({ error: 'Сумма минимум 100 RUB' });

  const { data: keyData } = await supabase
    .from('merchant_api_keys')
    .select('merchant_id, active')
    .eq('api_key', api_key)
    .eq('active', true)
    .single();

  if (!keyData) return res.status(403).json({ error: 'Невалидный ключ' });

  const { data: trader } = await supabase
    .from('traders')
    .select('*')
    .eq('active', true)
    .gt('deposit_usdt', 0)
    .limit(1)
    .single();

  if (!trader) return res.status(503).json({ error: 'Нет доступных трейдеров' });

  const firstCard = trader.cards[0] || { card: 'нет данных', bank: 'не указан' };
  const usdtRate = 92.5;
  const amount_usdt = (amount_rub / usdtRate).toFixed(2);

  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      merchant_id: keyData.merchant_id,
      trader_id: trader.id,
      amount_rub,
      amount_usdt,
      trader_card_data: firstCard,
      player_id,
      status: 'waiting'
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Ошибка создания заявки' });

  await fetch(process.env.BOT_API_URL + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: trader.tg_id,
      text: `🆕 Новая заявка #${order.id}\nСумма: ${amount_rub} RUB\nИгрок: ${player_id || 'не указан'}\nПодтверди: /confirm ${order.id}`
    })
  });

  res.json({
    order_id: order.id,
    amount: amount_rub,
    card: firstCard.card,
    bank: firstCard.bank,
    status: 'waiting'
  });
});

// === 2. ПОДТВЕРЖДЕНИЕ ОПЛАТЫ (трейдер) ===
app.post('/api/confirm', async (req, res) => {
  const { order_id, trader_tg_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id обязателен' });

  const { data: order } = await supabase
    .from('orders')
    .select('*, traders(tg_id, partner_id, commission_percent, deposit_usdt)')
    .eq('id', order_id)
    .single();

  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  if (order.traders.tg_id !== trader_tg_id) {
    return res.status(403).json({ error: 'Не твоя заявка' });
  }

  await supabase
    .from('orders')
    .update({ status: 'confirmed', confirmed_at: new Date() })
    .eq('id', order_id);

  const commissionAmount = (order.amount_rub * order.traders.commission_percent) / 100;
  await supabase.rpc('add_balance', {
    p_tg_id: process.env.OWNER_TG_ID,
    p_amount: commissionAmount
  });

  await supabase
    .from('traders')
    .update({ total_earned_usdt: supabase.raw('total_earned_usdt + ?', [commissionAmount]) })
    .eq('id', order.trader_id);

  const { data: merchant } = await supabase
    .from('merchants')
    .select('webhook_url')
    .eq('id', order.merchant_id)
    .single();

  if (merchant && merchant.webhook_url) {
    await fetch(merchant.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: order.id,
        player_id: order.player_id,
        amount_usdt: order.amount_usdt,
        amount_rub: order.amount_rub,
        status: 'success'
      })
    });
  }

  res.json({ ok: true, commission: commissionAmount });
});

// === 3. ДЕПОЗИТ: запрос ===
app.post('/api/deposit/request', async (req, res) => {
  const { trader_tg_id, amount_usdt = 100 } = req.body;

  const { data: trader } = await supabase
    .from('traders')
    .select('id')
    .eq('tg_id', trader_tg_id)
    .single();

  if (!trader) return res.status(404).json({ error: 'Трейдер не найден' });

  const depositAddress = '0xВашUSDTАдресДляПриема';

  const { data: deposit } = await supabase
    .from('deposits')
    .insert({
      trader_id: trader.id,
      amount_usdt: amount_usdt,
      type: 'working'
    })
    .select()
    .single();

  res.json({
    deposit_id: deposit.id,
    address: depositAddress,
    amount: amount_usdt,
    memo: `DEPOSIT_${deposit.id}_${trader.id}`,
    status: 'pending'
  });
});

// === 4. ДЕПОЗИТ: подтверждение (админ) ===
app.post('/api/deposit/confirm', async (req, res) => {
  const { deposit_id, tx_hash } = req.body;
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Доступ только админу' });
  }

  const { data: deposit } = await supabase
    .from('deposits')
    .select('*, traders(tg_id)')
    .eq('id', deposit_id)
    .single();

  if (!deposit) return res.status(404).json({ error: 'Депозит не найден' });

  await supabase
    .from('deposits')
    .update({ status: 'confirmed', confirmed_at: new Date(), tx_hash })
    .eq('id', deposit_id);

  const half = deposit.amount_usdt / 2;
  await supabase.rpc('add_trader_balance', {
    p_trader_id: deposit.trader_id,
    p_working: half,
    p_insurance: half
  });

  await fetch(process.env.BOT_API_URL + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: deposit.traders.tg_id,
      text: `✅ Депозит ${deposit.amount_usdt} USDT подтверждён!\nРабочий: ${half} USDT\nСтраховой: ${half} USDT`
    })
  });

  res.json({ ok: true });
});

// === 5. ЗАМОРОЗКА СТРАХОВКИ (админ) ===
app.post('/api/insurance/freeze', async (req, res) => {
  const { trader_tg_id, amount_usdt, reason } = req.body;
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Только админ' });
  }

  const { data: trader } = await supabase
    .from('traders')
    .select('id, insurance_usdt, violations')
    .eq('tg_id', trader_tg_id)
    .single();

  if (!trader) return res.status(404).json({ error: 'Трейдер не найден' });
  if (trader.insurance_usdt < amount_usdt) {
    return res.status(400).json({ error: 'Недостаточно страховки' });
  }

  await supabase
    .from('traders')
    .update({
      insurance_usdt: trader.insurance_usdt - amount_usdt,
      violations: trader.violations + 1,
      deposit_frozen: trader.violations + 1 >= 3 ? true : false
    })
    .eq('id', trader.id);

  await supabase
    .from('insurance_claims')
    .insert({
      trader_id: trader.id,
      amount_usdt,
      reason,
      status: 'approved'
    });

  res.json({ ok: true, remaining_insurance: trader.insurance_usdt - amount_usdt });
});

// === 6. СОЗДАНИЕ МЕРЧАНТА (админ) ===
app.post('/api/merchant/create', async (req, res) => {
  const { tg_id, name, webhook_url, commission_percent = 3 } = req.body;
  if (tg_id !== process.env.OWNER_TG_ID) {
    return res.status(403).json({ error: 'Доступ только владельцу' });
  }

  const api_key = generateApiKey();
  const secret_key = generateSecretKey();

  const { data: merchant } = await supabase
    .from('merchants')
    .insert({ tg_id, name, webhook_url, commission_percent })
    .select()
    .single();

  await supabase
    .from('merchant_api_keys')
    .insert({
      merchant_id: merchant.id,
      api_key,
      secret_key
    });

  res.json({ merchant, api_key, secret_key });
});

app.listen(3000, () => console.log('API запущен'));
