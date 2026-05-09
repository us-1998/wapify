const Bull = require('bull');
const { query } = require('../config/db');
const meta = require('./meta');

const waQueue = new Bull('whatsapp', { redis: process.env.REDIS_URL || 'redis://localhost:6379' });

const add = (name, data, opts = {}) => waQueue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, ...opts });

waQueue.process('new_order', async (job) => {
  const { storeId, orgId, order, platform } = job.data;
  const store = await query('SELECT * FROM stores WHERE id=$1', [storeId]);
  if (!store.rows.length || !store.rows[0].auto_cod_confirm) return;

  const phone = platform === 'woocommerce'
    ? (order.billing?.phone)
    : (order.billing_address?.phone || order.phone || order.customer?.phone);
  if (!phone) return;

  const waNum = await query("SELECT * FROM whatsapp_numbers WHERE org_id=$1 AND status='active'", [orgId]);
  if (!waNum.rows.length) return;

  const firstName = platform === 'woocommerce'
    ? (order.billing?.first_name || 'Customer')
    : (order.billing_address?.first_name || 'Customer');
  const orderNum = order.name || order.order_number || `#${order.number || order.id}`;
  const total = order.total_price || order.total || '0';
  const currency = order.currency || 'PKR';

  const lang = meta.detectLanguage(phone);
  const msgs = {
    en: `Hi ${firstName}! 👋\nYour order ${orderNum} for ${currency} ${total} has been placed.\nPayment: Cash on Delivery\nPlease confirm your order:`,
    ur: `السلام علیکم ${firstName}! 👋\nآپ کا آرڈر ${orderNum} کے لیے ${currency} ${total} موصول ہوا ہے۔\nادائیگی: کیش آن ڈلیوری\nبراہ کرم اپنے آرڈر کی تصدیق کریں:`,
    hi: `नमस्ते ${firstName}! 👋\nआपका ऑर्डर ${orderNum} ₹${total} के लिए मिल गया।\nभुगतान: कैश ऑन डिलीवरी\nकृपया अपना ऑर्डर कन्फर्म करें:`,
    ar: `مرحباً ${firstName}! 👋\nتم استلام طلبك ${orderNum} بمبلغ ${currency} ${total}.\nالدفع: الدفع عند الاستلام\nيرجى تأكيد طلبك:`,
  };
  const msg = msgs[lang] || msgs.en;

  // Upsert customer
  const cRes = await query(`INSERT INTO customers (org_id,store_id,external_id,phone,name,language)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id,phone)
    DO UPDATE SET name=EXCLUDED.name, updated_at=NOW() RETURNING id`,
    [orgId, storeId, String(order.customer?.id || order.id), phone, firstName, lang]);

  // Upsert order
  const isCOD = platform === 'woocommerce'
    ? order.payment_method === 'cod'
    : (order.payment_gateway || '').toLowerCase().includes('cod') || (order.payment_gateway || '').toLowerCase().includes('cash');

  await query(`INSERT INTO orders (org_id,store_id,customer_id,external_id,order_number,status,payment_method,total,currency,line_items)
    VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9::jsonb)
    ON CONFLICT (store_id,external_id) DO NOTHING`,
    [orgId, storeId, cRes.rows[0].id, String(order.id), orderNum,
     isCOD ? 'cod' : 'prepaid', parseFloat(total) || 0, currency,
     JSON.stringify(order.line_items || order.line_items || [])]).catch(()=>{});

  // Only send WA for COD
  if (!isCOD) return;

  try {
    await meta.sendInteractive(waNum.rows[0].phone_number_id, phone, msg, ['✅ Confirm order', '❌ Cancel order']);
    await query(`UPDATE orders SET wa_status='sent' WHERE store_id=$1 AND external_id=$2`, [storeId, String(order.id)]);
    await query('UPDATE organizations SET msg_used=msg_used+1 WHERE id=$1', [orgId]);
  } catch (err) {
    await query(`UPDATE orders SET wa_status='failed' WHERE store_id=$1 AND external_id=$2`, [storeId, String(order.id)]);
    throw err;
  }
});

waQueue.process('incoming_message', async (job) => {
  const { payload } = job.data;
  const waId = payload.metadata?.phone_number_id;
  const waNum = await query('SELECT * FROM whatsapp_numbers WHERE phone_number_id=$1', [waId]);
  if (!waNum.rows.length) return;
  const orgId = waNum.rows[0].org_id;

  for (const msg of payload.messages || []) {
    let cv = await query('SELECT id FROM conversations WHERE wa_contact_id=$1 AND org_id=$2', [msg.from, orgId]);
    if (!cv.rows.length) {
      const cust = await query("SELECT id FROM customers WHERE org_id=$1 AND phone LIKE $2", [orgId, `%${msg.from.slice(-9)}`]);
      cv = await query(`INSERT INTO conversations (org_id,customer_id,whatsapp_number_id,wa_contact_id,status)
        VALUES ($1,$2,$3,$4,'open') RETURNING id`,
        [orgId, cust.rows[0]?.id || null, waNum.rows[0].id, msg.from]);
    }
    const cvId = cv.rows[0].id;
    const content = msg.text?.body || msg.button?.text || '[media]';

    await query(`INSERT INTO messages (org_id,conversation_id,wa_message_id,direction,type,content)
      VALUES ($1,$2,$3,'inbound',$4,$5)`,
      [orgId, cvId, msg.id, msg.type, content]).catch(()=>{});

    await query(`UPDATE conversations SET last_message=$1, last_message_at=NOW(), unread_count=unread_count+1 WHERE id=$2`, [content, cvId]);

    // Handle button replies
    if (msg.type === 'button') {
      const txt = (msg.button?.text || '').toLowerCase();
      if (txt.includes('confirm')) {
        const ord = await query(`UPDATE orders SET wa_confirmed=true,wa_confirmed_at=NOW(),status='confirmed',wa_status='replied'
          WHERE customer_id IN (SELECT id FROM customers WHERE org_id=$1 AND phone LIKE $2)
          AND wa_confirmed IS NULL RETURNING order_number`,
          [orgId, `%${msg.from.slice(-9)}`]);
        if (ord.rows.length) {
          await meta.sendText(waId, msg.from, `Great! 🎉 Order ${ord.rows[0].order_number} confirmed. We'll dispatch within 24 hours. Thank you!`);
        }
      } else if (txt.includes('cancel')) {
        await meta.sendText(waId, msg.from, `Your order has been cancelled. If this was a mistake, please contact us or place a new order.`);
      }
    }

    await meta.markRead(waId, msg.id).catch(()=>{});
  }

  // Status updates
  for (const status of payload.statuses || []) {
    if (status.status === 'delivered') {
      await query(`UPDATE messages SET status='delivered', delivered_at=NOW() WHERE wa_message_id=$1`, [status.id]).catch(()=>{});
    } else if (status.status === 'read') {
      await query(`UPDATE messages SET status='read', read_at=NOW() WHERE wa_message_id=$1`, [status.id]).catch(()=>{});
    } else if (status.status === 'failed') {
      await query(`UPDATE messages SET status='failed', error=$1 WHERE wa_message_id=$2`,
        [JSON.stringify(status.errors || []), status.id]).catch(()=>{});
    }
  }
});

waQueue.process('send_wa', async (job) => {
  const { orderId, orgId } = job.data;
  const ord = await query('SELECT o.*,c.phone,c.language FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=$1', [orderId]);
  if (!ord.rows.length) return;
  const o = ord.rows[0];
  const waNum = await query(`SELECT wa.* FROM whatsapp_numbers wa JOIN stores s ON s.whatsapp_number_id=wa.id WHERE s.id=$1 AND wa.status='active'`, [o.store_id]);
  if (!waNum.rows.length) return;
  await meta.sendInteractive(waNum.rows[0].phone_number_id, o.phone,
    `Reminder: Your order ${o.order_number} for ${o.currency} ${o.total} needs confirmation.`,
    ['✅ Confirm order', '❌ Cancel order']);
  await query("UPDATE orders SET wa_status='sent', retry_count=retry_count+1 WHERE id=$1", [orderId]);
  await query('UPDATE organizations SET msg_used=msg_used+1 WHERE id=$1', [orgId]);
});

waQueue.on('failed', (job, err) => console.error(`Queue ${job.name} failed:`, err.message));
waQueue.on('completed', (job) => console.log(`Queue ${job.name} done`));

module.exports = { add, waQueue };
