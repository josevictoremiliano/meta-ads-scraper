const { chromium } = require('playwright');

async function scrapeMetaAds({ keyword, country = 'BR', adCategory = 'ALL', maxResults = 30 }) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Bloquear recursos desnecessarios para ser mais rapido
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,mp4,webm}', r => r.abort());
  await page.route('**/video/**', r => r.abort());

  const url = buildUrl({ keyword, country, adCategory });
  console.log(`  Navegando: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    // timeout parcial ainda pode ter conteudo util
    console.warn('  Aviso de timeout no goto, tentando extrair mesmo assim...');
  }

  // Aguarda cards aparecerem
  await page.waitForSelector('[data-testid="ad-card"], [class*="xh8yej3"], ._7jvw', {
    timeout: 20000,
  }).catch(() => console.warn('  Nenhum seletor de card encontrado dentro do timeout'));

  // Scroll para carregar mais resultados
  const targetCount = Math.min(maxResults, 50);
  let lastCount = 0;
  for (let i = 0; i < 8; i++) {
    const currentCount = await page.locator('[class*="x1dr75xp"][class*="x1lcm9me"], [data-testid="ad-card"]').count();
    if (currentCount >= targetCount) break;
    if (currentCount === lastCount && i > 2) break;
    lastCount = currentCount;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(1500);
  }

  // Extrai dados dos cards
  const ads = await page.evaluate((maxRes) => {
    const results = [];

    // Tenta varios seletores de card possiveis
    const cardSelectors = [
      '[data-testid="ad-card"]',
      '._7jvw',
      '[class*="x193iq5w"][class*="x1lkfr7t"]',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }

    // Fallback: pega todos os divs que parecem cards de anuncio
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll('div[role="article"], div[class*="ad_archive"]'));
    }

    for (const card of cards.slice(0, maxRes)) {
      try {
        // Nome do anunciante
        const advertiserEl = card.querySelector('a[href*="facebook.com/"], strong, h4');
        const advertiser_name = advertiserEl?.innerText?.trim() || null;

        // URL do anunciante
        const advertiserLink = card.querySelector('a[href*="facebook.com/"]');
        const advertiser_profile_url = advertiserLink?.href || null;

        // Texto do anuncio
        const textSelectors = ['[data-testid="ad-text"]', 'div[dir="auto"]', '[class*="x1lliihq"]'];
        let ad_text = null;
        for (const ts of textSelectors) {
          const el = card.querySelector(ts);
          if (el?.innerText?.trim()) { ad_text = el.innerText.trim(); break; }
        }

        // Status e data
        const statusEl = card.querySelector('[class*="status"], [data-testid="status"]');
        const status = statusEl?.innerText?.includes('Ativo') ? 'ACTIVE' : 'INACTIVE';

        // Data de inicio
        const dateEls = card.querySelectorAll('span, p');
        let start_date = null;
        for (const el of dateEls) {
          const t = el.innerText || '';
          const m = t.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ de \d{4}|\d{4}-\d{2}-\d{2})/);
          if (m) { start_date = m[1]; break; }
        }

        // Plataformas
        const platformText = card.innerText.toLowerCase();
        const platforms = [];
        if (platformText.includes('facebook')) platforms.push('facebook');
        if (platformText.includes('instagram')) platforms.push('instagram');
        if (platformText.includes('audience network')) platforms.push('audience_network');
        if (platformText.includes('messenger')) platforms.push('messenger');

        // Tipo de midia
        const hasVideo = !!card.querySelector('video, [data-testid="video"]');
        const hasImage = !!card.querySelector('img[src*="fbcdn"], img[src*="scontent"]');
        const media_type = hasVideo ? 'video' : hasImage ? 'image' : 'text';

        // Imagem
        const imgEl = card.querySelector('img[src*="fbcdn"], img[src*="scontent"]');
        const image_url = imgEl?.src || null;

        // Link do anuncio
        const adLink = card.querySelector('a[href*="ads/library"]');
        const ad_snapshot_url = adLink?.href || null;

        // Landing domain
        const externalLinks = Array.from(card.querySelectorAll('a[href]'))
          .filter(a => !a.href.includes('facebook.com') && !a.href.includes('instagram.com'))
          .map(a => { try { return new URL(a.href).hostname; } catch { return null; } })
          .filter(Boolean);
        const landing_domain = externalLinks[0] || null;

        // CTA hint
        const ctaEl = card.querySelector('[data-testid="cta-button"], button, [class*="cta"]');
        const raw_offer_hint = ctaEl?.innerText?.trim() || null;

        if (advertiser_name || ad_text) {
          results.push({
            advertiser_name,
            advertiser_profile_url,
            ad_text,
            status,
            start_date,
            platforms: platforms.length ? platforms : ['facebook'],
            media_type,
            image_url,
            ad_snapshot_url,
            landing_domain,
            raw_offer_hint,
          });
        }
      } catch (e) {
        // ignora card com erro
      }
    }
    return results;
  }, maxResults);

  await browser.close();

  // Deduplica por ad_text + advertiser_name
  const seen = new Set();
  return ads.filter(ad => {
    const key = `${ad.advertiser_name}|${ad.ad_text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildUrl({ keyword, country, adCategory }) {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country,
    media_type: 'all',
    q: keyword,
    search_type: 'keyword_unordered',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

module.exports = { scrapeMetaAds };
