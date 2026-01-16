require('dotenv').config({ path: '.env.local' });

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { kv } = require('@vercel/kv');
const { supabase } = require('./lib/supabase');

const app = express();

// ============================================
// 환경변수
// ============================================
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'onmore_webhook_token_2024';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const META_APP_SECRET = process.env.META_APP_SECRET;
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'info@onmore.au';

// ============================================
// Config 로더 (Supabase)
// ============================================
async function getClientByOrigin(origin) {
  if (!supabase) {
    console.warn('Supabase not initialized');
    return null;
  }
  
  const { data: clients } = await supabase
    .from('clients')
    .select('*, chatbot_configs(*)')
    .eq('status', 'active');
  
  if (!clients || clients.length === 0) {
    return null;
  }

  for (const client of clients) {
    if (client.domain && origin?.includes(client.domain)) {
      return client;
    }
  }
  
  return clients[0];
}

async function getClientByInstagramId(recipientId) {
  if (!supabase) {
    console.warn('Supabase not initialized');
    return null;
  }
  
  const { data: clients } = await supabase
    .from('clients')
    .select('*, chatbot_configs(*)')
    .eq('status', 'active');
  
  if (!clients || clients.length === 0) {
    return null;
  }
  
  return clients[0];
}

function buildSystemPrompt(client) {
  if (!client) {
    return 'You are a helpful AI assistant for onmore, helping Australian small businesses automate customer service.';
  }
  
  const config = Array.isArray(client.chatbot_configs) 
    ? client.chatbot_configs[0] 
    : client.chatbot_configs;
  
  if (!config) {
    return 'You are a helpful AI assistant for onmore, helping Australian small businesses automate customer service.';
  }

  const parts = [];
  
  if (config.identity) {
    parts.push(config.identity);
  }
  
  if (config.role && Array.isArray(config.role) && config.role.length > 0) {
    parts.push('\n## Your Role:');
    parts.push(config.role.map(r => `- ${r}`).join('\n'));
  }
  
  if (config.rules && Array.isArray(config.rules) && config.rules.length > 0) {
    parts.push('\n## Guidelines:');
    parts.push(config.rules.map(r => `- ${r}`).join('\n'));
  }
  
  if (config.business_info) {
    const biz = config.business_info;
    parts.push('\n## Business Information:');
    if (biz.name) parts.push(`Company: ${biz.name}`);
    if (biz.domain) parts.push(`Website: ${biz.domain}`);
    if (biz.email) parts.push(`Email: ${biz.email}`);
    if (biz.location) parts.push(`Location: ${biz.location}`);
    if (biz.description) parts.push(`About: ${biz.description}`);
    if (biz.guarantee) parts.push(`Guarantee: ${biz.guarantee}`);
  }
  
  if (config.service_plans && Array.isArray(config.service_plans) && config.service_plans.length > 0) {
    parts.push('\n## Services & Pricing:');
    config.service_plans.forEach(plan => {
      const price = plan.price ? `$${plan.price} ${plan.currency}/${plan.period}` : '';
      const badge = plan.badge ? ` [${plan.badge}]` : '';
      parts.push(`\n**${plan.name}**${badge} ${price}`);
      if (plan.features && plan.features.length > 0) {
        parts.push(plan.features.map(f => `  - ${f}`).join('\n'));
      }
      if (plan.savings) {
        parts.push(`  💰 Save $${plan.savings}/month`);
      }
    });
  }
  
  if (config.faq && Array.isArray(config.faq) && config.faq.length > 0) {
    parts.push('\n## Common Questions:');
    config.faq.forEach(item => {
      parts.push(`\nQ: ${item.q}`);
      parts.push(`A: ${item.a}`);
    });
  }
  
  if (config.business_hours) {
    parts.push(`\n## Business Hours: ${config.business_hours}`);
  }
  
  return parts.join('\n');
}

// ============================================
// 리드 감지 (이메일, 전화번호)
// ============================================
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?61|0)[\s.-]?4[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{3}|\d{10,11}/g;

function extractLeadInfo(text) {
  const emails = text.match(EMAIL_REGEX) || [];
  const phones = text.match(PHONE_REGEX) || [];
  if (emails.length === 0 && phones.length === 0) return null;
  return {
    email: emails[0] || null,
    phone: phones[0] || null
  };
}

// ============================================
// 메시지 중복 방지 (in-memory, 서버리스 환경에서는 제한적)
// ============================================
const processedMessages = new Set();
const MAX_CACHE_SIZE = 5000;

function isDuplicate(messageId) {
  if (!messageId) return false;
  return processedMessages.has(messageId);
}

function markProcessed(messageId) {
  if (!messageId) return;
  if (processedMessages.size >= MAX_CACHE_SIZE) {
    processedMessages.clear();
  }
  processedMessages.add(messageId);
}

// ============================================
// Vercel KV - 대화 로그 저장
// ============================================

/**
 * 대화 로그 저장
 * Key 구조:
 * - chat:{clientId}:{date}:{uniqueId} - 개별 대화
 * - chatindex:{clientId}:{date} - 날짜별 인덱스 (list)
 * - lead:{clientId}:{date}:{uniqueId} - 리드 정보
 * - leadindex:{clientId}:{date} - 리드 인덱스 (list)
 */
async function saveConversation(clientId, channel, userId, userMessage, botReply, responseTimeMs = 0, messageCount = 1) {
  if (!supabase) {
    console.log('Supabase not available, skipping conversation save');
    return;
  }
  
  if (!clientId) {
    console.log('No clientId provided, skipping conversation save');
    return;
  }
  
  try {
    const { data, error } = await supabase
      .from('conversations')
      .insert({
        client_id: clientId,
        messages: [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: botReply }
        ]
      })
      .select()
      .single();
    
    if (error) {
      console.error('[saveConversation] Insert error:', error);
      throw error;
    }
    
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const hour = now.getUTCHours();
    const aestHour = (hour + 11) % 24;
    const isAfterHours = aestHour < 9 || aestHour >= 17;
    
    const { data: existing } = await supabase
      .from('analytics')
      .select('*')
      .eq('client_id', clientId)
      .eq('date', date)
      .single();
    
    const analyticsData = {
      client_id: clientId,
      date,
      total_conversations: (existing?.total_conversations || 0) + 1,
      after_hours_conversations: (existing?.after_hours_conversations || 0) + (isAfterHours ? 1 : 0),
      avg_response_time: responseTimeMs > 0 
        ? Math.round(((existing?.avg_response_time || 0) * (existing?.total_conversations || 0) + responseTimeMs) / ((existing?.total_conversations || 0) + 1))
        : (existing?.avg_response_time || 0),
      avg_messages_per_conversation: Math.round(((existing?.avg_messages_per_conversation || 0) * (existing?.total_conversations || 0) + messageCount) / ((existing?.total_conversations || 0) + 1) * 10) / 10,
      peak_hour: aestHour,
      channel_webchat: (existing?.channel_webchat || 0) + (channel === 'webchat' ? 1 : 0),
      channel_instagram: (existing?.channel_instagram || 0) + (channel === 'instagram' ? 1 : 0)
    };
    
    await supabase.from('analytics').upsert(analyticsData, { onConflict: 'client_id,date' });
    
    if (userMessage && userMessage.trim().length > 0) {
      const shortQuestion = userMessage.trim().substring(0, 200);
      try {
        await supabase.rpc('increment_question_count', { 
          p_client_id: clientId, 
          p_question: shortQuestion 
        });
      } catch {
        await supabase.from('popular_questions').upsert({
          client_id: clientId,
          question: shortQuestion,
          count: 1,
          last_asked_at: new Date().toISOString()
        }, { onConflict: 'client_id,question' });
      }
    }
    
    return data;
  } catch (error) {
    console.error('[saveConversation] Failed:', error);
    return null;
  }
}

async function saveLead(clientId, channel, userId, leadData) {
  if (!supabase) {
    console.log('Supabase not available, skipping lead save');
    return;
  }
  
  try {
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (conversation) {
      await supabase
        .from('conversations')
        .update({
          lead_captured: true,
          lead_info: leadData
        })
        .eq('id', conversation.id);
    }
    
    const date = new Date().toISOString().split('T')[0];
    await supabase
      .from('analytics')
      .upsert({
        client_id: clientId,
        date,
        leads_captured: 1
      }, {
        onConflict: 'client_id,date',
        ignoreDuplicates: false
      });
    
    console.log(`Saved lead to Supabase for client: ${clientId}`);
    return leadData;
  } catch (error) {
    console.error('Failed to save lead:', error);
    return null;
  }
}

/**
 * 특정 기간의 통계 조회 (주간 리포트용)
 */
async function getWeeklyStats(clientId, startDate, endDate) {
  try {
    const stats = {
      totalChats: 0,
      totalLeads: 0,
      channelBreakdown: { instagram: 0, webchat: 0 },
      hourlyBreakdown: {},
      conversations: [],
      leads: []
    };
    
    // 날짜 범위 생성
    const dates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }
    
    // 각 날짜별 통계 수집
    for (const date of dates) {
      const statsKey = `stats:${clientId}:${date}`;
      const dayStats = await kv.hgetall(statsKey);
      
      if (dayStats) {
        stats.totalChats += parseInt(dayStats.totalChats || 0);
        stats.totalLeads += parseInt(dayStats.totalLeads || 0);
        stats.channelBreakdown.instagram += parseInt(dayStats['channel:instagram'] || 0);
        stats.channelBreakdown.webchat += parseInt(dayStats['channel:webchat'] || 0);
        
        // 시간대별 통계
        for (let h = 0; h < 24; h++) {
          const hourKey = `hour:${h}`;
          if (dayStats[hourKey]) {
            stats.hourlyBreakdown[h] = (stats.hourlyBreakdown[h] || 0) + parseInt(dayStats[hourKey]);
          }
        }
      }
      
      // 대화 샘플 수집 (최근 50개)
      const chatIndexKey = `chatindex:${clientId}:${date}`;
      const chatIds = await kv.lrange(chatIndexKey, 0, 49);
      for (const chatId of chatIds || []) {
        const chatKey = `chat:${clientId}:${date}:${chatId}`;
        const chat = await kv.get(chatKey);
        if (chat) stats.conversations.push(chat);
      }
      
      // 리드 수집
      const leadIndexKey = `leadindex:${clientId}:${date}`;
      const leadIds = await kv.lrange(leadIndexKey, 0, 99);
      for (const leadId of leadIds || []) {
        const leadKey = `lead:${clientId}:${date}:${leadId}`;
        const lead = await kv.get(leadKey);
        if (lead) stats.leads.push(lead);
      }
    }
    
    return stats;
  } catch (error) {
    console.error('Failed to get weekly stats:', error);
    return null;
  }
}

// ============================================
// Webhook 서명 검증
// ============================================
function verifySignature(payload, signature) {
  if (!META_APP_SECRET || !signature) return false;
  
  const expectedSignature = crypto
    .createHmac('sha256', META_APP_SECRET)
    .update(payload)
    .digest('hex');
  
  const receivedSignature = signature.replace('sha256=', '');
  
  if (expectedSignature.length !== receivedSignature.length) return false;
  
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(receivedSignature, 'hex')
  );
}

// ============================================
// OpenAI API 호출
// ============================================
async function getAIResponse(userMessage, client) {
  try {
    const systemPrompt = buildSystemPrompt(client);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      })
    });
    
    const data = await response.json();
    console.log('OpenAI API response:', JSON.stringify(data, null, 2));
    
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content;
    } else {
      console.error('Unexpected API response:', data);
      return 'Sorry, I could not process your message.';
    }
  } catch (error) {
    console.error('AI API error:', error);
    return 'Sorry, something went wrong.';
  }
}

// 웹챗용: 대화 히스토리 지원
async function getAIResponseWithHistory(messages, client) {
  try {
    const systemPrompt = buildSystemPrompt(client);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ]
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content;
    } else {
      console.error('Unexpected API response:', data);
      return 'Sorry, I could not process your message.';
    }
  } catch (error) {
    console.error('AI API error:', error);
    return 'Sorry, something went wrong.';
  }
}

// ============================================
// Instagram 메시지 전송
// ============================================
async function sendInstagramMessage(recipientId, message) {
  try {
    const response = await fetch('https://graph.instagram.com/v21.0/me/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + INSTAGRAM_ACCESS_TOKEN
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message }
      })
    });
    
    const data = await response.json();
    console.log('Instagram response:', data);
    
    if (!response.ok) {
      console.error('Instagram API error:', data);
    }
    
    return data;
  } catch (error) {
    console.error('Failed to send Instagram message:', error);
    throw error;
  }
}

// ============================================
// CORS 미들웨어
// ============================================
async function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  
  // CORS 헤더는 일단 설정 (async 전에 필요)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id');
  
  if (req.method === 'OPTIONS') {
    // preflight는 origin 검증 없이 허용
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    return res.status(200).end();
  }
  
  try {
    const client = await getClientByOrigin(origin);
    const allowedOrigins = client?.chatbot_configs?.[0]?.allowed_origins || [];
    
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      // 개발 환경 또는 기본값
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  } catch (error) {
    console.error('CORS middleware error:', error);
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  
  next();
}

// ============================================
// 라우트
// ============================================

// JSON 파싱 (webhook 제외 - raw body 필요)
app.use((req, res, next) => {
  if (req.path === '/webhook' && req.method === 'POST') {
    // webhook은 raw body로 받아서 서명 검증
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// 루트
app.get('/', (req, res) => {
  res.send('onmore Webhook Server Running');
});

// Webhook 검증 (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Instagram DM 수신 (POST)
app.post('/webhook', async (req, res) => {
  try {
    const rawBody = req.body;
    const signature = req.headers['x-hub-signature-256'];
    
    // 서명 검증 (META_APP_SECRET이 설정된 경우)
    if (META_APP_SECRET && signature) {
      if (!verifySignature(rawBody, signature)) {
        console.error('Invalid webhook signature!');
        return res.sendStatus(401);
      }
    }
    
    const body = JSON.parse(rawBody.toString());
    console.log('Received webhook:', JSON.stringify(body, null, 2));
    
    // 모든 entry 처리 (배치 지원)
    const entries = body.entry || [];
    
    for (const entry of entries) {
      const pageId = entry.id;
      const messagingEvents = entry.messaging || [];
      
      for (const event of messagingEvents) {
        await processMessagingEvent(event, pageId);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.sendStatus(500);
  }
});

async function processMessagingEvent(event, pageId) {
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  const message = event.message;
  
  if (!senderId || !message) return;
  
  // Echo 메시지 무시 (자기 메시지에 응답 방지)
  if (message.is_echo) {
    console.log('Ignoring echo message');
    return;
  }
  
  // 중복 메시지 무시
  const messageId = message.mid;
  if (isDuplicate(messageId)) {
    console.log(`Duplicate message ${messageId}, skipping`);
    return;
  }
  
  // 텍스트 메시지만 처리
  const userMessage = message.text;
  if (!userMessage) {
    console.log('Non-text message, skipping');
    return;
  }
  
  console.log(`[${pageId}] Message from ${senderId}: ${userMessage}`);
  
  try {
    const client = await getClientByInstagramId(recipientId);
    const clientId = client?.id || 'onmore';
    
    const aiResponse = await getAIResponse(userMessage, client);
    await sendInstagramMessage(senderId, aiResponse);
    
    await saveConversation(clientId, 'instagram', senderId, userMessage, aiResponse);
    
    const leadInfo = extractLeadInfo(userMessage);
    if (leadInfo) {
      await saveLead(clientId, 'instagram', senderId, leadInfo);
    }
    
    markProcessed(messageId);
  } catch (error) {
    console.error(`Error processing message ${messageId}:`, error);
  }
}

// 웹챗 API (POST /api/chat) - 스트리밍 지원
app.post('/api/chat', corsMiddleware, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { messages, clientId, stream } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array required' });
    }
    
    const origin = req.headers.origin;
    const client = await getClientByOrigin(origin);
    const resolvedClientId = clientId || client?.id;
    const messageCount = messages.filter(m => m.role === 'user').length;
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const systemPrompt = buildSystemPrompt(client);
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 500,
          temperature: 0.7,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ]
        })
      });
      
      let fullReply = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullReply += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            } catch (e) {}
          }
        }
      }
      
      const responseTimeMs = Date.now() - startTime;
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      const sessionId = req.headers['x-session-id'] || 'anonymous';
      await saveConversation(resolvedClientId, 'webchat', sessionId, lastUserMessage?.content || '', fullReply, responseTimeMs, messageCount);
      
      const allUserText = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
      const leadInfo = extractLeadInfo(allUserText);
      if (leadInfo) {
        await saveLead(resolvedClientId, 'webchat', sessionId, leadInfo);
      }
      
      res.end();
    } else {
      const reply = await getAIResponseWithHistory(messages, client);
      const responseTimeMs = Date.now() - startTime;
      
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      const sessionId = req.headers['x-session-id'] || 'anonymous';
      await saveConversation(resolvedClientId, 'webchat', sessionId, lastUserMessage?.content || '', reply, responseTimeMs, messageCount);
      
      const allUserText = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
      const leadInfo = extractLeadInfo(allUserText);
      if (leadInfo) {
        await saveLead(resolvedClientId, 'webchat', sessionId, leadInfo);
      }
      
      return res.status(200).json({ reply });
    }
  } catch (error) {
    console.error('Chat API error:', error);
    return res.status(500).json({ error: 'Failed to get response' });
  }
});

// OPTIONS preflight
app.options('/api/chat', corsMiddleware);

app.post('/api/engagement', corsMiddleware, express.json(), async (req, res) => {
  try {
    const data = req.body;
    
    const geoInfo = {
      ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
      country: req.headers['x-vercel-ip-country'] || null,
      city: req.headers['x-vercel-ip-city'] || null,
      region: req.headers['x-vercel-ip-country-region'] || null
    };
    
    console.log('[engagement] Received:', data.eventType, 'Geo:', geoInfo.country, geoInfo.city);
    
    if (!supabase) {
      return res.status(200).json({ ok: true });
    }
    
    const origin = req.headers.origin;
    const client = await getClientByOrigin(origin);
    const clientId = client?.id;
    
    if (!clientId) {
      console.log('[engagement] No client found for origin:', origin);
      return res.status(200).json({ ok: true });
    }
    
    const date = new Date().toISOString().split('T')[0];
    
    const { data: existing } = await supabase
      .from('engagement_stats')
      .select('*')
      .eq('client_id', clientId)
      .eq('date', date)
      .single();
    
    const stats = existing || {
      client_id: clientId,
      date: date,
      page_views: 0,
      chat_opens: 0,
      first_messages: 0,
      total_time_to_open: 0,
      total_time_to_first_msg: 0,
      total_session_duration: 0,
      sessions_with_chat: 0,
      sessions_with_message: 0,
      device_mobile: 0,
      device_desktop: 0,
      bounce_sessions: 0,
      engaged_sessions: 0
    };
    
    if (data.eventType === 'page_view') {
      stats.page_views++;
      if (data.device === 'mobile') {
        stats.device_mobile++;
      } else {
        stats.device_desktop++;
      }
    } else if (data.eventType === 'chat_opened') {
      stats.chat_opens++;
      stats.sessions_with_chat++;
      if (data.timeToOpen) {
        stats.total_time_to_open += data.timeToOpen;
      }
    } else if (data.eventType === 'first_message') {
      stats.first_messages++;
      stats.sessions_with_message++;
      if (data.timeToFirstMessage) {
        stats.total_time_to_first_msg += data.timeToFirstMessage;
      }
    } else if (data.eventType === 'session_end' || data.eventType === 'page_hidden') {
      if (data.sessionDuration) {
        stats.total_session_duration += data.sessionDuration;
      }
      if (!data.chatOpenTime) {
        stats.bounce_sessions++;
      } else {
        stats.engaged_sessions++;
      }
    }
    
    await supabase.from('engagement_stats').upsert(stats, { 
      onConflict: 'client_id,date' 
    });
    
    // Save raw event for detailed analytics
    if (data.eventType === 'session_end' || data.eventType === 'chat_closed') {
      await supabase.from('engagement_events').insert({
        client_id: clientId,
        session_id: data.sessionId,
        event_type: data.eventType,
        device: data.device,
        browser: data.browser,
        os: data.os,
        referrer: data.referrer,
        referrer_full: data.referrerFull,
        page_url: data.pageUrl,
        page_path: data.pagePath,
        screen_width: data.screenWidth,
        screen_height: data.screenHeight,
        viewport_width: data.viewportWidth,
        viewport_height: data.viewportHeight,
        timezone: data.timezone,
        language: data.language,
        country: geoInfo.country,
        city: geoInfo.city,
        region: geoInfo.region,
        time_to_open: data.timeToOpen,
        time_to_first_message: data.timeToFirstMessage,
        session_duration: data.sessionDuration,
        message_count: data.messageCount || 0,
        created_at: new Date().toISOString()
      }).catch(err => console.log('[engagement] Event insert error:', err.message));
    }
    
    const hour = new Date().getHours();
    const { data: hourlyData } = await supabase
      .from('hourly_traffic')
      .select('*')
      .eq('client_id', clientId)
      .eq('date', date)
      .eq('hour', hour)
      .single();
    
    if (hourlyData) {
      await supabase.from('hourly_traffic').update({
        visits: (hourlyData.visits || 0) + 1,
        chats: (hourlyData.chats || 0) + (data.eventType === 'chat_opened' ? 1 : 0)
      }).eq('id', hourlyData.id);
    } else {
      await supabase.from('hourly_traffic').insert({
        client_id: clientId,
        date: date,
        hour: hour,
        visits: 1,
        chats: data.eventType === 'chat_opened' ? 1 : 0
      });
    }
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Engagement tracking error:', error);
    res.status(200).json({ ok: true });
  }
});

app.options('/api/engagement', corsMiddleware);

// ============================================
// Weekly Report API
// ============================================
const weeklyReportHandler = require('./api/cron/weekly-report');
app.get('/api/cron/weekly-report', weeklyReportHandler);
app.post('/api/cron/weekly-report', weeklyReportHandler);

// ============================================
// Data Backup API
// ============================================
const backupHandler = require('./api/cron/backup-data');
app.get('/api/cron/backup-data', backupHandler);
app.post('/api/cron/backup-data', backupHandler);

// ============================================
// 서버 시작
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
