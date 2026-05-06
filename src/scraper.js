const { chromium } = require('playwright');

/**
 * Scraper v4 - Melhorias:
 * - CTA expandido (mais patterns)
 * - Data de inicio parseada corretamente (varios formatos PT-BR)
 * - video_url extraido do DOM
 * - landing_domain e image_url com matching por posicao melhorado
 * - Retry automatico em caso de timeout
 * - Scroll mais inteligente com deteccao de novos items
 * - Meta patterns mais completos para parser limpo
 */

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
  /Identificação da biblioteca/,
  /Veiculação iniciada em/,
  /^Ativo$/i,
  /^Inativo$/i,
  /^Facebook$/i,
  /^Instagram$/i,
  /^Messenger$/i,
  /^Audience Network$/i,
  /^Ver detalhes/i,
  /^Patrocinado$/i,
  /^Saiba mais$/i,
  /^Comprar agora$/i,
  /^Comprar$/i,
  /^Inscreva-se$/i,
  /^Assinar$/i,
  /^Cadastre-se$/i,
  /^Plataformas$/i,
  /^Abrir menu/i,
  /versões/i,
  /^Anunciar no Facebook/i,
  /^Política de privacidade/i,
  /^Termos e condições/i,
  /^Sobre este anúncio/i,
  /^Denunciar/i,
  /^\d+ versão/i,
  /^versão \d+/i,
  /^Rótulo de isenção/i,
];

async function scrapeMetaAds({ keyword, country = 'BR', adCategory = 'ALL', maxResults = 30 }) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });

  const page = await context.newPage();
  // Bloquear apenas recursos pesados, mas manter imagens para capturar image_url
  await page.route('**/*.{woff,woff2,ttf,mp4,webm}', r => r.abort());
  await page.route('**/video/**', r => r.abort());

  const url = buildUrl({ keyword, country, adCategory });
  console.log(` Navegando: ${url}`);

  // Retry: tenta navegar ate 2 vezes
  let navOk = false;
  for (let attempt = 1; attempt <= 2 && !navOk; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      navOk = true;
    } catch (e) {
      console.warn(` Timeout no goto (tentativa ${attempt}), continuando...`);
      if (attempt === 2) console.warn(' Prosseguindo com o que carregou.');
    }
  }

  await page.waitForTimeout(4000);

  // Scroll progressivo mais inteligente
  const targetCount = Math.min(maxResults, 50);
  let lastCount = 0;
  let stableRounds = 0;
  for (let i = 0; i < 12; i++) {
    const bodyText = await page.evaluate(() => document.body.innerText);
    const adCount = (bodyText.match(/Identificação da biblioteca/g) || []).length;
    console.log(` Scroll ${i + 1}: ${adCount} anúncios encontrados`);
    if (adCount >= targetCount) break;
    // Para se nao tiver mais novos items em 2 rounds
    if (adCount === lastCount) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastCount = adCount;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(2000);
  }

  const ads = await page.evaluate((params) => {
    const { maxRes, ctaList, metaList } = params;
    const results = [];
    const bodyText = document.body.innerText;

    // Reconstroi metaPatterns como RegExp
    const metaPatterns = metaList.map(p => new RegExp(p.source || p, p.flags || 'i'));

    const blocks = bodyText.split(/(?=Identificação da biblioteca\s*:\s*\d+)/);
    for (const block of blocks.slice(0, maxRes + 1)) {
      if (!block.includes('Identificação da biblioteca')) continue;
      try {
        // ID numerico
        const idMatch = block.match(/Identificação da biblioteca\s*:\s*(\d+)/);
        const adNumericId = idMatch ? idMatch[1] : null;
        if (!adNumericId) continue;

        const blockSemId = block.replace(/Identificação da biblioteca\s*:\s*\d+/g, '').trim();

        // Status
        const status = blockSemId.match(/\bAtivo\b/i) ? 'ACTIVE' : 'INACTIVE';

        // Data de inicio - suporta multiplos formatos PT-BR
        const dateMatch = blockSemId.match(
          /Veiculação iniciada em\s+([^\n]+)/
        );
        let start_date = dateMatch ? dateMatch[1].trim() : null;
        // Normaliza data: "1 de janeiro de 2025" ou "01/01/2025" ou "jan. de 2025"
        if (start_date) {
          start_date = start_date
            .replace(/^(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})$/, '$1/$2/$3')
            .trim();
        }

        // Plataformas
        const platforms = [];
        const blockLower = blockSemId.toLowerCase();
        if (blockLower.includes('facebook')) platforms.push('facebook');
        if (blockLower.includes('instagram')) platforms.push('instagram');
        if (blockLower.includes('audience network')) platforms.push('audience_network');
        if (blockLower.includes('messenger')) platforms.push('messenger');
        if (platforms.length === 0) platforms.push('facebook');

        // Linhas limpas
        const lines = blockSemId
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        // Nome do anunciante: primeira linha nao-metadado, nao-numeros
        let advertiser_name = null;
        for (const line of lines) {
          let isMeta = metaPatterns.some(p => p.test(line));
          if (/^\d+$/.test(line)) isMeta = true;
          // Ignora linhas muito curtas (1-2 chars)
          if (!isMeta && line.length > 2) {
            advertiser_name = line;
            break;
          }
        }

        // Texto do anuncio
        const textLines = lines.filter(line => {
          if (line === advertiser_name) return false;
          if (metaPatterns.some(p => p.test(line))) return false;
          if (/^\d+$/.test(line)) return false;
          return line.length > 10;
        });
        const ad_text = textLines.slice(0, 5).join(' ') || null;

        // CTA
        let raw_offer_hint = null;
        for (const cta of ctaList) {
          if (blockSemId.toLowerCase().includes(cta.toLowerCase())) {
            raw_offer_hint = cta;
            break;
          }
        }

        // Tipo de midia
        const has_video = blockLower.includes('vídeo') || blockLower.includes('video');
        const media_type = has_video ? 'video' : 'image';

        // Snapshot URL
        const ad_snapshot_url = `https://www.facebook.com/ads/library/?id=${adNumericId}`;

        // creative_hash baseado em advertiser + texto + id
        const hashStr = `${advertiser_name}|${ad_text}`;
        let h = 0;
        for (let i = 0; i < hashStr.length; i++) {
          h = ((h << 5) - h) + hashStr.charCodeAt(i);
          h |= 0;
        }
        const creative_hash = Math.abs(h).toString(16) + '_' + adNumericId;

        if (advertiser_name && ad_text) {
          results.push({
            advertiser_name,
            ad_text,
            status,
            start_date,
            platforms,
            media_type,
            raw_offer_hint,
            ad_snapshot_url,
            advertiser_profile_url: null,
            image_url: null,
            video_url: null,
            landing_domain: null,
            creative_hash,
            ad_numeric_id: adNumericId,
          });
        }
      } catch (e) {
        // ignora bloco com erro
      }
    }
    return results;
  }, {
    maxRes: maxResults,
    ctaList: CTA_PATTERNS,
    metaList: META_PATTERNS.map(p => ({ source: p.source, flags: p.flags })),
  });

  // Enriquece com imagem, video e landing domain
  const enriched = await page.evaluate((adsData) => {
    // Extrai links externos (landing domains)
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    const externalDomains = allLinks
      .filter(a => a.href &&
        !a.href.includes('facebook.com') &&
        !a.href.includes('instagram.com') &&
        !a.href.includes('l.facebook.com') &&
        a.href.startsWith('http'))
      .map(a => {
        try { return new URL(a.href).hostname.replace('www.', ''); }
        catch { return null; }
      })
      .filter(Boolean);

    // Extrai imagens de anuncios
    const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"], img[src*="scontent"]'))
      .filter(img => img.width > 50);

    // Extrai videos
    const vids = Array.from(document.querySelectorAll('video[src], source[src*="fbcdn"]'))
      .map(v => v.src || v.getAttribute('src'))
      .filter(Boolean);

    return adsData.map((ad, i) => ({
      ...ad,
      landing_domain: externalDomains[i] || null,
      image_url: imgs[i] ? imgs[i].src : null,
      video_url: ad.media_type === 'video' && vids[i] ? vids[i] : null,
    }));
  }, ads);

  await browser.close();

  // Deduplica por creative_hash
  const seen = new Set();
  return enriched
    .filter(ad => {
      if (seen.has(ad.creative_hash)) return false;
      seen.add(ad.creative_hash);
      return true;
    })
    .map(ad => {
      // Remove campo interno ad_numeric_id do output final
      const { ad_numeric_id, ...rest } = ad;
      return rest;
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
