const axios = require('axios');

const api = axios.create({
  baseURL: 'https://graph.facebook.com/v18.0',
  timeout: 10000,
});

const getHeaders = () => ({ Authorization: `Bearer ${process.env.META_SYSTEM_USER_TOKEN}`, 'Content-Type': 'application/json' });

const sendText = async (phoneNumberId, to, text) => {
  const r = await api.post(`/${phoneNumberId}/messages`, { messaging_product:'whatsapp', to, type:'text', text:{body:text} }, { headers: getHeaders() });
  return r.data;
};

const sendTemplate = async (phoneNumberId, to, templateName, langCode, components=[]) => {
  const r = await api.post(`/${phoneNumberId}/messages`, { messaging_product:'whatsapp', to, type:'template', template:{name:templateName, language:{code:langCode}, components} }, { headers: getHeaders() });
  return r.data;
};

const sendInteractive = async (phoneNumberId, to, body, buttons) => {
  const r = await api.post(`/${phoneNumberId}/messages`, {
    messaging_product:'whatsapp', to, type:'interactive',
    interactive: { type:'button', body:{text:body}, action:{buttons:buttons.map((b,i)=>({type:'reply',reply:{id:`btn_${i}`,title:b}}))}}
  }, { headers: getHeaders() });
  return r.data;
};

const requestOTP = async (phoneNumberId, method='SMS') => {
  const r = await api.post(`/${phoneNumberId}/request_code`, { code_method:method, language:'en_US' }, { headers: getHeaders() });
  return r.data;
};

const verifyOTP = async (phoneNumberId, code) => {
  const r = await api.post(`/${phoneNumberId}/verify_code`, { code }, { headers: getHeaders() });
  return r.data;
};

const markRead = async (phoneNumberId, messageId) => {
  const r = await api.post(`/${phoneNumberId}/messages`, { messaging_product:'whatsapp', status:'read', message_id:messageId }, { headers: getHeaders() });
  return r.data;
};

const detectLanguage = (phone) => {
  const map = {'+92':'ur','+91':'hi','+1':'en','+44':'en','+971':'ar','+966':'ar','+880':'bn','+55':'pt','+52':'es','+62':'id','+234':'en','+254':'sw','+63':'tl','+7':'ru','+86':'zh','+49':'de','+33':'fr','+90':'tr'};
  for (const [pfx,lang] of Object.entries(map)) if (phone.startsWith(pfx)) return lang;
  return 'en';
};

module.exports = { sendText, sendTemplate, sendInteractive, requestOTP, verifyOTP, markRead, detectLanguage };
