const { kv } = require('@vercel/kv');

async function backupAllData() {
  const backup = {
    timestamp: new Date().toISOString(),
    data: {
      stats: {},
      conversations: [],
      leads: []
    }
  };

  const now = new Date();
  const dates = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().split('T')[0]);
  }

  for (const date of dates) {
    const statsKey = `stats:onmore:${date}`;
    const dayStats = await kv.hgetall(statsKey);
    if (dayStats) {
      backup.data.stats[date] = dayStats;
    }

    const chatIndexKey = `chatindex:onmore:${date}`;
    const chatIds = await kv.lrange(chatIndexKey, 0, -1);
    for (const chatId of chatIds || []) {
      const chatKey = `chat:onmore:${date}:${chatId}`;
      const chat = await kv.get(chatKey);
      if (chat) {
        backup.data.conversations.push({ date, chatId, ...chat });
      }
    }

    const leadIndexKey = `leadindex:onmore:${date}`;
    const leadIds = await kv.lrange(leadIndexKey, 0, -1);
    for (const leadId of leadIds || []) {
      const leadKey = `lead:onmore:${date}:${leadId}`;
      const lead = await kv.get(leadKey);
      if (lead) {
        backup.data.leads.push({ date, leadId, ...lead });
      }
    }
  }

  return backup;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const backup = await backupAllData();
    
    const summary = {
      timestamp: backup.timestamp,
      totalConversations: backup.data.conversations.length,
      totalLeads: backup.data.leads.length,
      daysIncluded: Object.keys(backup.data.stats).length
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="onmore-backup-${backup.timestamp.split('T')[0]}.json"`);
    
    return res.status(200).json({
      success: true,
      summary,
      backup
    });
  } catch (error) {
    console.error('Backup error:', error);
    return res.status(500).json({ error: 'Backup failed', details: error.message });
  }
};
