const { kv } = require('@vercel/kv');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const REPORT_EMAIL = process.env.REPORT_EMAIL || 'hello@onmore.au';

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
    const chatIds = await kv.lrange(chatIndexKey, 0, 49);
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

function getTopQuestions(conversations, limit = 5) {
  const questions = {};
  for (const conv of conversations) {
    const msg = conv.userMessage?.toLowerCase().trim();
    if (!msg) continue;
    questions[msg] = (questions[msg] || 0) + 1;
  }
  return Object.entries(questions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([q, count]) => ({ question: q, count }));
}

function formatAEST(utcHour) {
  const aestHour = (utcHour + 11) % 24;
  const period = aestHour >= 12 ? 'PM' : 'AM';
  const hour12 = aestHour % 12 || 12;
  return `${hour12}${period} AEST`;
}

function buildEmailHtml(stats, startDate, endDate) {
  const peak = getPeakHour(stats.hourlyBreakdown);
  const topQuestions = getTopQuestions(stats.conversations);

  const topQuestionsHtml = topQuestions.length > 0
    ? topQuestions.map(q => `<li>"${q.question}" (${q.count}x)</li>`).join('')
    : '<li>No conversations this week</li>';

  const leadsHtml = stats.leads.length > 0
    ? stats.leads.map(l => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${l.name || '-'}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${l.email || '-'}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${l.channel}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${new Date(l.timestamp).toLocaleDateString()}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" style="padding: 16px; text-align: center; color: #666;">No leads this week</td></tr>';

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
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 18px; border-bottom: 2px solid #667eea; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f8f9fa; padding: 12px 8px; text-align: left; font-size: 14px; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; }
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

  <div class="section">
    <h2>Peak Activity</h2>
    <p>Busiest time: <strong>${formatAEST(peak.hour)}</strong> (${peak.count} messages)</p>
  </div>

  <div class="section">
    <h2>Top Questions</h2>
    <ol>${topQuestionsHtml}</ol>
  </div>

  <div class="section">
    <h2>Leads This Week</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Channel</th>
          <th>Date</th>
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

    const emailHtml = buildEmailHtml(stats, startStr, endStr);

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
