const { chromium } = require('playwright');

/**
 * Scraper v6 - Playwright nativo com stealth manual:
 * - Sem playwright-extra (incompativel com imagem Docker Playwright)
 * - addInitScript para spoofa webdriver, plugins, languages
 * - User-agent rotation via context.newContext()
 * - Delays aleatorios entre acoes
 * - Deteccao de bloqueio rapida
 * - URL com active_status=active para resultados atuais
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
  /Identifica[cç][aã]o da biblioteca/,
  /Veicul[aã]o iniciada em/,
  /^Ativo$/i,
  /^Inativo$/i,
  /^Facebook$/i,
  /^Instagram$/i,
  /^Messenger$/i,
  /^Audience Network$/i,
  /^Ver detalhes$/i,
  /^Patrocinado$/i,
  /^Comprar agora$/i,
  /^Comprar$/i,
  /^Saiba mais$/i,
  /^\d+$/,
  /^[A-Z0-9]{10,}$/,
  /^Ver mais$/i,
  /^Conte[uú]do indispon[ií]vel/i,
  /^Biblioteca de An[uú]ncios/i,
  /^Meta/i,
  /^\s*$/,
];

function randomDelay(min = 1000, max = 3000) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min)) + min));
}

function buildUrl(keyword, country = 'BR') {
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

async function scrapeMetaAds({ keyword, country = 'BR', adCategory = 'ALL', maxResults = 30 }) {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
    ],
  });

  const context = await browser.newContext({
    userAgent,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });

  // Stealth manual via addInitScript
  await context.addInitScript(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }];
        arr.__proto__ = PluginArray.prototype;
        return arr;
      },
    });
    // Fake languages
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    // Fake chrome runtime
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    // Fake permissions
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });

  const page = await context.newPage();

  // Bloquear recursos pesados
  await page.route('**/*', (route) => {
    const url = route.request().url();
    const type = route.request().resourceType();
    if (type === 'font' || type === 'media') return route.abort();
    return route.continue();
  });

  const url = buildUrl(keyword, country);
  console.log(`[manual] Scraping keyword: "${keyword}" | country: ${country} | max: ${maxResults}`);
  console.log(`Navegando: ${url}`);

  // Navegacao com retry
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
      break;
    } catch (e) {
      console.warn(`Tentativa ${attempt + 1} falhou: ${e.message.substring(0, 80)}`);
      if (attempt === 1) console.log('Prosseguindo com o que carregou.');
    }
  }

  await randomDelay(2500, 5000);

  // Detectar bloqueio
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const isBlocked = bodyText.length < 300 ||
    bodyText.includes('Nao foi possivel') ||
    bodyText.includes('Something went wrong') ||
    bodyText.includes('Access Denied') ||
    bodyText.includes('confirme que');

  if (isBlocked) {
    console.warn(`[blocked] "${keyword}" - pagina bloqueada/vazia (${bodyText.length} chars). Pulando.`);
    await browser.close();
    return [];
  }

  // Scroll progressivo
  let prevCount = 0;
  let stableRounds = 0;
  const MAX_SCROLLS = 12;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const adCount = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return (text.match(/Identifica[cç][aã]o da biblioteca/g) || []).length;
    }).catch(() => 0);

    console.log(`Scroll ${i + 1}: ${adCount} anuncios encontrados`);

    if (adCount >= maxResults) break;

    if (adCount === prevCount) {
      stableRounds++;
      if (stableRounds >= 3) break;
    } else {
      stableRounds = 0;
    }
    prevCount = adCount;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(2000, 4000);
  }

  // Extrair anuncios
  const fullText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const blocks = fullText.split(/(?=Identifica[cç][aã]o da biblioteca\s*:\s*\d)/);

  const results = [];

  for (const block of blocks) {
    try {
      const idMatch = block.match(/Identifica[cç][aã]o da biblioteca\s*:\s*(\d+)/);
      if (!idMatch) continue;
      const adNumericId = idMatch[1];

      const statusMatch = block.match(/\b(Ativo|Inativo)\b/i);
      const status = statusMatch ? statusMatch[1] : null;

      const dateMatch =
        block.match(/(\d{1,2})\s+de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})/i) ||
        block.match(/(\d{4})-(\d{2})-(\d{2})/) ||
        block.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);

      let start_date = null;
      if (dateMatch) {
        try { start_date = new Date(dateMatch[0]).toISOString().split('T')[0]; } catch {}
      }

      const platformMatches = block.match(/\b(Facebook|Instagram|Messenger|Audience Network)\b/gi) || [];
      const platforms = [...new Set(platformMatches.map(p => p.trim()))];

      const lines = block.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !META_PATTERNS.some(p => p.test(l)));

      const advertiser_name = lines.find(l => l.length > 2 && l.length < 80) || '';

      const ad_text = lines
        .filter(l => l !== advertiser_name && l.length > 10)
        .slice(0, 5)
        .join(' ');

      const cta_type = CTA_PATTERNS.find(c =>
        block.toLowerCase().includes(c.toLowerCase()
        )) || null;

      const media_type = /v[ií]deo/i.test(block) ? 'video' : 'image';
      const ad_snapshot_url = `https://www.facebook.com/ads/library/?id=${adNumericId}`;

      const hashStr = `${advertiser_name}|${ad_text}`;
      let h = 0;
      for (let i = 0; i < hashStr.length; i++) {
        h = ((h << 5) - h) + hashStr.charCodeAt(i);
        h |= 0;
      }
      const creative_hash = Math.abs(h).toString(16) + '_' + adNumericId;

      results.push({
        keyword,
        advertiser_name,
        ad_text,
        status,
        start_date,
        platforms,
        cta_type,
        media_type,
        ad_snapshot_url,
        creative_hash,
        landing_domain: null,
        image_url: null,
        video_url: null,
      });
    } catch (e) {
      // ignora bloco com erro
    }
  }

  // Enriquecer com dados DOM
  try {
    const domData = await page.evaluate(() => {
      const externalDomains = Array.from(document.querySelectorAll('a[href]'))
        .map(a => { try { return new URL(a.href).hostname; } catch { return null; } })
        .filter(h => h && !h.includes('facebook') && !h.includes('fbcdn') && !h.includes('meta'));

      const imgs = Array.from(document.querySelectorAll('img[src]'))
        .map(img => img.src)
        .filter(s => s.includes('fbcdn') || s.includes('scontent'));

      const vids = Array.from(document.querySelectorAll('video source, video[src]'))
        .map(v => v.src || v.getAttribute('src'))
        .filter(Boolean);

      return { externalDomains, imgs, vids };
    });

    results.forEach((ad, i) => {
      if (domData.externalDomains[i]) ad.landing_domain = domData.externalDomains[i];
      if (domData.imgs[i]) ad.image_url = domData.imgs[i];
      if (domData.vids[i]) ad.video_url = domData.vids[i];
    });
  } catch (e) {
    console.warn('Enriquecimento DOM falhou:', e.message);
  }

  await browser.close();

  const seen = new Set();
  const deduped = results.filter(ad => {
    if (seen.has(ad.creative_hash)) return false;
    seen.add(ad.creative_hash);
    return true;
  });

  console.log(`[manual] Found ${deduped.length} ads for "${keyword}"`);
  return deduped;
}

module.exports = { scrapeMetaAds };
