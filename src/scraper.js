const { chromium } = require('playwright');

/**
 * Scraper v2 - Extração baseada em estrutura de texto real da página
 * Não depende de classes CSS dinâmicas do Facebook
 */
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
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    },
  });

  const page = await context.newPage();

  // Bloquear recursos pesados desnecessarios
  await page.route('**/*.{woff,woff2,ttf,mp4,webm}', r => r.abort());
  await page.route('**/video/**', r => r.abort());

  const url = buildUrl({ keyword, country, adCategory });
  console.log(`  Navegando: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.warn('  Timeout no goto, tentando extrair mesmo assim...');
  }

  // Aguarda a página carregar conteúdo real
  await page.waitForTimeout(4000);

  // Scroll progressivo para carregar mais resultados
  const targetCount = Math.min(maxResults, 50);
  for (let i = 0; i < 10; i++) {
    const bodyText = await page.evaluate(() => document.body.innerText);
    const adCount = (bodyText.match(/Identificação da biblioteca/g) || []).length;
    console.log(`  Scroll ${i + 1}: ${adCount} anúncios encontrados`);
    if (adCount >= targetCount) break;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(2000);
  }

  // Extração baseada em texto real da página
  const ads = await page.evaluate((params) => {
    const { maxRes, kw } = params;
    const results = [];
    const bodyText = document.body.innerText;

    // Divide o texto por blocos de anúncio usando o separador real da página
    // Cada anúncio tem "Identificação da biblioteca: XXXXXXXX"
    const blocks = bodyText.split(/(?=Identificação da biblioteca\s*:\s*\d+)/);

    for (const block of blocks.slice(0, maxRes + 1)) {
      if (!block.includes('Identificação da biblioteca')) continue;

      try {
        // ID do anúncio
        const idMatch = block.match(/Identificação da biblioteca\s*:\s*(\d+)/);
        const ad_id = idMatch ? idMatch[1] : null;
        if (!ad_id) continue;

        // Status
        const status = block.includes('Ativo') ? 'ACTIVE' : 'INACTIVE';

        // Data de início
        const dateMatch = block.match(/Veiculação iniciada em\s+([^\n]+)/);
        const start_date = dateMatch ? dateMatch[1].trim() : null;

        // Plataformas
        const platforms = [];
        if (block.toLowerCase().includes('facebook')) platforms.push('facebook');
        if (block.toLowerCase().includes('instagram')) platforms.push('instagram');
        if (block.toLowerCase().includes('audience network')) platforms.push('audience_network');
        if (block.toLowerCase().includes('messenger')) platforms.push('messenger');
        if (platforms.length === 0) platforms.push('facebook');

        // Nome do anunciante - primeira linha não vazia antes do status
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        const advertiser_name = lines[0] || null;

        // Texto do anúncio - linhas que não são metadados
        const metaPatterns = [
          /Identificação da biblioteca/,
          /Veiculação iniciada em/,
          /^Ativo$/,
          /^Inativo$/,
          /^Facebook$/i,
          /^Instagram$/i,
          /^Messenger$/i,
          /Audience Network/i,
          /^Ver detalhes/i,
          /^Patrocinado$/i,
          /^Saiba mais$/i,
          /^Comprar$/i,
          /^Inscreva-se$/i,
          /^Assinar$/i,
          /^Cadastre-se$/i,
        ];

        const textLines = lines.filter(line => {
          if (line === advertiser_name) return false;
          for (const p of metaPatterns) {
            if (p.test(line)) return false;
          }
          return line.length > 10;
        });

        const ad_text = textLines.slice(0, 5).join(' ') || null;

        // CTA hint - detecta botões comuns
        const ctaPatterns = ['Comprar agora', 'Saiba mais', 'Inscreva-se', 'Assinar', 'Cadastre-se', 'Ver mais', 'Acessar', 'Baixar', 'Entrar em contato', 'Enviar mensagem'];
        let raw_offer_hint = null;
        for (const cta of ctaPatterns) {
          if (block.includes(cta)) {
            raw_offer_hint = cta;
            break;
          }
        }

        // Tipo de mídia - inferido pelo contexto
        const media_type = block.toLowerCase().includes('vídeo') || block.toLowerCase().includes('video') ? 'video' : 'image';

        if (advertiser_name && ad_text) {
          results.push({
            ad_id,
            advertiser_name,
            ad_text,
            status,
            start_date,
            platforms,
            media_type,
            raw_offer_hint,
            ad_snapshot_url: `https://www.facebook.com/ads/library/?id=${ad_id}`,
            image_url: null,
            advertiser_profile_url: null,
            landing_domain: null,
          });
        }
      } catch (e) {
        // ignora bloco com erro
      }
    }

    return results;
  }, { maxRes: maxResults, kw: keyword });

  // Tenta enriquecer com dados do DOM (URLs, imagens, links)
  const enriched = await page.evaluate((adsData) => {
    return adsData.map(ad => {
      // Tenta achar o link do anunciante pelo ID
      const allLinks = Array.from(document.querySelectorAll('a[href]'));

      // Landing domain - links externos
      const externalLinks = allLinks
        .filter(a => a.href && !a.href.includes('facebook.com') && !a.href.includes('instagram.com') && a.href.startsWith('http'))
        .map(a => { try { return new URL(a.href).hostname; } catch { return null; } })
        .filter(Boolean);

      // Imagem - primeira imagem de conteúdo
      const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"], img[src*="scontent"]'));
      const image_url = imgs.length > 0 ? imgs[0].src : null;

      return {
        ...ad,
        landing_domain: externalLinks[0] || null,
        image_url,
      };
    });
  }, ads);

  await browser.close();

  // Deduplica por ad_id
  const seen = new Set();
  return enriched.filter(ad => {
    if (seen.has(ad.ad_id)) return false;
    seen.add(ad.ad_id);
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
  if (adCategory && adCategory !== 'ALL') {
    params.set('ad_type', adCategory.toLowerCase());
  }
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

module.exports = { scrapeMetaAds };
