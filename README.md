# Wapify — Production Deployment Guide
## WhatsApp Business SaaS · Complete Stack

---

## 📁 What's in this package

```
wapify/
├── backend/
│   ├── server.js              ← Express API entry point
│   ├── package.json           ← All npm dependencies
│   ├── .env.example           ← Copy to .env and fill in
│   ├── config/
│   │   ├── db.js              ← PostgreSQL connection pool
│   │   ├── redis.js           ← Redis client
│   │   ├── logger.js          ← Winston logger
│   │   └── permissions.js     ← RBAC permission definitions
│   ├── middleware/
│   │   └── auth.js            ← JWT auth + permission checker
│   ├── routes/
│   │   ├── auth.js            ← Login, signup, refresh, logout
│   │   ├── stores.js          ← Store connections + webhooks
│   │   ├── orders.js          ← Order management
│   │   ├── conversations.js   ← WA conversations + replies
│   │   ├── flows.js           ← Automation flows CRUD
│   │   ├── analytics.js       ← Analytics queries
│   │   ├── billing.js         ← Stripe subscriptions + webhooks
│   │   ├── team.js            ← Team members + RBAC roles
│   │   ├── whatsapp.js        ← Meta Cloud API + webhook
│   │   └── admin.js           ← CEO admin panel API
│   └── services/
│       ├── meta.js            ← Meta WhatsApp Cloud API wrapper
│       ├── waQueue.js         ← BullMQ job queue (WA sending)
│       └── email.js           ← Nodemailer transactional email
├── database/
│   ├── schema.sql             ← Full PostgreSQL schema (all tables)
│   ├── migrate.js             ← Runs schema.sql
│   └── seed.js                ← Default roles, admin, demo org
├── frontend/
│   └── public/
│       ├── index.html         ← Customer SaaS app (full RBAC)
│       └── admin.html         ← CEO admin dashboard
├── nginx.conf                 ← Production Nginx config
├── ecosystem.config.js        ← PM2 process manager config
├── deploy.sh                  ← One-command server setup
└── README.md                  ← This file
```

---

## 🗄️ Database Tables

| Table | Purpose |
|---|---|
| organizations | Each customer = 1 org (plan, quota, Stripe) |
| users | All team members with role + org link |
| roles | 5 system roles per org + custom roles |
| refresh_tokens | JWT refresh token rotation |
| stores | Shopify/WooCommerce/BigCommerce connections |
| whatsapp_numbers | Verified WA numbers via Meta Cloud API |
| customers | End customers (store buyers) |
| orders | All orders with WA confirmation status |
| conversations | WA conversation threads |
| messages | Individual WA messages (in/out) |
| flows | Automation flow definitions |
| templates | Meta-approved WA message templates |
| products | Catalogue synced from stores |
| broadcasts | Bulk WA campaign results |
| audit_logs | Full action audit trail |
| admin_users | CEO admin panel users |
| announcements | In-app announcements |
| feature_flags | Feature toggles per plan |

---

## 🔐 Role-Based Access Control (RBAC)

5 system roles are auto-created for every new organization:

| Role | What they can do |
|---|---|
| **Owner** | Everything — billing, team, settings, all modules |
| **Admin** | Everything except delete/billing management |
| **Marketing** | Flows, templates, broadcasts, catalogue, analytics |
| **Sales** | Orders, conversations, basic analytics |
| **Support** | Conversations + orders only, no config |

Custom roles can also be created with any permission combination.

Permissions are checked on **every API route** and **every UI element**.
If a user lacks permission, buttons are hidden and API returns 403.

---

## 🚀 STEP-BY-STEP DEPLOYMENT

### Prerequisites
- Ubuntu 22.04 VPS (DigitalOcean $12/mo, Hetzner €4/mo, or any)
- A domain name pointed to your server IP
- SSH access to the server

---

### STEP 1 — Upload files to server

On your local machine (in the wapify folder):
```bash
# Compress
zip -r wapify.zip .

# Upload to server
scp wapify.zip root@YOUR_SERVER_IP:/tmp/
ssh root@YOUR_SERVER_IP "cd /tmp && unzip wapify.zip -d wapify"
```

---

### STEP 2 — Run the deploy script

```bash
ssh root@YOUR_SERVER_IP

# Edit the domain in deploy.sh first
nano /tmp/wapify/deploy.sh
# Change: DOMAIN="yourdomain.com"
# Change: ADMIN_DOMAIN="admin.yourdomain.com"
# Change: EMAIL="you@yourdomain.com"

# Run it
chmod +x /tmp/wapify/deploy.sh
bash /tmp/wapify/deploy.sh
```

This automatically:
- Installs Node.js 20, Nginx, PostgreSQL, Redis, Certbot
- Creates the database and user
- Copies all files to /var/www/wapify
- Generates a .env with random secrets
- Runs database migrations and seeds
- Configures Nginx with HTTPS
- Gets free SSL certificates
- Starts the app with PM2 (clustered)
- Sets PM2 to auto-start on reboot

---

### STEP 3 — Fill in your API keys

```bash
nano /var/www/wapify/backend/.env
```

Required keys to fill in:

**Meta WhatsApp:**
1. Go to developers.facebook.com → Create App → Business → WhatsApp
2. Get: META_APP_ID, META_APP_SECRET
3. Create a System User in Meta Business Manager → get permanent token
4. Set META_SYSTEM_USER_TOKEN to that token

**Stripe:**
1. Go to stripe.com → Developers → API Keys
2. Copy STRIPE_SECRET_KEY (sk_live_...)
3. Create Products and Prices for each plan → copy price IDs
4. Set up webhook endpoint: https://yourdomain.com/api/billing/webhook
5. Copy STRIPE_WEBHOOK_SECRET (whsec_...)

**Email (Brevo - free 300/day):**
1. Go to brevo.com → Sign up free
2. Settings → SMTP & API → Generate SMTP key
3. Fill in SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS

**After filling .env:**
```bash
pm2 restart all
pm2 logs wapify-api   # verify no errors
```

---

### STEP 4 — Shopify App Setup (for Shopify OAuth)

1. Go to partners.shopify.com → Create app → Public app
2. App URL: https://yourdomain.com
3. Allowed redirect URLs: https://yourdomain.com/api/stores/shopify/callback
4. Copy API key and secret to .env
5. Optional: Submit to Shopify App Store for organic traffic

---

### STEP 5 — Verify everything works

```bash
# Check API is running
curl https://yourdomain.com/api/health

# Check PM2 processes
pm2 list
pm2 logs

# Test login
# Open https://yourdomain.com
# Login: demo@wapify.com / Demo@123456
# Admin: https://admin.yourdomain.com
# Admin login: admin@yourdomain.com / ChangeMe@FirstLogin123
```

---

### STEP 6 — Security hardening

```bash
# 1. Change admin password IMMEDIATELY
# Login to admin panel → Settings → Change password

# 2. Restrict admin panel to your IP
nano /etc/nginx/sites-available/wapify
# Uncomment these lines and add your IP:
#   allow YOUR.IP.ADDRESS;
#   deny all;
nginx -t && systemctl reload nginx

# 3. Setup UFW firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# 4. Auto SSL renewal (already set up by certbot)
certbot renew --dry-run
```

---

## 🔧 Common Commands

```bash
# Restart after .env changes
pm2 restart all

# View live logs
pm2 logs wapify-api
pm2 logs wapify-worker

# Monitor processes
pm2 monit

# Reload Nginx
nginx -t && systemctl reload nginx

# Database backup
pg_dump -U wapify_user wapify > backup_$(date +%Y%m%d).sql

# Update app files
scp index.html root@SERVER:/var/www/wapify/frontend/public/
scp admin.html root@SERVER:/var/www/wapify/frontend/public/
# No restart needed for HTML changes

# Update backend
scp -r backend/ root@SERVER:/var/www/wapify/
ssh root@SERVER "cd /var/www/wapify/backend && npm install && pm2 restart wapify-api"
```

---

## 💰 Hosting Cost Summary

| Service | Provider | Cost |
|---|---|---|
| VPS (2 CPU, 4GB) | Hetzner CX21 | €5/mo |
| Domain | Namecheap | ~$10/yr |
| SSL | Let's Encrypt | Free |
| PostgreSQL | On VPS | Included |
| Redis | On VPS | Included |
| Email (300/day) | Brevo | Free |
| Meta WhatsApp API | Meta | Pay per msg |
| Stripe | Stripe | 2.9% + $0.30 |

**Total infrastructure: ~$7/month** to start

---

## 📊 Tech Stack

```
Frontend:   Pure HTML/CSS/JS (no framework, instant load)
Backend:    Node.js 22 + Express
Database:   PostgreSQL 15
Cache/Queue: Redis + BullMQ
Auth:       JWT (access + refresh tokens, RBAC)
WA API:     Meta Cloud API (official)
Payments:   Stripe Subscriptions
Email:      Brevo/SendGrid via Nodemailer
Process:    PM2 cluster mode
Web server: Nginx (reverse proxy + static files)
SSL:        Let's Encrypt (auto-renew)
```

---

## 🆘 Troubleshooting

**App not starting:**
```bash
pm2 logs wapify-api --lines 50
# Usually: missing .env key or DB connection failed
```

**Database connection error:**
```bash
psql -U wapify_user -d wapify -h localhost
# Check DATABASE_URL in .env
```

**Nginx 502 Bad Gateway:**
```bash
pm2 list   # check if app is running
pm2 restart all
```

**SSL certificate error:**
```bash
certbot renew --force-renewal
systemctl reload nginx
```

**Meta webhook not receiving:**
```bash
# Check META_VERIFY_TOKEN matches what you set in Meta Developer Console
# Webhook URL must be: https://yourdomain.com/api/whatsapp/webhook
```
