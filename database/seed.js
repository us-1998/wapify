require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

const PERMS = {
  owner: { 'dashboard:view':1,'stores:view':1,'stores:create':1,'stores:edit':1,'stores:delete':1,'orders:view':1,'orders:export':1,'orders:send_wa':1,'conversations:view':1,'conversations:reply':1,'conversations:assign':1,'flows:view':1,'flows:create':1,'flows:edit':1,'flows:delete':1,'flows:toggle':1,'templates:view':1,'templates:create':1,'templates:edit':1,'templates:delete':1,'catalogue:view':1,'catalogue:create':1,'catalogue:edit':1,'catalogue:delete':1,'catalogue:sync':1,'broadcasts:view':1,'broadcasts:create':1,'broadcasts:send':1,'broadcasts:delete':1,'analytics:view':1,'analytics:export':1,'billing:view':1,'billing:manage':1,'settings:view':1,'settings:edit':1,'team:view':1,'team:invite':1,'team:edit':1,'team:remove':1,'whatsapp:view':1,'whatsapp:setup':1,'whatsapp:manage':1 },
  admin: { 'dashboard:view':1,'stores:view':1,'stores:create':1,'stores:edit':1,'orders:view':1,'orders:export':1,'orders:send_wa':1,'conversations:view':1,'conversations:reply':1,'conversations:assign':1,'flows:view':1,'flows:create':1,'flows:edit':1,'flows:toggle':1,'templates:view':1,'templates:create':1,'templates:edit':1,'catalogue:view':1,'catalogue:sync':1,'broadcasts:view':1,'broadcasts:create':1,'broadcasts:send':1,'analytics:view':1,'analytics:export':1,'billing:view':1,'settings:view':1,'settings:edit':1,'team:view':1,'team:invite':1,'whatsapp:view':1 },
  marketing: { 'dashboard:view':1,'stores:view':1,'flows:view':1,'flows:create':1,'flows:edit':1,'flows:toggle':1,'templates:view':1,'templates:create':1,'templates:edit':1,'catalogue:view':1,'catalogue:create':1,'catalogue:edit':1,'catalogue:sync':1,'broadcasts:view':1,'broadcasts:create':1,'broadcasts:send':1,'analytics:view':1,'analytics:export':1 },
  sales: { 'dashboard:view':1,'stores:view':1,'orders:view':1,'orders:export':1,'orders:send_wa':1,'conversations:view':1,'conversations:reply':1,'flows:view':1,'templates:view':1,'catalogue:view':1,'broadcasts:view':1,'analytics:view':1 },
  support: { 'dashboard:view':1,'stores:view':1,'orders:view':1,'orders:send_wa':1,'conversations:view':1,'conversations:reply':1,'conversations:assign':1,'flows:view':1,'templates:view':1,'catalogue:view':1 },
};

async function seed() {
  const client = await pool.connect();
  console.log('🌱 Seeding…');
  try {
    await client.query('BEGIN');

    // Feature flags
    const flags = [
      ['catalogue_sync','Product Catalogue Sync','Sync to Meta Commerce',true,'{growth,scale,agency}'],
      ['flow_builder','Flow Builder','Automation flows',true,'{growth,scale,agency}'],
      ['broadcast_segments','Broadcast Segments','Advanced segmentation',true,'{scale,agency}'],
      ['whitelabel_mode','White-label Mode','Remove Wapify branding',true,'{agency}'],
      ['sms_fallback','SMS Fallback','Auto SMS if WA fails',true,'{scale,agency}'],
      ['developer_api','Developer API','REST API access',true,'{scale,agency}'],
      ['ai_reply_suggestions','AI Reply Suggestions','Beta AI replies',false,'{}'],
      ['rto_predictor','RTO Predictor ML','ML-based RTO prediction',false,'{}'],
    ];
    for (const [key,name,desc,enabled,plans] of flags) {
      await client.query(`INSERT INTO feature_flags (key,name,description,enabled,plans) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled`,
        [key,name,desc,enabled,plans]);
    }

    // Admin user (CEO)
    const adminPass = await bcrypt.hash(process.env.ADMIN_INITIAL_PASSWORD || 'AdminWapify@2026', 12);
    await client.query(`INSERT INTO admin_users (email,password_hash,name,role) VALUES ($1,$2,'CEO','owner') ON CONFLICT (email) DO NOTHING`,
      [process.env.ADMIN_EMAIL || 'admin@wapify.com', adminPass]);

    // Demo org (Use fixed ID or handle conflict properly)
    const orgRes = await client.query(`
      INSERT INTO organizations (id, name, slug, plan, plan_status, msg_quota, max_stores, billing_email)
      VALUES ($1, 'Demo Store', 'demo-store', 'growth', 'active', 5000, 3, 'demo@wapify.com')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [uuidv4()]);
    const orgId = orgRes.rows[0].id;

    // Roles for demo org
    const roleIds = {};
    const roleMeta = { owner:'Full access', admin:'Admin access', marketing:'Marketing access', sales:'Sales access', support:'Support access' };
    const roleNames = { owner:'Owner', admin:'Admin', marketing:'Marketing', sales:'Sales', support:'Support' };
    for (const [slug, desc] of Object.entries(roleMeta)) {
      const r = await client.query(`INSERT INTO roles (org_id,name,slug,description,is_system,permissions) VALUES ($1,$2,$3,$4,true,$5::jsonb)
        ON CONFLICT (org_id,slug) DO UPDATE SET permissions=EXCLUDED.permissions RETURNING id`,
        [orgId, roleNames[slug], slug, desc, JSON.stringify(PERMS[slug])]);
      roleIds[slug] = r.rows[0].id;
    }

    // Demo owner user (password: Demo@123456)
    const demoPass = await bcrypt.hash('Demo@123456', 12);
    await client.query(`INSERT INTO users (org_id,role_id,email,password_hash,first_name,last_name,is_owner,is_email_verified)
      VALUES ($1,$2,'demo@wapify.com',$3,'Demo','Owner',true,true) ON CONFLICT (email) DO NOTHING`,
      [orgId, roleIds.owner, demoPass]);

    await client.query('COMMIT');
    console.log('✅ Seed complete');
    console.log('   Demo:  demo@wapify.com / Demo@123456');
    console.log('   Admin: admin@wapify.com / AdminWapify@2026');
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
