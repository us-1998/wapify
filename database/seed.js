// database/seed.js — Seeds default data
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── PERMISSION DEFINITIONS ──────────────────────────────────
// Full permission map for each role
const PERMISSIONS = {
  owner: {
    'dashboard:view': true,
    'stores:view': true, 'stores:create': true, 'stores:edit': true, 'stores:delete': true,
    'orders:view': true, 'orders:export': true, 'orders:send_wa': true,
    'conversations:view': true, 'conversations:reply': true, 'conversations:assign': true,
    'flows:view': true, 'flows:create': true, 'flows:edit': true, 'flows:delete': true, 'flows:toggle': true,
    'templates:view': true, 'templates:create': true, 'templates:edit': true, 'templates:delete': true,
    'catalogue:view': true, 'catalogue:create': true, 'catalogue:edit': true, 'catalogue:delete': true, 'catalogue:sync': true,
    'broadcasts:view': true, 'broadcasts:create': true, 'broadcasts:send': true, 'broadcasts:delete': true,
    'analytics:view': true, 'analytics:export': true,
    'billing:view': true, 'billing:manage': true,
    'settings:view': true, 'settings:edit': true,
    'team:view': true, 'team:invite': true, 'team:edit': true, 'team:remove': true,
    'whatsapp:view': true, 'whatsapp:setup': true, 'whatsapp:manage': true,
  },
  admin: {
    'dashboard:view': true,
    'stores:view': true, 'stores:create': true, 'stores:edit': true, 'stores:delete': false,
    'orders:view': true, 'orders:export': true, 'orders:send_wa': true,
    'conversations:view': true, 'conversations:reply': true, 'conversations:assign': true,
    'flows:view': true, 'flows:create': true, 'flows:edit': true, 'flows:delete': false, 'flows:toggle': true,
    'templates:view': true, 'templates:create': true, 'templates:edit': true, 'templates:delete': false,
    'catalogue:view': true, 'catalogue:create': true, 'catalogue:edit': true, 'catalogue:delete': false, 'catalogue:sync': true,
    'broadcasts:view': true, 'broadcasts:create': true, 'broadcasts:send': true, 'broadcasts:delete': false,
    'analytics:view': true, 'analytics:export': true,
    'billing:view': true, 'billing:manage': false,
    'settings:view': true, 'settings:edit': true,
    'team:view': true, 'team:invite': true, 'team:edit': false, 'team:remove': false,
    'whatsapp:view': true, 'whatsapp:setup': false, 'whatsapp:manage': false,
  },
  marketing: {
    'dashboard:view': true,
    'stores:view': true, 'stores:create': false, 'stores:edit': false, 'stores:delete': false,
    'orders:view': false, 'orders:export': false, 'orders:send_wa': false,
    'conversations:view': true, 'conversations:reply': false, 'conversations:assign': false,
    'flows:view': true, 'flows:create': true, 'flows:edit': true, 'flows:delete': false, 'flows:toggle': false,
    'templates:view': true, 'templates:create': true, 'templates:edit': true, 'templates:delete': false,
    'catalogue:view': true, 'catalogue:create': true, 'catalogue:edit': true, 'catalogue:delete': false, 'catalogue:sync': true,
    'broadcasts:view': true, 'broadcasts:create': true, 'broadcasts:send': true, 'broadcasts:delete': false,
    'analytics:view': true, 'analytics:export': true,
    'billing:view': false, 'billing:manage': false,
    'settings:view': false, 'settings:edit': false,
    'team:view': false, 'team:invite': false, 'team:edit': false, 'team:remove': false,
    'whatsapp:view': false, 'whatsapp:setup': false, 'whatsapp:manage': false,
  },
  sales: {
    'dashboard:view': true,
    'stores:view': true, 'stores:create': false, 'stores:edit': false, 'stores:delete': false,
    'orders:view': true, 'orders:export': true, 'orders:send_wa': true,
    'conversations:view': true, 'conversations:reply': true, 'conversations:assign': false,
    'flows:view': true, 'flows:create': false, 'flows:edit': false, 'flows:delete': false, 'flows:toggle': false,
    'templates:view': true, 'templates:create': false, 'templates:edit': false, 'templates:delete': false,
    'catalogue:view': true, 'catalogue:create': false, 'catalogue:edit': false, 'catalogue:delete': false, 'catalogue:sync': false,
    'broadcasts:view': true, 'broadcasts:create': false, 'broadcasts:send': false, 'broadcasts:delete': false,
    'analytics:view': true, 'analytics:export': false,
    'billing:view': false, 'billing:manage': false,
    'settings:view': false, 'settings:edit': false,
    'team:view': false, 'team:invite': false, 'team:edit': false, 'team:remove': false,
    'whatsapp:view': false, 'whatsapp:setup': false, 'whatsapp:manage': false,
  },
  support: {
    'dashboard:view': true,
    'stores:view': true, 'stores:create': false, 'stores:edit': false, 'stores:delete': false,
    'orders:view': true, 'orders:export': false, 'orders:send_wa': true,
    'conversations:view': true, 'conversations:reply': true, 'conversations:assign': true,
    'flows:view': true, 'flows:create': false, 'flows:edit': false, 'flows:delete': false, 'flows:toggle': false,
    'templates:view': true, 'templates:create': false, 'templates:edit': false, 'templates:delete': false,
    'catalogue:view': true, 'catalogue:create': false, 'catalogue:edit': false, 'catalogue:delete': false, 'catalogue:sync': false,
    'broadcasts:view': false, 'broadcasts:create': false, 'broadcasts:send': false, 'broadcasts:delete': false,
    'analytics:view': false, 'analytics:export': false,
    'billing:view': false, 'billing:manage': false,
    'settings:view': false, 'settings:edit': false,
    'team:view': false, 'team:invite': false, 'team:edit': false, 'team:remove': false,
    'whatsapp:view': false, 'whatsapp:setup': false, 'whatsapp:manage': false,
  },
};

const ROLE_META = {
  owner:     { name: 'Owner',     description: 'Full access to everything' },
  admin:     { name: 'Admin',     description: 'Full access except billing and team deletion' },
  marketing: { name: 'Marketing', description: 'Flows, templates, broadcasts, catalogue' },
  sales:     { name: 'Sales',     description: 'Orders, conversations, basic analytics' },
  support:   { name: 'Support',   description: 'Conversations, orders, no config access' },
};

async function seed() {
  const client = await pool.connect();
  console.log('🌱 Seeding database...');
  try {
    await client.query('BEGIN');

    // ── Feature flags ─────────────────────────────────────────
    const flags = [
      { key: 'catalogue_sync',       name: 'Product Catalogue Sync',      description: 'Sync products to Meta Commerce', enabled: true,  plans: ['growth','scale','agency'] },
      { key: 'flow_builder',         name: 'Automation Flow Builder',     description: 'Visual flow editor',            enabled: true,  plans: ['growth','scale','agency'] },
      { key: 'broadcast_segments',   name: 'Broadcast Segments',          description: 'Advanced customer segmentation',enabled: true,  plans: ['scale','agency'] },
      { key: 'whitelabel_mode',      name: 'White-label Mode',            description: 'Remove Wapify branding',        enabled: true,  plans: ['agency'] },
      { key: 'sms_fallback',         name: 'SMS Fallback via Twilio',     description: 'Auto SMS if WA fails',          enabled: true,  plans: ['scale','agency'] },
      { key: 'developer_api',        name: 'Developer API',               description: 'REST API + webhooks',           enabled: true,  plans: ['scale','agency'] },
      { key: 'ai_reply_suggestions', name: 'AI Reply Suggestions',        description: 'AI-powered replies (beta)',     enabled: false, plans: [] },
      { key: 'rto_predictor',        name: 'RTO Risk Predictor (ML)',     description: 'ML-based RTO prediction',       enabled: false, plans: [] },
    ];

    for (const f of flags) {
      await client.query(`
        INSERT INTO feature_flags (key, name, description, enabled, plans)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=NOW()
      `, [f.key, f.name, f.description, f.enabled, f.plans]);
    }
    console.log('  ✅ Feature flags seeded');

    // ── Admin user (YOU — the CEO) ─────────────────────────────
    const adminPass = await bcrypt.hash(process.env.ADMIN_INITIAL_PASSWORD || 'AdminPass@123', 12);
    await client.query(`
      INSERT INTO admin_users (email, password_hash, name, role)
      VALUES ($1,$2,$3,'owner')
      ON CONFLICT (email) DO NOTHING
    `, [process.env.ADMIN_EMAIL || 'admin@wapify.com', adminPass, 'Ahmed Khan']);
    console.log('  ✅ Admin user seeded');

    // ── Demo organization + owner + roles ─────────────────────
    const demoOrgId = uuidv4();
    await client.query(`
      INSERT INTO organizations (id, name, slug, plan, plan_status, msg_quota, max_stores)
      VALUES ($1,'Demo Store','demo-store','growth','active',5000,3)
      ON CONFLICT DO NOTHING
    `, [demoOrgId]);

    // Insert all 5 system roles for the demo org
    for (const [slug, meta] of Object.entries(ROLE_META)) {
      await client.query(`
        INSERT INTO roles (org_id, name, slug, description, is_system, permissions)
        VALUES ($1,$2,$3,$4,true,$5)
        ON CONFLICT (org_id, slug) DO UPDATE SET permissions=EXCLUDED.permissions
      `, [demoOrgId, meta.name, slug, meta.description, JSON.stringify(PERMISSIONS[slug])]);
    }

    // Demo owner user
    const ownerRoleRes = await client.query(
      'SELECT id FROM roles WHERE org_id=$1 AND slug=$2', [demoOrgId, 'owner']
    );
    const ownerRoleId = ownerRoleRes.rows[0]?.id;
    const demoPass = await bcrypt.hash('Demo@123456', 12);
    await client.query(`
      INSERT INTO users (org_id, role_id, email, password_hash, first_name, last_name, is_owner, is_email_verified)
      VALUES ($1,$2,'demo@wapify.com',$3,'Demo','Owner',true,true)
      ON CONFLICT (email) DO NOTHING
    `, [demoOrgId, ownerRoleId, demoPass]);

    console.log('  ✅ Demo org + roles seeded');
    await client.query('COMMIT');
    console.log('🎉 Seed complete!');
    console.log('\n📝 Demo login:  demo@wapify.com / Demo@123456');
    console.log('📝 Admin login: admin@wapify.com / AdminPass@123\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
