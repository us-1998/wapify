-- ============================================================
--  WAPIFY — Complete PostgreSQL Database Schema
--  Run: psql -U postgres -d wapify -f schema.sql
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────
--  ORGANIZATIONS (each paying customer = 1 org)
-- ──────────────────────────────────────────
CREATE TABLE organizations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(100) UNIQUE NOT NULL,
  plan            VARCHAR(50) NOT NULL DEFAULT 'free' CHECK (plan IN ('free','growth','scale','agency')),
  plan_status     VARCHAR(50) NOT NULL DEFAULT 'trial' CHECK (plan_status IN ('trial','active','past_due','cancelled','paused')),
  trial_ends_at   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  stripe_customer_id    VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255) UNIQUE,
  billing_email   VARCHAR(255),
  msg_quota       INTEGER NOT NULL DEFAULT 100,
  msg_used        INTEGER NOT NULL DEFAULT 0,
  max_stores      INTEGER NOT NULL DEFAULT 1,
  logo_url        TEXT,
  timezone        VARCHAR(100) DEFAULT 'UTC',
  country         VARCHAR(10),
  currency        VARCHAR(10) DEFAULT 'USD',
  settings        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  ROLES
-- ──────────────────────────────────────────
CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(100) NOT NULL,
  description TEXT,
  is_system   BOOLEAN DEFAULT FALSE,  -- system roles can't be deleted
  permissions JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, slug)
);

-- ──────────────────────────────────────────
--  USERS
-- ──────────────────────────────────────────
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID REFERENCES organizations(id) ON DELETE CASCADE,
  role_id           UUID REFERENCES roles(id) ON DELETE SET NULL,
  email             VARCHAR(255) UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  first_name        VARCHAR(100),
  last_name         VARCHAR(100),
  phone             VARCHAR(30),
  avatar_url        TEXT,
  is_owner          BOOLEAN DEFAULT FALSE,   -- org creator
  is_active         BOOLEAN DEFAULT TRUE,
  is_email_verified BOOLEAN DEFAULT FALSE,
  email_verify_token TEXT,
  password_reset_token TEXT,
  password_reset_expires TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  last_login_ip     INET,
  two_fa_enabled    BOOLEAN DEFAULT FALSE,
  two_fa_secret     TEXT,
  preferences       JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  REFRESH TOKENS
-- ──────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  ip_address  INET,
  user_agent  TEXT,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  STORES
-- ──────────────────────────────────────────
CREATE TABLE stores (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name                VARCHAR(255) NOT NULL,
  platform            VARCHAR(50) NOT NULL CHECK (platform IN ('shopify','woocommerce','bigcommerce','custom')),
  domain              VARCHAR(255),
  status              VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending','connected','error','disconnected')),
  -- Shopify
  shopify_shop        VARCHAR(255),
  shopify_access_token TEXT,
  shopify_webhook_secret TEXT,
  -- WooCommerce
  woo_url             TEXT,
  woo_consumer_key    TEXT,
  woo_consumer_secret TEXT,
  -- BigCommerce
  bc_store_hash       VARCHAR(100),
  bc_access_token     TEXT,
  -- Custom
  webhook_secret      TEXT,
  -- Whatsapp assignment
  whatsapp_number_id  UUID,
  -- Automation toggles
  auto_cod_confirm    BOOLEAN DEFAULT TRUE,
  auto_tracking       BOOLEAN DEFAULT TRUE,
  auto_cart_recovery  BOOLEAN DEFAULT FALSE,
  auto_review_request BOOLEAN DEFAULT FALSE,
  -- Stats
  total_orders        INTEGER DEFAULT 0,
  last_sync_at        TIMESTAMPTZ,
  sync_error          TEXT,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  WHATSAPP NUMBERS
-- ──────────────────────────────────────────
CREATE TABLE whatsapp_numbers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID REFERENCES organizations(id) ON DELETE CASCADE,
  display_name      VARCHAR(255),
  phone_number      VARCHAR(30) NOT NULL,
  phone_number_id   VARCHAR(100) UNIQUE,  -- Meta WABA phone number ID
  waba_id           VARCHAR(100),         -- WhatsApp Business Account ID
  access_token      TEXT,                 -- Meta permanent token
  status            VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending','verified','active','suspended')),
  quality_rating    VARCHAR(20) DEFAULT 'GREEN' CHECK (quality_rating IN ('GREEN','YELLOW','RED')),
  messaging_limit   VARCHAR(50) DEFAULT 'TIER_1K',
  verified_at       TIMESTAMPTZ,
  profile           JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  CUSTOMERS (store's end customers)
-- ──────────────────────────────────────────
CREATE TABLE customers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id      UUID REFERENCES stores(id) ON DELETE SET NULL,
  external_id   VARCHAR(255),  -- shopify/woo customer ID
  phone         VARCHAR(30) NOT NULL,
  name          VARCHAR(255),
  email         VARCHAR(255),
  country_code  VARCHAR(10),
  language      VARCHAR(10) DEFAULT 'en',
  tags          TEXT[],
  total_orders  INTEGER DEFAULT 0,
  total_spent   NUMERIC(12,2) DEFAULT 0,
  opted_in      BOOLEAN DEFAULT TRUE,
  opted_out_at  TIMESTAMPTZ,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, phone)
);

-- ──────────────────────────────────────────
--  ORDERS
-- ──────────────────────────────────────────
CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id        UUID REFERENCES stores(id) ON DELETE SET NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  external_id     VARCHAR(255) NOT NULL,
  order_number    VARCHAR(100),
  status          VARCHAR(50) DEFAULT 'pending',
  payment_method  VARCHAR(50) DEFAULT 'cod' CHECK (payment_method IN ('cod','prepaid','bank_transfer','other')),
  total           NUMERIC(12,2),
  currency        VARCHAR(10) DEFAULT 'PKR',
  line_items      JSONB DEFAULT '[]',
  shipping_address JSONB,
  tracking_number VARCHAR(255),
  tracking_url    TEXT,
  wa_status       VARCHAR(50) DEFAULT 'pending' CHECK (wa_status IN ('pending','queued','sent','delivered','read','replied','failed')),
  wa_confirmed    BOOLEAN,
  wa_confirmed_at TIMESTAMPTZ,
  rto_risk        BOOLEAN DEFAULT FALSE,
  rto_score       NUMERIC(5,2),
  retry_count     INTEGER DEFAULT 0,
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, external_id)
);

-- ──────────────────────────────────────────
--  CONVERSATIONS
-- ──────────────────────────────────────────
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  whatsapp_number_id UUID REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  wa_contact_id   VARCHAR(255),  -- customer's WA ID
  status          VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open','pending','resolved','bot')),
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ,
  last_message    TEXT,
  unread_count    INTEGER DEFAULT 0,
  tags            TEXT[],
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  MESSAGES
-- ──────────────────────────────────────────
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  wa_message_id   VARCHAR(255) UNIQUE,  -- Meta message ID
  direction       VARCHAR(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
  type            VARCHAR(50) DEFAULT 'text' CHECK (type IN ('text','image','video','audio','document','template','interactive','location')),
  content         TEXT,
  template_name   VARCHAR(255),
  template_vars   JSONB,
  media_url       TEXT,
  status          VARCHAR(50) DEFAULT 'sent' CHECK (status IN ('pending','sent','delivered','read','failed')),
  error           TEXT,
  sent_by         UUID REFERENCES users(id) ON DELETE SET NULL,  -- null = automated
  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  AUTOMATION FLOWS
-- ──────────────────────────────────────────
CREATE TABLE flows (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id    UUID REFERENCES stores(id) ON DELETE SET NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  trigger     VARCHAR(100) NOT NULL,  -- order_created, cart_abandoned, order_shipped, etc.
  status      VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  nodes       JSONB DEFAULT '[]',     -- flow node definitions
  settings    JSONB DEFAULT '{}',
  stats       JSONB DEFAULT '{"runs":0,"success":0,"failed":0}',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  MESSAGE TEMPLATES
-- ──────────────────────────────────────────
CREATE TABLE templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  category    VARCHAR(100),
  language    VARCHAR(20) DEFAULT 'en',
  status      VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','disabled')),
  content     TEXT NOT NULL,
  header      TEXT,
  footer      TEXT,
  buttons     JSONB DEFAULT '[]',
  meta_template_id VARCHAR(255),  -- Meta's template ID
  rejection_reason TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, name, language)
);

-- ──────────────────────────────────────────
--  PRODUCTS / CATALOGUE
-- ──────────────────────────────────────────
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  store_id        UUID REFERENCES stores(id) ON DELETE SET NULL,
  external_id     VARCHAR(255),
  name            VARCHAR(500) NOT NULL,
  description     TEXT,
  price           NUMERIC(12,2),
  compare_price   NUMERIC(12,2),
  currency        VARCHAR(10) DEFAULT 'PKR',
  sku             VARCHAR(255),
  stock           INTEGER DEFAULT 0,
  images          JSONB DEFAULT '[]',
  category        VARCHAR(255),
  tags            TEXT[],
  meta_product_id VARCHAR(255),  -- Meta Commerce ID
  synced_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  BROADCASTS
-- ──────────────────────────────────────────
CREATE TABLE broadcasts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  template_id     UUID REFERENCES templates(id) ON DELETE SET NULL,
  segment         VARCHAR(100),
  segment_filters JSONB DEFAULT '{}',
  status          VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled')),
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  total           INTEGER DEFAULT 0,
  delivered       INTEGER DEFAULT 0,
  read_count      INTEGER DEFAULT 0,
  replied         INTEGER DEFAULT 0,
  failed          INTEGER DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  AUDIT LOG
-- ──────────────────────────────────────────
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(255) NOT NULL,
  resource    VARCHAR(100),
  resource_id UUID,
  details     JSONB DEFAULT '{}',
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  ADMIN TABLES (platform owner)
-- ──────────────────────────────────────────
CREATE TABLE admin_users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          VARCHAR(255),
  role          VARCHAR(50) DEFAULT 'support' CHECK (role IN ('owner','admin','support','billing','marketing')),
  is_active     BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE announcements (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       VARCHAR(500) NOT NULL,
  message     TEXT NOT NULL,
  type        VARCHAR(50) DEFAULT 'info' CHECK (type IN ('info','warning','feature','maintenance','promo')),
  audience    VARCHAR(100) DEFAULT 'all',
  plan_filter TEXT[],
  status      VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  starts_at   TIMESTAMPTZ DEFAULT NOW(),
  ends_at     TIMESTAMPTZ,
  created_by  UUID REFERENCES admin_users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE feature_flags (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key         VARCHAR(100) UNIQUE NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  enabled     BOOLEAN DEFAULT FALSE,
  plans       TEXT[] DEFAULT '{}',
  org_overrides JSONB DEFAULT '{}',  -- {org_id: true/false}
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────
--  INDEXES for performance
-- ──────────────────────────────────────────
CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_stores_org ON stores(org_id);
CREATE INDEX idx_orders_org ON orders(org_id);
CREATE INDEX idx_orders_store ON orders(store_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_wa_status ON orders(wa_status);
CREATE INDEX idx_conversations_org ON conversations(org_id);
CREATE INDEX idx_conversations_customer ON conversations(customer_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_customers_org_phone ON customers(org_id, phone);
CREATE INDEX idx_audit_org ON audit_logs(org_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ──────────────────────────────────────────
--  DEFAULT SYSTEM ROLES (inserted per org on signup)
--  See seed.js for the actual permissions JSON
-- ──────────────────────────────────────────
-- Roles: owner, admin, marketing, sales, support
-- Permissions structure: { "resource:action": true/false }
-- Resources: dashboard, stores, orders, conversations, 
--            flows, templates, catalogue, broadcasts,
--            analytics, billing, settings, team
