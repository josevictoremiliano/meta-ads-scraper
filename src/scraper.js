const { chromium } = require('playwright');
const crypto = require('crypto');

/**
 * Scraper v9 - Definitivo
 * - Keyword sempre vem do parametro, nunca do DOM
 * - Selectors multiplos com fallback robusto
 * - Extrai ad_text rico para alimentar o classificador de nichos
 * - Detecta advertiser_name, status, datas, CTA, media
 * - Timeout por keyword para nao travar o loop
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const CTA_PATTERNS = [
  'comprar agora', 'saiba mais', 'inscreva-se', 'assinar', 'cadastre-se',
  'ver mais', 'acessar', 'baixar', 'entrar em contato', 'enviar mensagem',
  'pedir agora', 'solicitar', 'obter oferta', 'ver oferta', 'aproveitar',
  'comprar', 'adquirir', 'experimentar', 'testar gratis', 'comecar agora',
  'quero agora', 'garantir minha vaga', 'quero desconto', 'resgatar oferta',
  'agendar', 'falar com especialista', 'ver preco', 'ver planos',
  'aplicar agora', 'matricular', 'participar', 'entrar no grupo',
  'baixar gratis', 'download gratis', 'instalar', 'jogar agora',
  'garanta ja', 'clique aqui', 'acesse agora', 'quero o desconto',
];

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randDelay(min = 1500, max = 3000) {
  return delay(Math.floor(Math.random() * (max - min) + min));
}

function buildUrl(keyword, country = 'BR') {
  const p = new URLSearchParams({
    active_status: 'all',
    ad_type: 'all',
    country,
    is_targeted_country: 'false',
    media_type: 'all',
    q: keyword,
    search_type: 'keyword_unordered',
  });
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

async function scrapeMetaAds({ keyword, country = 'BR', adCategory = 'ALL', maxResults = 30 }) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  console.log(`[v9] Scraping "${keyword}" | max: ${maxResults}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--disable-gpu',
      '--window-size=1280,900', '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: ua,
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  await page.route('**/*.{woff,woff2,ttf,eot}', r => r.abort());

  const ads = [];
  const seenHashes = new Set();

  try {
    await page.goto(buildUrl(keyword, country), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randDelay(3000, 5000);

    // Deteccao de bloqueio via URL
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('checkpoint')) {
      console.log(`[v9] Bloqueado para "${keyword}"`);
      await browser.close();
      return [];
    }

    let prevCount = 0;
    let stuckCount = 0;

    for (let scroll = 0; scroll < 12 && ads.length < maxResults; scroll++) {

      const rawAds = await page.evaluate(() => {
        const results = [];
        const seen = new Set();

        // Tenta selectors do mais especifico ao mais generico
        let cards = [];
        const selectors = [
          '[data-testid="ad-library-ad-card"]',
          'div._7jyr',
          'div[class*="_7jyr"]',
          'div[role="article"]',
        ];

        for (const sel of selectors) {
          const found = [...document.querySelectorAll(sel)];
          if (found.length >= 2) { cards = found; break; }
        }

        // Fallback: blocos de texto grandes que parecem anuncios
        if (cards.length < 2) {
          cards = [...document.querySelectorAll('div')].filter(d => {
            const t = (d.innerText || '').trim();
            return t.length > 200 && t.length < 5000 &&
              (t.includes('Patrocinado') || t.includes('Saiba mais') ||
               t.includes('Comprar') || t.includes('Iniciado em') ||
               t.includes('Ativo') || t.includes('oferta'));
          });
        }

        cards.forEach(card => {
          const text = (card.innerText || '').trim();
          const key = text.substring(0, 80);
          if (text.length > 80 && !seen.has(key)) {
            seen.add(key);
            results.push({
              text: text.substring(0, 1500),
              html: card.innerHTML.substring(0, 4000),
            });
          }
        });

        return results;
      });

      for (const raw of rawAds) {
        const text = raw.text;
        // keyword SEMPRE vem do parametro da funcao, nunca do DOM
        const creative_hash = crypto.createHash('md5').update((keyword + text).substring(0, 600)).digest('hex');
        if (seenHashes.has(creative_hash)) continue;
        seenHashes.add(creative_hash);

        // Extrai advertiser_name: primeira linha nao vazia com mais de 2 chars
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
        const advertiserName = lines[0] || 'Desconhecido';

        // Status
        const statusRaw = raw.html || ''; const status = (/inativo|inactive/i.test(statusRaw) || /inativo|inactive/i.test(text)) ? 'Inativo' : 'Ativo';

        // Data de inicio
        const dateMatch = text.match(/Iniciado em ([\d]+ de [\w]+ de \d{4}|[\d]{1,2}\/[\d]{1,2}\/\d{4})/);

        // CTA
        const textLower = text.toLowerCase();
        const ctaType = CTA_PATTERNS.find(c => textLower.includes(c)) || null;

        // Media type
        const mediaType = raw.html.includes('<video') ? 'video' : (raw.html.includes('<img') ? 'image' : 'text');

        // URLs
        const snapshotMatch = raw.html.match(/href="(https:\/\/www\.facebook\.com\/ads\/library\/\?id=[^"]+)"/);
        const imageMatch = raw.html.match(/src="(https:\/\/[^"]*scontent[^"]*)"/i);
        const landingMatch = raw.html.match(/href="(https?:\/\/(?!www\.facebook\.com)[^"\s]{10,100})"/);
        const landingDomain = landingMatch
          ? (() => { try { return new URL(landingMatch[1].replace(/&amp;/g, '&')).hostname; } catch(e) { return null; } })()
          : null;

        // Plataformas mencionadas no texto
        const platforms = [];
        if (/facebook/i.test(text)) platforms.push('facebook');
        if (/instagram/i.test(text)) platforms.push('instagram');
        if (/messenger/i.test(text)) platforms.push('messenger');

        // raw_offer_hint: trecho mais relevante para classificacao
        const offerLines = lines.filter(l =>
          l.length > 10 && l.length < 200 &&
          !l.match(/^(Ativo|Inativo|Iniciado|Patrocinado|Seguir|Curtir)$/i)
        ).slice(0, 5).join(' | ');

        ads.push({
          keyword,           // SEMPRE o keyword do parametro
          advertiser_name: advertiserName,
          ad_text: text.substring(0, 1000),
          raw_offer_hint: offerLines.substring(0, 500),
          status,
          start_date: dateMatch ? dateMatch[1] : null,
          platforms,
          cta_type: ctaType,
          media_type: mediaType,
          ad_snapshot_url: snapshotMatch ? snapshotMatch[1].replace(/&amp;/g, '&') : null,
          creative_hash,
          landing_domain: landingDomain,
          image_url: imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : null,
          video_url: null,
          query_country: country,
          query_category: adCategory,
          rank_in_keyword: ads.length + 1,
        });
      }

      console.log(`[v9][scroll ${scroll + 1}] ${ads.length} ads para "${keyword}"`);
      if (ads.length >= maxResults) break;

      if (ads.length === prevCount) {
        stuckCount++;
        if (stuckCount >= 4) { console.log(`[v9] Sem novos ads apos 4 scrolls para "${keyword}", parando`); break; }
      } else {
        stuckCount = 0;
      }
      prevCount = ads.length;

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2.5));
      await randDelay(2000, 3500);
    }

  } catch (err) {
    console.error(`[v9] Erro em "${keyword}": ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log(`[v9] Total: ${ads.length} ads para "${keyword}"`);
  return ads;
}

module.exports = { scrapeMetaAds };
