// routes/stores.js
const express = require('express');
const r = express.Router();
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const crypto = require('crypto');
const axios = require('axios');
r.use(authenticate);

r.get('/', requirePermission('stores:view'), async (req,res) => {
  const result = await query(`SELECT s.*,
    (SELECT COUNT(*) FROM orders WHERE store_id=s.id AND created_at>NOW()-INTERVAL '1 day')::int AS orders_today,
    (SELECT COUNT(*) FROM orders WHERE store_id=s.id)::int AS total_orders,
    (SELECT COUNT(*) FROM products WHERE store_id=s.id)::int AS product_count,
    (SELECT COUNT(*) FROM orders WHERE store_id=s.id AND wa_status='sent' AND created_at>NOW()-INTERVAL '1 month')::int AS wa_sent_month,
    wa.phone_number AS wa_phone
    FROM stores s LEFT JOIN whatsapp_numbers wa ON wa.id=s.whatsapp_number_id
    WHERE s.org_id=$1 AND s.status!='disconnected' ORDER BY s.created_at`, [req.user.org_id]);
  res.json({ stores: result.rows });
});

r.put('/:id', requirePermission('stores:edit'), async (req,res) => {
  const fields = ['name','auto_cod_confirm','auto_tracking','auto_cart_recovery','auto_review_request','whatsapp_number_id'];
  const sets=[]; const vals=[]; let i=1;
  for(const f of fields) if(req.body[f]!==undefined){sets.push(`${f}=$${i++}`);vals.push(req.body[f]);}
  if(!sets.length) return res.status(400).json({error:'No valid fields'});
  vals.push(req.params.id, req.user.org_id);
  const result = await query(`UPDATE stores SET ${sets.join(',')},updated_at=NOW() WHERE id=$${i} AND org_id=$${i+1} RETURNING *`,vals);
  if(!result.rows.length) return res.status(404).json({error:'Store not found'});
  res.json({store:result.rows[0]});
});

r.delete('/:id', requirePermission('stores:delete'), async (req,res) => {
  const result = await query("UPDATE stores SET status='disconnected',updated_at=NOW() WHERE id=$1 AND org_id=$2 RETURNING name",[req.params.id,req.user.org_id]);
  if(!result.rows.length) return res.status(404).json({error:'Store not found'});
  res.json({message:`"${result.rows[0].name}" disconnected`});
});

r.post('/shopify/install', requirePermission('stores:create'), async (req,res) => {
  const {shop}=req.body;
  if(!shop) return res.status(400).json({error:'shop URL required'});
  const s=shop.replace(/https?:\/\//,'').replace(/\/$/,'');
  const finalShop=s.includes('.myshopify.com')?s:`${s}.myshopify.com`;
  const state=crypto.randomBytes(16).toString('hex');
  try{
    const redis=require('../config/redis');
    await redis.set(`shopify_state:${state}`,req.user.org_id,{EX:600});
  } catch{}
  const url=`https://${finalShop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${process.env.SHOPIFY_SCOPES||'read_orders,read_products,read_customers'}&redirect_uri=${encodeURIComponent(process.env.APP_URL+'/api/stores/shopify/callback')}&state=${state}`;
  res.json({url});
});

r.get('/shopify/callback', async (req,res) => {
  const{shop,code,state,hmac,...rest}=req.query;
  if(!shop||!code||!state) return res.redirect(process.env.APP_URL+'?error=missing_oauth_params');
  let orgId;
  try{const redis=require('../config/redis');orgId=await redis.get(`shopify_state:${state}`);await redis.del(`shopify_state:${state}`);}catch{}
  if(!orgId) return res.redirect(process.env.APP_URL+'?error=invalid_state');
  const msg=Object.keys(rest).sort().map(k=>`${k}=${rest[k]}`).join('&');
  const digest=crypto.createHmac('sha256',process.env.SHOPIFY_API_SECRET).update(msg).digest('hex');
  if(digest!==hmac) return res.redirect(process.env.APP_URL+'?error=invalid_hmac');
  try{
    const tokenRes=await axios.post(`https://${shop}/admin/oauth/access_token`,{client_id:process.env.SHOPIFY_API_KEY,client_secret:process.env.SHOPIFY_API_SECRET,code});
    const accessToken=tokenRes.data.access_token;
    const shopRes=await axios.get(`https://${shop}/admin/api/2024-01/shop.json`,{headers:{'X-Shopify-Access-Token':accessToken}});
    const shopData=shopRes.data.shop;
    const ws=crypto.randomBytes(32).toString('hex');
    const ex=await query('SELECT id FROM stores WHERE shopify_shop=$1 AND org_id=$2',[shop,orgId]);
    let storeId;
    if(ex.rows.length){
      await query("UPDATE stores SET shopify_access_token=$1,status='connected',sync_error=NULL,updated_at=NOW() WHERE id=$2",[accessToken,ex.rows[0].id]);
      storeId=ex.rows[0].id;
    } else {
      const org=await query('SELECT max_stores FROM organizations WHERE id=$1',[orgId]);
      const cnt=await query("SELECT COUNT(*) FROM stores WHERE org_id=$1 AND status!='disconnected'",[orgId]);
      if(parseInt(cnt.rows[0].count)>=org.rows[0].max_stores) return res.redirect(process.env.APP_URL+'?error=store_limit_reached');
      const ns=await query(`INSERT INTO stores (org_id,name,platform,domain,shopify_shop,shopify_access_token,webhook_secret,status) VALUES ($1,$2,'shopify',$3,$4,$5,$6,'connected') RETURNING id`,
        [orgId,shopData.name,shopData.domain,shop,accessToken,ws]);
      storeId=ns.rows[0].id;
    }
    for(const topic of ['orders/create','orders/updated','checkouts/create']){
      await axios.post(`https://${shop}/admin/api/2024-01/webhooks.json`,{webhook:{topic,address:`${process.env.APP_URL}/api/stores/webhooks/shopify/${storeId}`,format:'json'}},{headers:{'X-Shopify-Access-Token':accessToken}}).catch(()=>{});
    }
    syncShopify(shop,accessToken,storeId,orgId).catch(()=>{});
    res.redirect(`${process.env.APP_URL}?shopify_connected=1&store=${encodeURIComponent(shopData.name)}`);
  } catch(err){
    console.error('Shopify OAuth error:',err.message);
    res.redirect(process.env.APP_URL+'?error=shopify_oauth_failed');
  }
});

r.post('/woocommerce/connect', requirePermission('stores:create'), async (req,res) => {
  const{woo_url,woo_consumer_key,woo_consumer_secret,store_name}=req.body;
  if(!woo_url||!woo_consumer_key||!woo_consumer_secret) return res.status(400).json({error:'Store URL, Consumer Key and Consumer Secret are required'});
  const base=woo_url.replace(/\/$/,'');
  try{
    await axios.get(`${base}/wp-json/wc/v3/system_status`,{auth:{username:woo_consumer_key,password:woo_consumer_secret},timeout:10000});
  } catch(err){
    if(err.response?.status===401) return res.status(401).json({error:'Invalid Consumer Key or Secret. Regenerate them in WooCommerce → Settings → Advanced → REST API.'});
    if(err.code==='ECONNREFUSED'||err.code==='ENOTFOUND') return res.status(400).json({error:'Cannot reach your store. Check the URL is correct and publicly accessible.'});
    if(err.response?.status===404) return res.status(400).json({error:'WooCommerce REST API not found. Check that WooCommerce is installed and permalinks are not set to Plain.'});
    return res.status(400).json({error:'Connection failed: '+(err.message||'Unknown error')});
  }
  const org=await query('SELECT max_stores FROM organizations WHERE id=$1',[req.user.org_id]);
  const cnt=await query("SELECT COUNT(*) FROM stores WHERE org_id=$1 AND status!='disconnected'",[req.user.org_id]);
  if(parseInt(cnt.rows[0].count)>=org.rows[0].max_stores) return res.status(403).json({error:`Your plan allows max ${org.rows[0].max_stores} stores. Upgrade to add more.`});
  const domain=new URL(base).hostname;
  const ws=crypto.randomBytes(32).toString('hex');
  const ns=await query(`INSERT INTO stores (org_id,name,platform,domain,woo_url,woo_consumer_key,woo_consumer_secret,webhook_secret,status) VALUES ($1,$2,'woocommerce',$3,$4,$5,$6,$7,'connected') RETURNING *`,
    [req.user.org_id,store_name||domain,domain,base,woo_consumer_key,woo_consumer_secret,ws]);
  for(const topic of ['order.created','order.updated']){
    await axios.post(`${base}/wp-json/wc/v3/webhooks`,{name:`Wapify ${topic}`,topic,delivery_url:`${process.env.APP_URL}/api/stores/webhooks/woocommerce/${ns.rows[0].id}`,secret:ws},{auth:{username:woo_consumer_key,password:woo_consumer_secret}}).catch(()=>{});
  }
  syncWooCommerce(base,woo_consumer_key,woo_consumer_secret,ns.rows[0].id,req.user.org_id).catch(()=>{});
  res.status(201).json({message:`"${ns.rows[0].name}" connected successfully`,store:ns.rows[0]});
});

r.post('/bigcommerce/connect', requirePermission('stores:create'), async (req,res) => {
  const{bc_store_hash,bc_access_token}=req.body;
  if(!bc_store_hash||!bc_access_token) return res.status(400).json({error:'Store hash and access token required'});
  try{
    const resp=await axios.get(`https://api.bigcommerce.com/stores/${bc_store_hash}/v2/store`,{headers:{'X-Auth-Token':bc_access_token,Accept:'application/json'},timeout:10000});
    const org=await query('SELECT max_stores FROM organizations WHERE id=$1',[req.user.org_id]);
    const cnt=await query("SELECT COUNT(*) FROM stores WHERE org_id=$1 AND status!='disconnected'",[req.user.org_id]);
    if(parseInt(cnt.rows[0].count)>=org.rows[0].max_stores) return res.status(403).json({error:'Store limit reached. Upgrade your plan.'});
    const ws=crypto.randomBytes(32).toString('hex');
    const ns=await query(`INSERT INTO stores (org_id,name,platform,domain,bc_store_hash,bc_access_token,webhook_secret,status) VALUES ($1,$2,'bigcommerce',$3,$4,$5,$6,'connected') RETURNING *`,
      [req.user.org_id,resp.data.name,resp.data.secure_url,bc_store_hash,bc_access_token,ws]);
    res.status(201).json({message:`"${resp.data.name}" connected`,store:ns.rows[0]});
  } catch(err){
    if(err.response?.status===401) return res.status(401).json({error:'Invalid access token'});
    return res.status(400).json({error:'Connection failed: '+err.message});
  }
});

r.post('/custom/create', requirePermission('stores:create'), async (req,res) => {
  const{name}=req.body;
  if(!name) return res.status(400).json({error:'Store name required'});
  const org=await query('SELECT max_stores FROM organizations WHERE id=$1',[req.user.org_id]);
  const cnt=await query("SELECT COUNT(*) FROM stores WHERE org_id=$1 AND status!='disconnected'",[req.user.org_id]);
  if(parseInt(cnt.rows[0].count)>=org.rows[0].max_stores) return res.status(403).json({error:'Store limit reached. Upgrade your plan.'});
  const ws=crypto.randomBytes(32).toString('hex');
  const ns=await query(`INSERT INTO stores (org_id,name,platform,webhook_secret,status) VALUES ($1,$2,'custom',$3,'connected') RETURNING *`,[req.user.org_id,name,ws]);
  res.status(201).json({store:ns.rows[0],webhook_url:`${process.env.APP_URL}/api/stores/webhooks/custom/${ns.rows[0].id}`,webhook_secret:ws,message:'Store created. POST order events to the webhook URL with X-Wapify-Signature header.'});
});

r.post('/:id/sync', requirePermission('stores:edit'), async (req,res) => {
  const s=await query('SELECT * FROM stores WHERE id=$1 AND org_id=$2',[req.params.id,req.user.org_id]);
  if(!s.rows.length) return res.status(404).json({error:'Store not found'});
  const store=s.rows[0];
  if(store.platform==='shopify'&&store.shopify_access_token){
    syncShopify(store.shopify_shop,store.shopify_access_token,store.id,req.user.org_id).catch(()=>{});
    return res.json({message:'Sync started for '+store.name});
  } else if(store.platform==='woocommerce'&&store.woo_consumer_key){
    syncWooCommerce(store.woo_url,store.woo_consumer_key,store.woo_consumer_secret,store.id,req.user.org_id).catch(()=>{});
    return res.json({message:'Sync started for '+store.name});
  }
  await query("UPDATE stores SET sync_error='Store credentials missing. Reconnect store.' WHERE id=$1",[store.id]);
  res.status(400).json({error:'Store credentials missing. Please reconnect.'});
});

r.post('/webhooks/shopify/:storeId', express.raw({type:'application/json'}), async (req,res) => {
  const store=await query('SELECT * FROM stores WHERE id=$1',[req.params.storeId]);
  if(!store.rows.length) return res.sendStatus(404);
  const hmac=req.headers['x-shopify-hmac-sha256'];
  const digest=crypto.createHmac('sha256',process.env.SHOPIFY_API_SECRET).update(req.body).digest('base64');
  if(digest!==hmac) return res.sendStatus(401);
  const topic=req.headers['x-shopify-topic'];
  const data=JSON.parse(req.body);
  const wq=require('../services/waQueue');
  if(topic==='orders/create') await wq.add('new_order',{storeId:req.params.storeId,orgId:store.rows[0].org_id,order:data});
  else if(topic==='checkouts/create') await wq.add('cart_abandoned',{storeId:req.params.storeId,orgId:store.rows[0].org_id,checkout:data});
  res.sendStatus(200);
});

r.post('/webhooks/woocommerce/:storeId', async (req,res) => {
  const store=await query('SELECT * FROM stores WHERE id=$1',[req.params.storeId]);
  if(!store.rows.length) return res.sendStatus(404);
  const topic=req.headers['x-wc-webhook-topic'];
  if(topic==='order.created'){const wq=require('../services/waQueue');await wq.add('new_order',{storeId:req.params.storeId,orgId:store.rows[0].org_id,order:req.body,platform:'woocommerce'});}
  res.sendStatus(200);
});

r.post('/webhooks/custom/:storeId', async (req,res) => {
  const store=await query('SELECT * FROM stores WHERE id=$1',[req.params.storeId]);
  if(!store.rows.length) return res.sendStatus(404);
  const sig=req.headers['x-wapify-signature'];
  if(!sig) return res.sendStatus(401);
  const digest='sha256='+crypto.createHmac('sha256',store.rows[0].webhook_secret).update(JSON.stringify(req.body)).digest('hex');
  if(digest!==sig) return res.sendStatus(401);
  const wq=require('../services/waQueue');
  await wq.add('new_order',{storeId:req.params.storeId,orgId:store.rows[0].org_id,order:req.body,platform:'custom'});
  res.sendStatus(200);
});

async function syncShopify(shop,token,storeId,orgId){
  try{
    const [ordRes,pRes]=await Promise.all([
      axios.get(`https://${shop}/admin/api/2024-01/orders.json?limit=250&status=any&order=created_at+desc`,{headers:{'X-Shopify-Access-Token':token}}),
      axios.get(`https://${shop}/admin/api/2024-01/products.json?limit=250`,{headers:{'X-Shopify-Access-Token':token}})
    ]);
    const meta=require('../services/meta');
    for(const o of ordRes.data.orders||[]){
      const phone=o.billing_address?.phone||o.phone||o.customer?.phone;
      if(!phone) continue;
      const cRes=await query(`INSERT INTO customers (org_id,store_id,external_id,phone,name,email,language)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id,phone) DO UPDATE SET name=EXCLUDED.name,updated_at=NOW() RETURNING id`,
        [orgId,storeId,String(o.customer?.id||o.id),phone,`${o.billing_address?.first_name||''} ${o.billing_address?.last_name||''}`.trim(),o.email||'',meta.detectLanguage(phone)]);
      const isCOD=(o.payment_gateway||'').toLowerCase().includes('cod')||(o.payment_gateway||'').toLowerCase().includes('cash');
      await query(`INSERT INTO orders (org_id,store_id,customer_id,external_id,order_number,status,payment_method,total,currency,line_items,shipping_address)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) ON CONFLICT (store_id,external_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()`,
        [orgId,storeId,cRes.rows[0].id,String(o.id),o.name||`#${o.id}`,o.financial_status||'pending',isCOD?'cod':'prepaid',
         parseFloat(o.total_price||0),o.currency||'PKR',JSON.stringify(o.line_items||[]),JSON.stringify(o.billing_address||{})]).catch(()=>{});
    }
    for(const p of pRes.data.products||[]){
      await query(`INSERT INTO products (org_id,store_id,external_id,name,description,price,images,stock,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW()) ON CONFLICT (org_id,store_id,external_id) DO UPDATE
        SET name=EXCLUDED.name,price=EXCLUDED.price,images=EXCLUDED.images,stock=EXCLUDED.stock,synced_at=NOW()`,
        [orgId,storeId,String(p.id),p.title,p.body_html||'',parseFloat(p.variants?.[0]?.price||0),
         JSON.stringify(p.images?.map(i=>i.src)||[]),p.variants?.reduce((s,v)=>s+(parseInt(v.inventory_quantity)||0),0)||0]).catch(()=>{});
    }
    await query("UPDATE stores SET last_sync_at=NOW(),sync_error=NULL,status='connected' WHERE id=$1",[storeId]);
  } catch(err){
    await query('UPDATE stores SET sync_error=$1 WHERE id=$2',[err.message,storeId]);
  }
}

async function syncWooCommerce(baseUrl,key,secret,storeId,orgId){
  try{
    const [ordRes,pRes]=await Promise.all([
      axios.get(`${baseUrl}/wp-json/wc/v3/orders?per_page=100&orderby=date&order=desc`,{auth:{username:key,password:secret}}),
      axios.get(`${baseUrl}/wp-json/wc/v3/products?per_page=100`,{auth:{username:key,password:secret}})
    ]);
    const meta=require('../services/meta');
    for(const o of ordRes.data||[]){
      const phone=o.billing?.phone;
      if(!phone) continue;
      const cRes=await query(`INSERT INTO customers (org_id,store_id,external_id,phone,name,email,language)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id,phone) DO UPDATE SET name=EXCLUDED.name,updated_at=NOW() RETURNING id`,
        [orgId,storeId,String(o.id),phone,`${o.billing?.first_name||''} ${o.billing?.last_name||''}`.trim(),o.billing?.email||'',meta.detectLanguage(phone)]);
      await query(`INSERT INTO orders (org_id,store_id,customer_id,external_id,order_number,status,payment_method,total,currency)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (store_id,external_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()`,
        [orgId,storeId,cRes.rows[0].id,String(o.id),`#${o.number}`,o.status==='pending'?'pending':'confirmed',
         o.payment_method==='cod'?'cod':'prepaid',parseFloat(o.total||0),o.currency||'PKR']).catch(()=>{});
    }
    for(const p of pRes.data||[]){
      await query(`INSERT INTO products (org_id,store_id,external_id,name,description,price,images,stock,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW()) ON CONFLICT (org_id,store_id,external_id) DO UPDATE
        SET name=EXCLUDED.name,price=EXCLUDED.price,images=EXCLUDED.images,stock=EXCLUDED.stock,synced_at=NOW()`,
        [orgId,storeId,String(p.id),p.name,p.description||'',parseFloat(p.price||0),
         JSON.stringify(p.images?.map(i=>i.src)||[]),parseInt(p.stock_quantity)||0]).catch(()=>{});
    }
    await query("UPDATE stores SET last_sync_at=NOW(),sync_error=NULL,status='connected' WHERE id=$1",[storeId]);
  } catch(err){
    await query('UPDATE stores SET sync_error=$1 WHERE id=$2',[err.message,storeId]);
  }
}

module.exports = r;
