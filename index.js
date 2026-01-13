const express = require('express');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = 'onmore_webhook_token_2024';

// Webhook 검증 (Meta가 처음 연결할 때 사용)
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

// Instagram DM 수신
app.post('/webhook', (req, res) => {
  console.log('Received webhook:', JSON.stringify(req.body, null, 2));
  
  // TODO: 여기서 AI 응답 생성하고 답장 보내기
  
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('onmore Webhook Server Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});