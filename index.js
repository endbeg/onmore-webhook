const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// ============================================
// 환경변수
// ============================================
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'onmore_webhook_token_2024';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const META_APP_SECRET = process.env.META_APP_SECRET;

// ============================================
// Config 로더
// ============================================
function loadConfig() {
  const clientsPath = path.join(__dirname, 'config', 'clients.json');
  const clients = JSON.parse(fs.readFileSync(clientsPath, 'utf-8'));
  return clients;
}

function loadPrompt(promptFile) {
  const promptPath = path.join(__dirname, 'config', 'prompts', promptFile);
  return JSON.parse(fs.readFileSync(promptPath, 'utf-8'));
}

function getClientByOrigin(origin) {
  const config = loadConfig();
  for (const client of config.clients) {
    if (client.active && client.allowedOrigins.some(o => origin?.includes(o) || o.includes(origin))) {
      return client;
    }
  }
  // fallback to default
  return config.clients.find(c => c.id === config.defaultClientId);
}

function getClientByInstagramId(recipientId) {
  const config = loadConfig();
  for (const client of config.clients) {
    if (client.active && client.instagramRecipientIds.includes(recipientId)) {
      return client;
    }
  }
  // fallback to default
  return config.clients.find(c => c.id === config.defaultClientId);
}

function buildSystemPrompt(prompt) {
  const parts = [];
  
  // Identity
  parts.push(prompt.system.identity);
  
  // Role
  parts.push('\nYour role:\n' + prompt.system.role.map(r => '- ' + r).join('\n'));
  
  // Services & Pricing
  parts.push('\nOur services:');
  for (const svc of prompt.services) {
    const priceStr = `$${svc.price}/${svc.period}`;
    const badge = svc.badge ? ` (${svc.badge})` : '';
    parts.push(`- ${svc.name}: ${priceStr}${badge} - ${svc.features.join(', ')}`);
  }
  
  // Business info
  parts.push(`\nBusiness: ${prompt.business.name} (${prompt.business.domain})`);
  parts.push(`Location: ${prompt.business.location}`);
  parts.push(`Guarantee: ${prompt.business.guarantee}`);
  
  // FAQ (optional context)
  if (prompt.faq && prompt.faq.length > 0) {
    parts.push('\nCommon Q&A for reference:');
    for (const item of prompt.faq.slice(0, 5)) {
      parts.push(`Q: ${item.q}\nA: ${item.a}`);
    }
  }
  
  // Rules
  parts.push('\n' + prompt.system.rules.join('\n'));
  
  return parts.join('\n');
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
async function getAIResponse(userMessage, clientId = 'onmore') {
  try {
    const config = loadConfig();
    const client = config.clients.find(c => c.id === clientId) || config.clients[0];
    const prompt = loadPrompt(client.promptFile);
    const systemPrompt = buildSystemPrompt(prompt);
    
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
async function getAIResponseWithHistory(messages, clientId = 'onmore') {
  try {
    const config = loadConfig();
    const client = config.clients.find(c => c.id === clientId) || config.clients[0];
    const prompt = loadPrompt(client.promptFile);
    const systemPrompt = buildSystemPrompt(prompt);
    
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
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const client = getClientByOrigin(origin);
  
  if (client && client.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // 개발 환경 또는 기본값
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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
  // 먼저 200 응답 (Meta는 20초 내 응답 필요)
  res.sendStatus(200);
  
  try {
    const rawBody = req.body;
    const signature = req.headers['x-hub-signature-256'];
    
    // 서명 검증 (META_APP_SECRET이 설정된 경우)
    if (META_APP_SECRET && signature) {
      if (!verifySignature(rawBody, signature)) {
        console.error('Invalid webhook signature!');
        return;
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
  } catch (error) {
    console.error('Webhook processing error:', error);
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
    // 클라이언트 식별
    const client = getClientByInstagramId(recipientId);
    const clientId = client?.id || 'onmore';
    
    const aiResponse = await getAIResponse(userMessage, clientId);
    await sendInstagramMessage(senderId, aiResponse);
    
    // 처리 완료 표시
    markProcessed(messageId);
  } catch (error) {
    console.error(`Error processing message ${messageId}:`, error);
  }
}

// 웹챗 API (POST /api/chat)
app.post('/api/chat', corsMiddleware, async (req, res) => {
  try {
    const { messages, clientId } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array required' });
    }
    
    // Origin 기반 클라이언트 식별
    const origin = req.headers.origin;
    const client = getClientByOrigin(origin);
    const resolvedClientId = clientId || client?.id || 'onmore';
    
    const reply = await getAIResponseWithHistory(messages, resolvedClientId);
    
    return res.status(200).json({ reply });
  } catch (error) {
    console.error('Chat API error:', error);
    return res.status(500).json({ error: 'Failed to get response' });
  }
});

// OPTIONS preflight
app.options('/api/chat', corsMiddleware);

// ============================================
// 서버 시작
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
