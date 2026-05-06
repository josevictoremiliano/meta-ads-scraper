const { chromium } = require('playwright');
const crypto = require('crypto');

/**
 * Scraper v8 - Fixed block detection, better ad extraction
 * - Removed overly aggressive block detection (false positives)
 * - Uses URL-based block detection instead of content-based
 * - Improved CSS selectors for ad cards
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

const CTA_PATTERNS = [
  'Comprar agora', 'Saiba mais', 'Inscreva-se', 'Assinar', 'Cadastre-se',
  'Ver mais', 'Acessar', 'Baixar', 'Entrar em contato', 'Enviar mensagem',
  'Pedir agora', 'Solicitar', 'Obter oferta', 'Ver oferta', 'Aproveitar',
  'Comprar', 'Adquirir', 'Experimentar', 'Testar gratis', 'Comecar agora',
  'Quero agora', 'Garantir minha vaga', 'Quero desconto', 'Resgatar oferta',
  'Agendar', 'Falar com especialista', 'Ver preco', 'Ver planos',
  'Aplicar agora', 'Matricular', 'Participar', 'Entrar no grupo',
  'Baixar gratis', 'Download gratis', 'Instalar', 'Jogar agora',
];

function randomDelay(min = 500, max = 1500) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min) + min)));
}

function buildUrl(keyword, country = 'BR') {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: country,
    is_targeted_country: 'false',
    media_type: 'all',
    q: keyword,
    search_type: 'keyword_unordered',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

async function scrapeMetaAds({ keyword, country = 'BR', adCategory = 'ALL', maxResults = 30 }) {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  console.log(`Scraping keyword: "${keyword}" | country: ${country} | max: ${maxResults}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1280,800',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // Only block heavy media to speed up loading
  await page.route('**/*.{woff,woff2,ttf,eot}', route => route.abort());

  const ads = [];
  const seenHashes = new Set();

  try {
    const url = buildUrl(keyword, country);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await randomDelay(3000, 5000);

    // Check if redirected to login/blocked page (URL-based detection only)
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('checkpoint') || currentUrl.includes('recover')) {
      console.log(`Blocked/redirected for keyword: "${keyword}" -> ${currentUrl}`);
      await browser.close();
      return [];
    }

    // Scroll and extract ads
    let prevAdCount = 0;
    let noChangeCount = 0;
    const maxNoChange = 4;

    for (let scrollAttempt = 0; scrollAttempt < 15 && ads.length < maxResults; scrollAttempt++) {
      // Try multiple selectors to find ad cards
      const rawAds = await page.evaluate(() => {
        const results = [];
        const seen = new Set();

        // Try various selectors that Facebook uses for ad cards
        const selectors = [
          '[data-testid="ad-library-ad-card"]',
          'div._7jyr',
          'div[class*="_7jyr"]',
          'div[class*="x8t9es0"][class*="x1fvot60"]',
        ];

        let cards = [];
        for (const sel of selectors) {
          const found = document.querySelectorAll(sel);
          if (found.length > 0) {
            cards = Array.from(found);
            break;
          }
        }

        // Fallback: find divs with substantial text that look like ads
        if (cards.length === 0) {
          const allDivs = document.querySelectorAll('div[role="article"]');
          cards = Array.from(allDivs);
        }

        cards.forEach(card => {
          const text = (card.innerText || '').trim();
          if (text.length > 100) {
            const key = text.substring(0, 100);
            if (!seen.has(key)) {
              seen.add(key);
              results.push({
                html: card.innerHTML.substring(0, 5000),
                text: text.substring(0, 2000),
              });
            }
          }
        });

        return results;
      });

      // Parse each raw ad
      for (const raw of rawAds) {
        const adText = raw.text;
        const creative_hash = crypto.createHash('md5').update(adText.substring(0, 500)).digest('hex');

        if (seenHashes.has(creative_hash)) continue;
        seenHashes.add(creative_hash);

        const advertiserMatch = adText.match(/([A-Z][^\n]{2,50})\n/);
        const advertiserName = advertiserMatch ? advertiserMatch[1].trim() : 'Desconhecido';
        const status = /Ativo/i.test(adText) ? 'Ativo' : (/Inativo/i.test(adText) ? 'Inativo' : 'Desconhecido');
        const dateMatch = adText.match(/Iniciado em ([\d]+ de \w+ de \d{4})/);
        const ctaType = CTA_PATTERNS.find(cta => adText.toLowerCase().includes(cta.toLowerCase())) || null;
        const mediaType = raw.html.includes('<video') ? 'video' : (raw.html.includes('<img') ? 'image' : 'text');
        const snapshotMatch = raw.html.match(/href="(https:\/\/www\.facebook\.com\/ads\/library\/\?id=[^"]+)"/);
        const imageMatch = raw.html.match(/src="(https:\/\/[^"]*scontent[^"]*)"/i);
        const landingMatch = raw.html.match(/href="(https?:\/\/(?!www\.facebook\.com)[^"]+)"/);
        const landingDomain = landingMatch ? (() => { try { return new URL(landingMatch[1].replace(/&amp;/g, '&')).hostname; } catch(e) { return null; } })() : null;

        ads.push({
          keyword,
          advertiser_name: advertiserName,
          ad_text: adText.substring(0, 1000),
          status,
          start_date: dateMatch ? dateMatch[1] : null,
          platforms: [],
          cta_type: ctaType,
          media_type: mediaType,
          ad_snapshot_url: snapshotMatch ? snapshotMatch[1].replace(/&amp;/g, '&') : null,
          creative_hash,
          landing_domain: landingDomain,
          image_url: imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : null,
          video_url: null,
        });
      }

      console.log(`[${scrollAttempt+1}] Found ${ads.length} ads for "${keyword}"`);

      if (ads.length >= maxResults) break;

      if (ads.length === prevAdCount) {
        noChangeCount++;
        if (noChangeCount >= maxNoChange) {
          console.log(`No new ads after ${maxNoChange} scrolls for "${keyword}", stopping`);
          break;
        }
      } else {
        noChangeCount = 0;
      }
      prevAdCount = ads.length;

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await randomDelay(2000, 3500);
    }

  } catch (err) {
    console.error(`Error scraping "${keyword}": ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log(`Found ${ads.length} ads for "${keyword}"`);
  return ads;
}

module.exports = { scrapeMetaAds };
