const { chromium } = require('playwright');

/**
 * Scraper v7 - Otimizado para velocidade e cobertura maxima de keywords:
 * - Timeout reduzido para deteccao rapida de keywords sem resultados
 * - Scroll mais agressivo para carregar mais anuncios
 * - Deteccao rapida de bloqueio/sem resultados
 * - addInitScript para stealth manual
 * - User-agent rotation via context.newContext()
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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

const META_PATTERNS = [
  /Identifica[cc][ao]o da biblioteca/,
  /Ativo/i,
  /^Inativo$/i,
  /Iniciado em/i,
  /Anunciante/i,
];

function randomDelay(min = 500, max = 1500) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min) + min)));
}

function buildUrl(keyword, country = 'BR', adCategory = 'ALL') {
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
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  });

  // Stealth: remove webdriver traces
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  const page = await context.newPage();

  // Block unnecessary resources for speed
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot}', route => route.abort());
  await page.route('**/video/**', route => route.abort());
  await page.route('**/{analytics,tracking,beacon}**', route => route.abort());

  const ads = [];
  const seenHashes = new Set();

  try {
    const url = buildUrl(keyword, country);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Quick check for block or no results
    await randomDelay(2000, 3500);

    // Check if blocked
    const pageContent = await page.content();
    if (
      pageContent.includes('checkpoint') ||
      pageContent.includes('login_form') ||
      pageContent.includes('Please log in')
    ) {
      console.log(`Blocked for keyword: "${keyword}"`);
      await browser.close();
      return [];
    }

    // Check for no results quickly
    const noResults = await page.$('[data-testid="no_results"]') ||
      await page.$('div[role="main"] :text("Nenhum resultado encontrado")').catch(() => null);
    if (noResults) {
      console.log(`No results for keyword: "${keyword}"`);
      await browser.close();
      return [];
    }

    // Scroll to load more ads
    let prevAdCount = 0;
    let noChangeCount = 0;
    const maxNoChange = 3;

    while (ads.length < maxResults) {
      // Extract currently visible ads
      const rawAds = await page.evaluate(() => {
        const cards = document.querySelectorAll('div[class*="x8t9es0"]');
        const results = [];
        cards.forEach(card => {
          const text = card.innerText || '';
          if (text.length > 50) {
            results.push({
              html: card.innerHTML.substring(0, 5000),
              text: text.substring(0, 2000),
            });
          }
        });
        return results;
      });

      // Parse ad data
      for (const raw of rawAds) {
        const adText = raw.text;

        // Try to extract advertiser name
        const advertiserMatch = adText.match(/([A-Z][^\n]{2,50})(?=\nAnunciante|\nPatrocinado|\nSeguir)/);
        const advertiserName = advertiserMatch ? advertiserMatch[1].trim() : 'Desconhecido';

        // Status detection
        const status = /Ativo/i.test(adText) ? 'Ativo' : (/Inativo/i.test(adText) ? 'Inativo' : 'Desconhecido');

        // Start date
        const dateMatch = adText.match(/Iniciado em (\d{1,2} de \w+ de \d{4}|\d{1,2}\/\d{1,2}\/\d{4})/);
        const startDate = dateMatch ? dateMatch[1] : null;

        // CTA detection
        const ctaType = CTA_PATTERNS.find(cta => adText.toLowerCase().includes(cta.toLowerCase())) || null;

        // Media type
        const mediaType = raw.html.includes('<video') ? 'video' : (raw.html.includes('<img') ? 'image' : 'text');

        // Extract URLs from html
        const snapshotMatch = raw.html.match(/href="(https:\/\/www\.facebook\.com\/ads\/library\/\?id=[^"]+)"/);
        const adSnapshotUrl = snapshotMatch ? snapshotMatch[1].replace(/&amp;/g, '&') : null;

        const imageMatch = raw.html.match(/src="(https:\/\/[^"]*scontent[^"]*)"/); 
        const imageUrl = imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : null;

        // Landing domain
        const landingMatch = raw.html.match(/href="(https?:\/\/(?!www\.facebook\.com)[^"]+)"/);
        const landingDomain = landingMatch ? (() => { try { return new URL(landingMatch[1].replace(/&amp;/g, '&')).hostname; } catch(e) { return null; } })() : null;

        // Creative hash
        const crypto = require('crypto');
        const creative_hash = crypto.createHash('md5').update(adText.substring(0, 500)).digest('hex');

        if (!seenHashes.has(creative_hash) && adText.length > 100) {
          seenHashes.add(creative_hash);
          ads.push({
            keyword,
            advertiser_name: advertiserName,
            ad_text: adText.substring(0, 1000),
            status,
            start_date: startDate,
            platforms: [],
            cta_type: ctaType,
            media_type: mediaType,
            ad_snapshot_url: adSnapshotUrl,
            creative_hash,
            landing_domain: landingDomain,
            image_url: imageUrl,
            video_url: null,
          });
        }
      }

      console.log(`Found ${ads.length} ads so far for "${keyword}"`);

      if (ads.length >= maxResults) break;

      // Check if we're making progress
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

      // Scroll down
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await randomDelay(1500, 2500);
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
