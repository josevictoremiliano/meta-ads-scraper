const express = require('express');
const { scrapeMetaAds } = require('./scraper');

const app = express();
app.use(express.json());

const API_KEY = process.env.SCRAPER_API_KEY || 'trocar-aqui';
const PORT    = process.env.PORT || 3000;

// Auth middleware
app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Health check (sem auth)
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Endpoint principal chamado pelo n8n
app.post('/webhook/meta-ads', async (req, res) => {
  const { keyword, country = 'BR', adCategory = 'ALL', maxResults = 30, runId } = req.body;

  if (!keyword) return res.status(400).json({ error: 'keyword is required' });

  console.log(`[${runId || 'manual'}] Scraping keyword: "${keyword}" | country: ${country} | max: ${maxResults}`);

  try {
    const ads = await scrapeMetaAds({ keyword, country, adCategory, maxResults });
    console.log(`[${runId || 'manual'}] Found ${ads.length} ads for "${keyword}"`);
    res.json({ runId, keyword, country, adCategory, ads });
  } catch (err) {
    console.error(`[${runId || 'manual'}] Error:`, err.message);
    res.status(500).json({ error: err.message, keyword, runId });
  }
});

app.listen(PORT, () => console.log(`Meta Ads Scraper listening on port ${PORT}`));
