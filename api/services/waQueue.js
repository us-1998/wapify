// services/waQueue.js — BullMQ-style job queue for WhatsApp messages
const Bull = require('bull');
const { query } = require('../config/db');
const metaService = require('./meta');
const logger = require('../config/logger');

const waQueue = new Bull('whatsapp', { redis: process.env.REDIS_URL });

// ── ADD JOBS ──────────────────────────────────────────────────
const add = (name, data, opts = {}) => waQueue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, ...opts });

// ── PROCESS JOBS ──────────────────────────────────────────────
waQueue.process('new_order', async (job) => {
  const { storeId, orgId, order } = job.data;
  const store = await query('SELECT * FROM stores WHERE id=$1', [storeId]);
  if (!store.rows.length || !store.rows[0].auto_cod_confirm) return;
  if (order.financial_status !== 'pending' && order.payment_gateway !== 'Cash on Delivery') return;

  const waNumber = await query('SELECT * FROM whatsapp_numbers WHERE id=$1 AND status=$2',
    [store.rows[0].whatsapp_number_id, 'active']);
  if (!waNumber.rows.length) return;

  // Upsert customer
  const phone = order.billing_address?.phone || order.phone;
  if (!phone) return;
  const customerRes = await query(`INSERT INTO customers (org_id, store_id, external_id, phone, name, email, language)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, phone) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    [orgId, storeId, String(order.id), phone, `${order.billing_address?.first_name} ${order.billing_address?.last_name}`.trim(),
     order.email, metaService.detectLanguage(phone)]);
  const customerId = customerRes.rows[0].id;

  // Upsert order
  await query(`INSERT INTO orders (org_id, store_id, customer_id, external_id, order_number, status, payment_method, total, currency, line_items, shipping_address)
    VALUES ($1,$2,$3,$4,$5,'pending','cod',$6,$7,$8::jsonb,$9::jsonb)
    ON CONFLICT (store_id, external_id) DO NOTHING`,
    [orgId, storeId, customerId, String(order.id), order.order_number || `#${order.id}`,
     order.total_price, order.currency || 'PKR', JSON.stringify(order.line_items || []),
     JSON.stringify(order.billing_address || {})]);

  // Send WA confirmation
  const lang = metaService.detectLanguage(phone);
  const msgs = {
    en: `Hi ${order.billing_address?.first_name}! 👋\nYour order #${order.order_number} for ${order.currency} ${order.total_price} is placed.\nPayment: Cash on Delivery`,
    ur: `السلام علیکم ${order.billing_address?.first_name}! 👋\nآپ کا آرڈر #${order.order_number} کے لیے ${order.currency} ${order.total_price} موصول ہوا۔\nادائیگی: کیش آن ڈلیوری`,
    hi: `नमस्ते ${order.billing_address?.first_name}! 👋\nआपका ऑर्डर #${order.order_number} ${order.currency} ${order.total_price} के लिए रखा गया।\nभुगतान: कैश ऑन डिलीवरी`,
    ar: `مرحباً ${order.billing_address?.first_name}! 👋\nطلبك رقم #${order.order_number} بمبلغ ${order.currency} ${order.total_price} تم استلامه.\nالدفع: الدفع عند الاستلام`,
  };
  const msgText = msgs[lang] || msgs.en;

  try {
    await metaService.sendInteractive(waNumber.rows[0].phone_number_id, phone, msgText, ['✅ Confirm order', '❌ Cancel order']);
    await query(`UPDATE orders SET wa_status='sent' WHERE store_id=$1 AND external_id=$2`, [storeId, String(order.id)]);
    await query('UPDATE organizations SET msg_used=msg_used+1 WHERE id=$1', [orgId]);
  } catch (err) {
    logger.error('WA send failed:', err.message);
    await query(`UPDATE orders SET wa_status='failed' WHERE store_id=$1 AND external_id=$2`, [storeId, String(order.id)]);
    throw err; // triggers retry
  }
});

waQueue.process('incoming_message', async (job) => {
  const { payload } = job.data;
  for (const msg of payload.messages || []) {
    const waId = payload.metadata?.phone_number_id;
    const waNum = await query('SELECT * FROM whatsapp_numbers WHERE phone_number_id=$1', [waId]);
    if (!waNum.rows.length) continue;
    const orgId = waNum.rows[0].org_id;

    // Find or create conversation
    let cv = await query('SELECT id FROM conversations WHERE wa_contact_id=$1 AND org_id=$2', [msg.from, orgId]);
    if (!cv.rows.length) {
      const cust = await query('SELECT id FROM customers WHERE org_id=$1 AND phone LIKE $2', [orgId, `%${msg.from.slice(-9)}`]);
      cv = await query(`INSERT INTO conversations (org_id, customer_id, whatsapp_number_id, wa_contact_id, status)
        VALUES ($1,$2,$3,$4,'open') RETURNING id`, [orgId, cust.rows[0]?.id, waNum.rows[0].id, msg.from]);
    }
    const cvId = cv.rows[0].id;

    // Save message
    await query(`INSERT INTO messages (org_id, conversation_id, wa_message_id, direction, type, content)
      VALUES ($1,$2,$3,'inbound',$4,$5)`,
      [orgId, cvId, msg.id, msg.type, msg.text?.body || msg.button?.text || '[media]']);

    await query(`UPDATE conversations SET last_message=$1, last_message_at=NOW(), unread_count=unread_count+1 WHERE id=$2`,
      [msg.text?.body || '[media]', cvId]);

    // Handle button replies (COD confirmation)
    if (msg.type === 'button') {
      const btnText = msg.button?.text?.toLowerCase();
      if (btnText?.includes('confirm')) {
        const order = await query(`UPDATE orders SET wa_confirmed=true, wa_confirmed_at=NOW(), status='confirmed', wa_status='replied'
          WHERE customer_id IN (SELECT id FROM customers WHERE org_id=$1 AND phone LIKE $2) AND wa_confirmed IS NULL
          RETURNING id, order_number`, [orgId, `%${msg.from.slice(-9)}`]);
        if (order.rows.length) {
          await metaService.sendTextMessage(waId, msg.from, `Great! 🎉 Order ${order.rows[0].order_number} confirmed. We'll dispatch within 24 hours. Thank you!`);
        }
      } else if (btnText?.includes('cancel')) {
        await metaService.sendTextMessage(waId, msg.from, `Order cancelled. If this was a mistake, please contact us or place a new order. Sorry for the inconvenience.`);
      }
    }

    // Mark as read
    await metaService.markRead(waId, msg.id).catch(() => {});
  }

  // Handle status updates
  for (const status of payload.statuses || []) {
    const statusMap = { delivered: 'delivered', read: 'read', failed: 'failed' };
    if (statusMap[status.status]) {
      await query(`UPDATE messages SET status=$1, ${status.status === 'delivered' ? 'delivered_at' : status.status === 'read' ? 'read_at' : 'updated_at'}=NOW()
        WHERE wa_message_id=$2`, [statusMap[status.status], status.id]);
    }
  }
});

waQueue.process('send_wa', async (job) => {
  const { order, orgId } = job.data;
  const waNum = await query(`SELECT wa.* FROM whatsapp_numbers wa
    JOIN stores s ON s.whatsapp_number_id=wa.id WHERE s.id=$1 AND wa.status='active'`, [order.store_id]);
  if (!waNum.rows.length) return;
  const cust = await query('SELECT * FROM customers WHERE id=$1', [order.customer_id]);
  if (!cust.rows.length) return;
  const phone = cust.rows[0].phone;
  const lang = cust.rows[0].language || 'en';
  const msgText = `Hi! Reminder for your order ${order.order_number} — ${order.currency} ${order.total}. Please confirm: ✅ or ❌`;
  await metaService.sendInteractive(waNum.rows[0].phone_number_id, phone, msgText, ['✅ Confirm order', '❌ Cancel order']);
  await query('UPDATE orders SET wa_status=$1, retry_count=retry_count+1 WHERE id=$2', ['sent', order.id]);
  await query('UPDATE organizations SET msg_used=msg_used+1 WHERE id=$1', [orgId]);
});

waQueue.on('failed', (job, err) => logger.error(`Queue job ${job.name} failed:`, err.message));
waQueue.on('completed', (job) => logger.debug(`Queue job ${job.name} done`));

module.exports = { add, waQueue };
