const { kv } = require('@vercel/kv');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'hello@onmore.au';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const BUSINESS_HOURS = { start: 9, end: 17 };
const AVG_MINUTES_PER_CHAT = 3;
const HOURLY_STAFF_COST = 35;

async function getWeeklyStats(clientId, startDate, endDate) {
  const stats = {
    totalChats: 0,
    totalLeads: 0,
    channelBreakdown: { instagram: 0, webchat: 0 },
    hourlyBreakdown: {},
    conversations: [],
    leads: []
  };

  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  for (const date of dates) {
    const statsKey = `stats:${clientId}:${date}`;
    const dayStats = await kv.hgetall(statsKey);

    if (dayStats) {
      stats.totalChats += parseInt(dayStats.totalChats || 0);
      stats.totalLeads += parseInt(dayStats.totalLeads || 0);
      stats.channelBreakdown.instagram += parseInt(dayStats['channel:instagram'] || 0);
      stats.channelBreakdown.webchat += parseInt(dayStats['channel:webchat'] || 0);

      for (let h = 0; h < 24; h++) {
        const hourKey = `hour:${h}`;
        if (dayStats[hourKey]) {
          stats.hourlyBreakdown[h] = (stats.hourlyBreakdown[h] || 0) + parseInt(dayStats[hourKey]);
        }
      }
    }

    const chatIndexKey = `chatindex:${clientId}:${date}`;
    const chatIds = await kv.lrange(chatIndexKey, 0, 99);
    for (const chatId of chatIds || []) {
      const chatKey = `chat:${clientId}:${date}:${chatId}`;
      const chat = await kv.get(chatKey);
      if (chat) stats.conversations.push(chat);
    }

    const leadIndexKey = `leadindex:${clientId}:${date}`;
    const leadIds = await kv.lrange(leadIndexKey, 0, 99);
    for (const leadId of leadIds || []) {
      const leadKey = `lead:${clientId}:${date}:${leadId}`;
      const lead = await kv.get(leadKey);
      if (lead) stats.leads.push(lead);
    }
  }

  return stats;
}

function getPeakHour(hourlyBreakdown) {
  let maxHour = 0;
  let maxCount = 0;
  for (const [hour, count] of Object.entries(hourlyBreakdown)) {
    if (count > maxCount) {
      maxCount = count;
      maxHour = parseInt(hour);
    }
  }
  return { hour: maxHour, count: maxCount };
}

function getAfterHoursStats(conversations) {
  let afterHoursCount = 0;
  let weekendCount = 0;
  
  for (const conv of conversations) {
    const date = new Date(conv.timestamp);
    const aestHour = (date.getUTCHours() + 11) % 24;
    const dayOfWeek = date.getUTCDay();
    
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isAfterHours = aestHour < BUSINESS_HOURS.start || aestHour >= BUSINESS_HOURS.end;
    
    if (isWeekend) weekendCount++;
    else if (isAfterHours) afterHoursCount++;
  }
  
  const total = conversations.length;
  return {
    afterHoursCount,
    weekendCount,
    outsideBusinessHours: afterHoursCount + weekendCount,
    percentage: total > 0 ? Math.round(((afterHoursCount + weekendCount) / total) * 100) : 0
  };
}

function calculateROI(totalChats, totalLeads) {
  const minutesSaved = totalChats * AVG_MINUTES_PER_CHAT;
  const hoursSaved = Math.round(minutesSaved / 60 * 10) / 10;
  const moneySaved = Math.round(hoursSaved * HOURLY_STAFF_COST);
  const conversionRate = totalChats > 0 ? Math.round((totalLeads / totalChats) * 100) : 0;
  
  return { minutesSaved, hoursSaved, moneySaved, conversionRate };
}

async function analyzeWithGPT(prompt, systemPrompt) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ]
      })
    });
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '[]';
  } catch (error) {
    console.error('GPT analysis failed:', error);
    return '[]';
  }
}

async function getTopQuestions(conversations, limit = 5) {
  const messages = conversations.map(c => c.userMessage).filter(m => m && m.trim().length > 0);
  if (messages.length === 0) return [];
  
  const content = await analyzeWithGPT(
    messages.join('\n'),
    `Analyze these customer messages and group them into top ${limit} question categories. Count how many messages fit each category. Return JSON array only: [{"question": "category description", "count": number}]. Be concise. Korean or English based on input.`
  );
  
  try {
    const parsed = JSON.parse(content.replace(/```json\n?|\n?```/g, ''));
    return parsed.slice(0, limit);
  } catch {
    return [];
  }
}

async function getUnansweredQuestions(conversations, limit = 5) {
  const pairs = conversations
    .filter(c => c.userMessage && c.botReply)
    .map(c => `Q: ${c.userMessage}\nA: ${c.botReply}`)
    .slice(0, 50);
  
  if (pairs.length === 0) return [];
  
  const content = await analyzeWithGPT(
    pairs.join('\n\n'),
    `Analyze these Q&A pairs. Find questions where the bot couldn't give a satisfying answer (vague, "I don't know", redirecting to human, etc). Return JSON array: [{"question": "the question topic", "issue": "brief reason why answer was inadequate"}]. Max ${limit} items. Be concise.`
  );
  
  try {
    const parsed = JSON.parse(content.replace(/```json\n?|\n?```/g, ''));
    return parsed.slice(0, limit);
  } catch {
    return [];
  }
}

function formatAEST(utcHour) {
  const aestHour = (utcHour + 11) % 24;
  const period = aestHour >= 12 ? 'PM' : 'AM';
  const hour12 = aestHour % 12 || 12;
  return `${hour12}${period}`;
}

function buildSummaryHtml(stats, startDate, endDate, afterHours, roi) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif;
      background: #f5f5f7;
      color: #1d1d1f;
      line-height: 1.47059;
      font-weight: 400;
      letter-spacing: -0.022em;
      padding: 0;
      margin: 0;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    .card {
      background: #ffffff;
      border-radius: 20px;
      padding: 32px;
      margin-bottom: 16px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.04);
    }
    .header {
      text-align: center;
      margin-bottom: 8px;
    }
    .logo {
      font-size: 28px;
      font-weight: 600;
      background: linear-gradient(135deg, #0071e3 0%, #42a5f5 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 4px;
    }
    .period {
      font-size: 15px;
      color: #86868b;
      font-weight: 400;
    }
    .hero-stat {
      text-align: center;
      padding: 40px 0;
    }
    .hero-value {
      font-size: 72px;
      font-weight: 600;
      letter-spacing: -0.03em;
      color: #1d1d1f;
      line-height: 1;
    }
    .hero-label {
      font-size: 17px;
      color: #86868b;
      margin-top: 8px;
      font-weight: 500;
    }
    .metrics-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .metric {
      flex: 1;
      text-align: center;
      padding: 20px 12px;
      background: #f5f5f7;
      border-radius: 14px;
    }
    .metric-value {
      font-size: 28px;
      font-weight: 600;
      color: #1d1d1f;
    }
    .metric-label {
      font-size: 12px;
      color: #86868b;
      margin-top: 4px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .highlight-card {
      background: linear-gradient(135deg, #34c759 0%, #30d158 100%);
      color: white;
      text-align: center;
      padding: 28px;
    }
    .highlight-card .metric-value {
      color: white;
      font-size: 44px;
    }
    .highlight-card .metric-label {
      color: rgba(255,255,255,0.85);
      font-size: 15px;
      margin-top: 6px;
    }
    .highlight-card .subtext {
      font-size: 13px;
      color: rgba(255,255,255,0.7);
      margin-top: 12px;
    }
    .insight-row {
      display: flex;
      gap: 12px;
    }
    .insight-card {
      flex: 1;
      background: #f5f5f7;
      border-radius: 14px;
      padding: 20px;
      text-align: center;
    }
    .insight-value {
      font-size: 24px;
      font-weight: 600;
      color: #1d1d1f;
    }
    .insight-label {
      font-size: 11px;
      color: #86868b;
      margin-top: 4px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .footer {
      text-align: center;
      padding: 24px;
      color: #86868b;
      font-size: 12px;
    }
    .footer a {
      color: #0071e3;
      text-decoration: none;
    }
    .divider {
      height: 1px;
      background: #e8e8ed;
      margin: 24px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="logo">onmore</div>
        <div class="period">${startDate} — ${endDate}</div>
      </div>
      
      <div class="hero-stat">
        <div class="hero-value">${stats.totalChats}</div>
        <div class="hero-label">Conversations Handled</div>
      </div>
      
      <div class="metrics-row">
        <div class="metric">
          <div class="metric-value">${stats.totalLeads}</div>
          <div class="metric-label">Leads</div>
        </div>
        <div class="metric">
          <div class="metric-value">${roi.conversionRate}%</div>
          <div class="metric-label">Conversion</div>
        </div>
        <div class="metric">
          <div class="metric-value">${afterHours.percentage}%</div>
          <div class="metric-label">After Hours</div>
        </div>
      </div>
    </div>
    
    <div class="card highlight-card">
      <div class="metric-value">$${roi.moneySaved}</div>
      <div class="metric-label">Estimated Savings</div>
      <div class="subtext">${roi.hoursSaved} hours of staff time saved</div>
    </div>
    
    <div class="card">
      <div class="insight-row">
        <div class="insight-card">
          <div class="insight-value">${stats.channelBreakdown.webchat}</div>
          <div class="insight-label">Website</div>
        </div>
        <div class="insight-card">
          <div class="insight-value">${stats.channelBreakdown.instagram}</div>
          <div class="insight-label">Instagram</div>
        </div>
        <div class="insight-card">
          <div class="insight-value">${afterHours.outsideBusinessHours}</div>
          <div class="insight-label">Off-Hours</div>
        </div>
      </div>
    </div>
    
    <div class="footer">
      <p>Powered by <a href="https://onmore.au">onmore.au</a></p>
    </div>
  </div>
</body>
</html>
  `;
}

async function buildDetailHtml(stats, startDate, endDate, afterHours, roi, peak, topQuestions, unansweredQuestions) {
  const topQuestionsHtml = topQuestions.length > 0
    ? topQuestions.map((q, i) => `
        <div class="list-item">
          <span class="list-number">${i + 1}</span>
          <div class="list-content">
            <div class="list-title">${q.question}</div>
            <div class="list-meta">${q.count} conversations</div>
          </div>
        </div>
      `).join('')
    : '<div class="empty-state">No conversations this period</div>';

  const unansweredHtml = unansweredQuestions.length > 0
    ? unansweredQuestions.map(q => `
        <div class="alert-item">
          <div class="alert-title">${q.question}</div>
          <div class="alert-desc">${q.issue}</div>
        </div>
      `).join('')
    : '';

  const leadsHtml = stats.leads.length > 0
    ? stats.leads.map(l => {
        const time = new Date(l.timestamp);
        const aestTime = new Date(time.getTime() + 11 * 60 * 60 * 1000);
        const timeStr = aestTime.toLocaleString('en-AU', { 
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true 
        });
        return `
        <div class="lead-item">
          <div class="lead-info">
            <div class="lead-email">${l.email || 'No email'}</div>
            <div class="lead-meta">${l.phone || 'No phone'} · ${l.channel} · ${timeStr}</div>
          </div>
        </div>
      `;
      }).join('')
    : '<div class="empty-state">No leads captured this period</div>';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif;
      background: #f5f5f7;
      color: #1d1d1f;
      line-height: 1.47059;
      font-weight: 400;
      letter-spacing: -0.022em;
      padding: 0;
      margin: 0;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    .card {
      background: #ffffff;
      border-radius: 20px;
      padding: 28px;
      margin-bottom: 16px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.04);
    }
    .header {
      text-align: center;
      margin-bottom: 8px;
    }
    .logo {
      font-size: 28px;
      font-weight: 600;
      background: linear-gradient(135deg, #0071e3 0%, #42a5f5 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 4px;
    }
    .badge {
      display: inline-block;
      background: #f5f5f7;
      color: #86868b;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 100px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    .period {
      font-size: 15px;
      color: #86868b;
      font-weight: 400;
    }
    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: #86868b;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 16px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .stat-box {
      background: #f5f5f7;
      border-radius: 14px;
      padding: 20px;
      text-align: center;
    }
    .stat-value {
      font-size: 32px;
      font-weight: 600;
      color: #1d1d1f;
      line-height: 1.1;
    }
    .stat-label {
      font-size: 12px;
      color: #86868b;
      margin-top: 4px;
      font-weight: 500;
    }
    .stat-box.highlight {
      background: linear-gradient(135deg, #34c759 0%, #30d158 100%);
    }
    .stat-box.highlight .stat-value,
    .stat-box.highlight .stat-label {
      color: white;
    }
    .stat-box.blue {
      background: linear-gradient(135deg, #0071e3 0%, #42a5f5 100%);
    }
    .stat-box.blue .stat-value,
    .stat-box.blue .stat-label {
      color: white;
    }
    .roi-banner {
      background: linear-gradient(135deg, #1d1d1f 0%, #424245 100%);
      border-radius: 16px;
      padding: 24px;
      display: flex;
      justify-content: space-around;
      text-align: center;
    }
    .roi-item .roi-value {
      font-size: 28px;
      font-weight: 600;
      color: #fff;
    }
    .roi-item .roi-label {
      font-size: 11px;
      color: rgba(255,255,255,0.6);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .list-item {
      display: flex;
      align-items: flex-start;
      padding: 14px 0;
      border-bottom: 1px solid #f5f5f7;
    }
    .list-item:last-child {
      border-bottom: none;
    }
    .list-number {
      width: 28px;
      height: 28px;
      background: #f5f5f7;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      color: #86868b;
      margin-right: 14px;
      flex-shrink: 0;
    }
    .list-content {
      flex: 1;
    }
    .list-title {
      font-size: 15px;
      font-weight: 500;
      color: #1d1d1f;
    }
    .list-meta {
      font-size: 13px;
      color: #86868b;
      margin-top: 2px;
    }
    .alert-card {
      background: #fff5f5;
      border-left: 4px solid #ff3b30;
    }
    .alert-item {
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,59,48,0.1);
    }
    .alert-item:last-child {
      border-bottom: none;
    }
    .alert-title {
      font-size: 14px;
      font-weight: 500;
      color: #1d1d1f;
    }
    .alert-desc {
      font-size: 13px;
      color: #86868b;
      margin-top: 2px;
    }
    .lead-item {
      padding: 14px 0;
      border-bottom: 1px solid #f5f5f7;
    }
    .lead-item:last-child {
      border-bottom: none;
    }
    .lead-email {
      font-size: 15px;
      font-weight: 500;
      color: #1d1d1f;
    }
    .lead-meta {
      font-size: 13px;
      color: #86868b;
      margin-top: 2px;
    }
    .empty-state {
      text-align: center;
      padding: 24px;
      color: #86868b;
      font-size: 14px;
    }
    .peak-info {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: #f5f5f7;
      border-radius: 12px;
    }
    .peak-time {
      font-size: 17px;
      font-weight: 600;
      color: #1d1d1f;
    }
    .peak-count {
      font-size: 14px;
      color: #86868b;
    }
    .channel-row {
      display: flex;
      gap: 12px;
      margin-top: 12px;
    }
    .channel-item {
      flex: 1;
      background: #f5f5f7;
      border-radius: 12px;
      padding: 16px;
      text-align: center;
    }
    .channel-value {
      font-size: 24px;
      font-weight: 600;
      color: #1d1d1f;
    }
    .channel-label {
      font-size: 12px;
      color: #86868b;
      margin-top: 2px;
    }
    .footer {
      text-align: center;
      padding: 24px;
      color: #86868b;
      font-size: 12px;
    }
    .footer a {
      color: #0071e3;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="logo">onmore</div>
        <div class="badge">Detailed Report</div>
        <div class="period">${startDate} — ${endDate}</div>
      </div>
    </div>
    
    <div class="card">
      <div class="section-title">Performance Overview</div>
      <div class="stats-grid">
        <div class="stat-box blue">
          <div class="stat-value">${stats.totalChats}</div>
          <div class="stat-label">Total Conversations</div>
        </div>
        <div class="stat-box highlight">
          <div class="stat-value">${stats.totalLeads}</div>
          <div class="stat-label">Leads Captured</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${roi.conversionRate}%</div>
          <div class="stat-label">Conversion Rate</div>
        </div>
        <div class="stat-box">
          <div class="stat-value">${afterHours.percentage}%</div>
          <div class="stat-label">After Hours</div>
        </div>
      </div>
    </div>
    
    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="roi-banner">
        <div class="roi-item">
          <div class="roi-value">${roi.hoursSaved}h</div>
          <div class="roi-label">Time Saved</div>
        </div>
        <div class="roi-item">
          <div class="roi-value">$${roi.moneySaved}</div>
          <div class="roi-label">Cost Saved</div>
        </div>
        <div class="roi-item">
          <div class="roi-value">${afterHours.outsideBusinessHours}</div>
          <div class="roi-label">Off-Hours Caught</div>
        </div>
      </div>
    </div>
    
    <div class="card">
      <div class="section-title">Activity Breakdown</div>
      <div class="peak-info">
        <div>
          <div class="peak-time">${formatAEST(peak.hour)} AEST</div>
          <div class="peak-count">Peak activity time</div>
        </div>
        <div style="text-align: right;">
          <div class="peak-time">${peak.count}</div>
          <div class="peak-count">messages</div>
        </div>
      </div>
      <div class="channel-row">
        <div class="channel-item">
          <div class="channel-value">${stats.channelBreakdown.webchat}</div>
          <div class="channel-label">Website</div>
        </div>
        <div class="channel-item">
          <div class="channel-value">${stats.channelBreakdown.instagram}</div>
          <div class="channel-label">Instagram</div>
        </div>
        <div class="channel-item">
          <div class="channel-value">${afterHours.weekendCount}</div>
          <div class="channel-label">Weekend</div>
        </div>
        <div class="channel-item">
          <div class="channel-value">${afterHours.afterHoursCount}</div>
          <div class="channel-label">Evening</div>
        </div>
      </div>
    </div>
    
    <div class="card">
      <div class="section-title">Top Questions</div>
      ${topQuestionsHtml}
    </div>
    
    ${unansweredQuestions.length > 0 ? `
    <div class="card alert-card">
      <div class="section-title" style="color: #ff3b30;">Needs Attention</div>
      ${unansweredHtml}
    </div>
    ` : ''}
    
    <div class="card">
      <div class="section-title">Leads Captured</div>
      ${leadsHtml}
    </div>
    
    <div class="footer">
      <p>Powered by <a href="https://onmore.au">onmore.au</a></p>
    </div>
  </div>
</body>
</html>
  `;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const now = new Date();
    let startStr, endStr;
    const version = req.query.version || 'detail';
    
    if (req.query.start && req.query.end) {
      startStr = req.query.start;
      endStr = req.query.end;
    } else {
      const endDate = new Date(now);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6);
      startStr = startDate.toISOString().split('T')[0];
      endStr = endDate.toISOString().split('T')[0];
    }

    const stats = await getWeeklyStats('onmore', startStr, endStr);

    if (!stats) {
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }

    const afterHours = getAfterHoursStats(stats.conversations);
    const roi = calculateROI(stats.totalChats, stats.totalLeads);
    const peak = getPeakHour(stats.hourlyBreakdown);

    let emailHtml;
    let subject;
    
    if (version === 'summary') {
      emailHtml = buildSummaryHtml(stats, startStr, endStr, afterHours, roi);
      subject = `Chatbot Summary: ${startStr} - ${endStr}`;
    } else {
      const [topQuestions, unansweredQuestions] = await Promise.all([
        getTopQuestions(stats.conversations),
        getUnansweredQuestions(stats.conversations)
      ]);
      emailHtml = await buildDetailHtml(stats, startStr, endStr, afterHours, roi, peak, topQuestions, unansweredQuestions);
      subject = `Chatbot Report: ${startStr} - ${endStr}`;
    }

    const { data, error } = await resend.emails.send({
      from: 'onmore <onboarding@resend.dev>',
      to: [REPORT_EMAIL],
      subject,
      html: emailHtml
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Failed to send email', details: error });
    }

    console.log('Report sent:', data);
    return res.status(200).json({
      success: true,
      emailId: data?.id,
      version,
      period: { start: startStr, end: endStr },
      stats: {
        totalChats: stats.totalChats,
        totalLeads: stats.totalLeads
      }
    });
  } catch (error) {
    console.error('Report error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
