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
  return `${hour12}${period} AEST`;
}

async function buildEmailHtml(stats, startDate, endDate) {
  const peak = getPeakHour(stats.hourlyBreakdown);
  const afterHours = getAfterHoursStats(stats.conversations);
  const roi = calculateROI(stats.totalChats, stats.totalLeads);
  
  const [topQuestions, unansweredQuestions] = await Promise.all([
    getTopQuestions(stats.conversations),
    getUnansweredQuestions(stats.conversations)
  ]);

  const topQuestionsHtml = topQuestions.length > 0
    ? topQuestions.map(q => `<li>"${q.question}" (${q.count}x)</li>`).join('')
    : '<li>No conversations this period</li>';

  const unansweredHtml = unansweredQuestions.length > 0
    ? unansweredQuestions.map(q => `<li><strong>${q.question}</strong><br><span style="color: #666; font-size: 13px;">${q.issue}</span></li>`).join('')
    : '<li>All questions answered well!</li>';

  const leadsHtml = stats.leads.length > 0
    ? stats.leads.map(l => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${l.name || '-'}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${l.email || '-'}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${l.phone || '-'}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${l.channel}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" style="padding: 16px; text-align: center; color: #666;">No leads this period</td></tr>';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 8px 0 0; opacity: 0.9; }
    .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; }
    .stat-value { font-size: 32px; font-weight: bold; color: #667eea; }
    .stat-label { color: #666; font-size: 14px; }
    .highlight-card { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; }
    .highlight-card .stat-value { color: white; }
    .highlight-card .stat-label { color: rgba(255,255,255,0.9); }
    .roi-section { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 0 8px 8px 0; margin-bottom: 24px; }
    .roi-section h3 { margin: 0 0 12px; color: #92400e; }
    .roi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .roi-item { text-align: center; }
    .roi-value { font-size: 24px; font-weight: bold; color: #92400e; }
    .roi-label { font-size: 12px; color: #a16207; }
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 18px; border-bottom: 2px solid #667eea; padding-bottom: 8px; margin-bottom: 16px; }
    .warning-section { background: #fef2f2; border-left: 4px solid #ef4444; padding: 16px; border-radius: 0 8px 8px 0; }
    .warning-section h3 { margin: 0 0 12px; color: #dc2626; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f8f9fa; padding: 12px 8px; text-align: left; font-size: 14px; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; }
    ul { padding-left: 20px; }
    li { margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Weekly Chatbot Report</h1>
    <p>${startDate} - ${endDate}</p>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${stats.totalChats}</div>
      <div class="stat-label">Total Conversations</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.totalLeads}</div>
      <div class="stat-label">Leads Captured</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.channelBreakdown.webchat}</div>
      <div class="stat-label">Website Chats</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.channelBreakdown.instagram}</div>
      <div class="stat-label">Instagram DMs</div>
    </div>
  </div>

  <div class="stats-grid">
    <div class="highlight-card">
      <div class="stat-value">${afterHours.outsideBusinessHours}</div>
      <div class="stat-label">After-Hours Chats (${afterHours.percentage}%)</div>
    </div>
    <div class="highlight-card">
      <div class="stat-value">${roi.conversionRate}%</div>
      <div class="stat-label">Lead Conversion Rate</div>
    </div>
  </div>

  <div class="roi-section">
    <h3>💰 Estimated Savings</h3>
    <div class="roi-grid">
      <div class="roi-item">
        <div class="roi-value">${roi.hoursSaved}h</div>
        <div class="roi-label">Staff Time Saved</div>
      </div>
      <div class="roi-item">
        <div class="roi-value">$${roi.moneySaved}</div>
        <div class="roi-label">Est. Cost Saved</div>
      </div>
      <div class="roi-item">
        <div class="roi-value">${afterHours.outsideBusinessHours}</div>
        <div class="roi-label">Missed Inquiries Caught</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>📊 Peak Activity</h2>
    <p>Busiest time: <strong>${formatAEST(peak.hour)}</strong> (${peak.count} messages)</p>
    <p style="color: #666; font-size: 14px;">After-hours breakdown: ${afterHours.afterHoursCount} evening/morning + ${afterHours.weekendCount} weekend</p>
  </div>

  <div class="section">
    <h2>❓ Top Questions</h2>
    <ol>${topQuestionsHtml}</ol>
  </div>

  ${unansweredQuestions.length > 0 ? `
  <div class="warning-section">
    <h3>⚠️ Needs Improvement</h3>
    <p style="font-size: 14px; color: #666; margin-bottom: 12px;">Questions where the chatbot struggled:</p>
    <ul style="margin: 0;">${unansweredHtml}</ul>
  </div>
  ` : ''}

  <div class="section">
    <h2>📋 Leads Captured</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Channel</th>
        </tr>
      </thead>
      <tbody>
        ${leadsHtml}
      </tbody>
    </table>
  </div>

  <div class="footer">
    <p>Automated report from onmore chatbot</p>
    <p>onmore.au</p>
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
    
    if (req.query.start && req.query.end) {
      startStr = req.query.start;
      endStr = req.query.end;
    } else {
      const endDate = new Date(now);
      endDate.setDate(endDate.getDate() - 1);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - 6);
      startStr = startDate.toISOString().split('T')[0];
      endStr = endDate.toISOString().split('T')[0];
    }

    const stats = await getWeeklyStats('onmore', startStr, endStr);

    if (!stats) {
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }

    const emailHtml = await buildEmailHtml(stats, startStr, endStr);

    const { data, error } = await resend.emails.send({
      from: 'onmore Chatbot <onboarding@resend.dev>',
      to: [REPORT_EMAIL],
      subject: `Weekly Chatbot Report: ${startStr} - ${endStr}`,
      html: emailHtml
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Failed to send email', details: error });
    }

    console.log('Weekly report sent:', data);
    return res.status(200).json({
      success: true,
      emailId: data?.id,
      period: { start: startStr, end: endStr },
      stats: {
        totalChats: stats.totalChats,
        totalLeads: stats.totalLeads
      }
    });
  } catch (error) {
    console.error('Weekly report error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
