const express = require('express');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = 'onmore_webhook_token_2024';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Webhook 검증
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

// Instagram DM 수신 및 AI 응답
app.post('/webhook', async (req, res) => {
  console.log('Received webhook:', JSON.stringify(req.body, null, 2));
  
  try {
    const entry = req.body.entry?.[0];
    const messaging = entry?.messaging?.[0];
    
    if (messaging?.message?.text) {
      const senderId = messaging.sender.id;
      const userMessage = messaging.message.text;
      
      console.log(`Message from ${senderId}: ${userMessage}`);
      
      // Claude AI 응답 생성
      const aiResponse = await getAIResponse(userMessage);
      
      // Instagram으로 답장 전송
      await sendInstagramMessage(senderId, aiResponse);
    }
  } catch (error) {
    console.error('Error:', error);
  }
  
  res.sendStatus(200);
});

// Claude API 호출
async function getAIResponse(userMessage) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: userMessage
      }],
      system: 'You are a helpful customer service assistant for onmore.au, a web development business in Australia. Keep responses brief and friendly. Respond in the same language the customer uses.'
    })
  });
  
  const data = await response.json();
  return data.content[0].text;
}

// Instagram 메시지 전송
async function sendInstagramMessage(recipientId, message) {
  const response = await fetch(`https://graph.instagram.com/v21.0/me/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${INSTAGRAM_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: message }
    })
  });
  
  const data = await response.json();
  console.log('Instagram response:', data);
  return data;
}

app.get('/', (req, res) => {
  res.send('onmore Webhook Server Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});