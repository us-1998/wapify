// routes/billing.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

const PLAN_PRICES = {
  growth_monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
  growth_annual:  process.env.STRIPE_PRICE_GROWTH_ANNUAL,
  scale_monthly:  process.env.STRIPE_PRICE_SCALE_MONTHLY,
  scale_annual:   process.env.STRIPE_PRICE_SCALE_ANNUAL,
  agency_monthly: process.env.STRIPE_PRICE_AGENCY_MONTHLY,
  agency_annual:  process.env.STRIPE_PRICE_AGENCY_ANNUAL,
};

const PLAN_QUOTAS = {
  free:   { msg: 100,    stores: 1  },
  growth: { msg: 5000,   stores: 3  },
  scale:  { msg: 20000,  stores: 10 },
  agency: { msg: 999999, stores: 99 },
};

router.get('/current', requirePermission('billing:view'), async (req, res) => {
  const org = await query('SELECT * FROM organizations WHERE id=$1', [req.user.org_id]);
  res.json({ billing: org.rows[0] });
});

router.post('/checkout', requirePermission('billing:manage'), async (req, res) => {
  const { plan, interval = 'monthly' } = req.body;
  const priceKey = `${plan}_${interval}`;
  const priceId = PLAN_PRICES[priceKey];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan or interval' });

  const org = await query('SELECT * FROM organizations WHERE id=$1', [req.user.org_id]);
  let customerId = org.rows[0].stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email, name: org.rows[0].name, metadata: { org_id: req.user.org_id } });
    customerId = customer.id;
    await query('UPDATE organizations SET stripe_customer_id=$1 WHERE id=$2', [customerId, req.user.org_id]);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/billing?success=true`,
    cancel_url: `${process.env.APP_URL}/billing`,
    metadata: { org_id: req.user.org_id, plan },
  });
  res.json({ url: session.url });
});

router.post('/portal', requirePermission('billing:manage'), async (req, res) => {
  const org = await query('SELECT stripe_customer_id FROM organizations WHERE id=$1', [req.user.org_id]);
  if (!org.rows[0]?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });
  const session = await stripe.billingPortal.sessions.create({
    customer: org.rows[0].stripe_customer_id,
    return_url: `${process.env.APP_URL}/billing`,
  });
  res.json({ url: session.url });
});

// Stripe webhook — must be BEFORE express.json() middleware
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch { return res.sendStatus(400); }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const orgId = session.metadata?.org_id;
      const plan = session.metadata?.plan;
      if (orgId && plan) {
        const quotas = PLAN_QUOTAS[plan] || PLAN_QUOTAS.growth;
        await query(`UPDATE organizations SET plan=$1, plan_status='active',
          stripe_subscription_id=$2, msg_quota=$3, max_stores=$4
          WHERE id=$5`, [plan, session.subscription, quotas.msg, quotas.stores, orgId]);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await query(`UPDATE organizations SET plan='free', plan_status='cancelled',
        msg_quota=100, max_stores=1 WHERE stripe_subscription_id=$1`, [sub.id]);
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      await query(`UPDATE organizations SET plan_status='past_due' WHERE stripe_customer_id=$1`, [inv.customer]);
      break;
    }
    case 'invoice.paid': {
      const inv = event.data.object;
      await query(`UPDATE organizations SET plan_status='active', msg_used=0 WHERE stripe_customer_id=$1`, [inv.customer]);
      break;
    }
  }
  res.sendStatus(200);
});

module.exports = router;
