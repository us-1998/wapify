// services/meta.js — Meta WhatsApp Cloud API wrapper
const axios = require('axios');
const logger = require('../config/logger');

const BASE_URL = 'https://graph.facebook.com/v18.0';

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Authorization': `Bearer ${process.env.META_SYSTEM_USER_TOKEN}`, 'Content-Type': 'application/json' },
  timeout: 10000,
});

// Send a plain text message
const sendTextMessage = async (phoneNumberId, to, text) => {
  const res = await api.post(`/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', to, type: 'text', text: { body: text },
  });
  return res.data;
};

// Send a template message
const sendTemplate = async (phoneNumberId, to, templateName, languageCode, components = []) => {
  const res = await api.post(`/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  });
  return res.data;
};

// Send interactive message with buttons
const sendInteractive = async (phoneNumberId, to, body, buttons) => {
  const res = await api.post(`/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button', body: { text: body },
      action: { buttons: buttons.map((b, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: b } })) },
    },
  });
  return res.data;
};

// Request OTP for phone number verification
const requestOTP = async (phoneNumberId, method = 'SMS') => {
  const res = await api.post(`/${phoneNumberId}/request_code`, { code_method: method, language: 'en_US' });
  return res.data;
};

// Verify OTP
const verifyOTP = async (phoneNumberId, code) => {
  const res = await api.post(`/${phoneNumberId}/verify_code`, { code });
  return res.data;
};

// Create/submit a message template
const createTemplate = async (wabaId, name, language, category, components) => {
  const res = await api.post(`/${wabaId}/message_templates`, { name, language, category, components });
  return res.data;
};

// Get template status
const getTemplate = async (wabaId, templateId) => {
  const res = await api.get(`/${wabaId}/message_templates/${templateId}`);
  return res.data;
};

// Mark message as read
const markRead = async (phoneNumberId, messageId) => {
  const res = await api.post(`/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', status: 'read', message_id: messageId,
  });
  return res.data;
};

// Detect language from phone prefix
const detectLanguage = (phone) => {
  const prefixes = {
    '+92': 'ur', '+91': 'hi', '+1': 'en', '+44': 'en', '+971': 'ar',
    '+966': 'ar', '+880': 'bn', '+55': 'pt', '+52': 'es', '+62': 'id',
    '+234': 'yo', '+254': 'sw', '+63': 'tl', '+7': 'ru', '+86': 'zh',
    '+49': 'de', '+33': 'fr', '+90': 'tr',
  };
  for (const [prefix, lang] of Object.entries(prefixes)) {
    if (phone.startsWith(prefix)) return lang;
  }
  return 'en';
};

module.exports = { sendTextMessage, sendTemplate, sendInteractive, requestOTP, verifyOTP, createTemplate, getTemplate, markRead, detectLanguage };
