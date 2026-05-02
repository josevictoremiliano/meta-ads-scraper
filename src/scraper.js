const { chromium } = require('playwright');

/**
 * Scraper v3 - Parser corrigido
 * - advertiser_name extraido corretamente (nao confunde com ad_id)
 * - platforms retornado como array limpo (sem double-stringify)
 * - ad_snapshot_url usa o id numerico extraido
 * - sem campo ad_id no output (nao existe na tabela)
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
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });

  const page = await context.newPage();
  await page.route('**/*.{woff,woff2,ttf,mp4,webm}', r => r.abort());
  await page.route('**/video/**', r => r.abort());

  const url = buildUrl({ keyword, country, adCategory });
  console.log(`  Navegando: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.warn('  Timeout no goto, tentando extrair mesmo assim...');
  }

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

  const ads = await page.evaluate((params) => {
    const { maxRes } = params;
    const results = [];
    const bodyText = document.body.innerText;

    // Divide por blocos usando "Identificação da biblioteca" como separador
    const blocks = bodyText.split(/(?=Identificação da biblioteca\s*:\s*\d+)/);

    for (const block of blocks.slice(0, maxRes + 1)) {
      if (!block.includes('Identificação da biblioteca')) continue;

      try {
        // Extrai o ID numerico do anuncio
        const idMatch = block.match(/Identificação da biblioteca\s*:\s*(\d+)/);
        const adNumericId = idMatch ? idMatch[1] : null;
        if (!adNumericId) continue;

        // Remove o bloco do ID da biblioteca do texto para nao contaminar outros campos
        const blockSemId = block.replace(/Identificação da biblioteca\s*:\s*\d+/g, '').trim();

        // Status
        const status = blockSemId.includes('Ativo') ? 'ACTIVE' : 'INACTIVE';

        // Data de inicio
        const dateMatch = blockSemId.match(/Veiculação iniciada em\s+([^\n]+)/);
        const start_date = dateMatch ? dateMatch[1].trim() : null;

        // Plataformas (array limpo, sem stringify)
        const platforms = [];
        const blockLower = blockSemId.toLowerCase();
        if (blockLower.includes('facebook')) platforms.push('facebook');
        if (blockLower.includes('instagram')) platforms.push('instagram');
        if (blockLower.includes('audience network')) platforms.push('audience_network');
        if (blockLower.includes('messenger')) platforms.push('messenger');
        if (platforms.length === 0) platforms.push('facebook');

        // Linhas limpas sem metadados
        const metaPatterns = [
          /Identificação da biblioteca/,
          /Veiculação iniciada em/,
          /^Ativo$/,
          /^Inativo$/,
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
        ];

        const lines = blockSemId
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0);

        // Nome do anunciante: primeira linha que NAO seja metadado e NAO seja so numeros
        let advertiser_name = null;
        for (const line of lines) {
          let isMeta = false;
          for (const p of metaPatterns) {
            if (p.test(line)) { isMeta = true; break; }
          }
          // Ignora linhas que parecem ser o id numerico ou so numeros
          if (/^\d+$/.test(line)) { isMeta = true; }
          if (!isMeta && line.length > 2) {
            advertiser_name = line;
            break;
          }
        }

        // Texto do anuncio: linhas de conteudo real apos o nome do anunciante
        const textLines = lines.filter(line => {
          if (line === advertiser_name) return false;
          for (const p of metaPatterns) {
            if (p.test(line)) return false;
          }
          if (/^\d+$/.test(line)) return false;
          return line.length > 10;
        });

        const ad_text = textLines.slice(0, 5).join(' ') || null;

        // CTA hint
        const ctaPatterns = ['Comprar agora', 'Saiba mais', 'Inscreva-se', 'Assinar', 'Cadastre-se', 'Ver mais', 'Acessar', 'Baixar', 'Entrar em contato', 'Enviar mensagem'];
        let raw_offer_hint = null;
        for (const cta of ctaPatterns) {
          if (blockSemId.includes(cta)) { raw_offer_hint = cta; break; }
        }

        // Tipo de midia
        const media_type = blockLower.includes('vídeo') || blockLower.includes('video') ? 'video' : 'image';

        // URL snapshot usa o id numerico
        const ad_snapshot_url = `https://www.facebook.com/ads/library/?id=${adNumericId}`;

        // creative_hash: hash simples baseado em advertiser + texto
        const hashStr = `${advertiser_name}|${ad_text}`;
        let creative_hash = 0;
        for (let i = 0; i < hashStr.length; i++) {
          creative_hash = ((creative_hash << 5) - creative_hash) + hashStr.charCodeAt(i);
          creative_hash |= 0;
        }
        creative_hash = Math.abs(creative_hash).toString(16) + '_' + adNumericId;

        if (advertiser_name && ad_text) {
          results.push({
            advertiser_name,
            ad_text,
            status,
            start_date,
            platforms,           // array nativo - NAO fazer stringify aqui
            media_type,
            raw_offer_hint,
            ad_snapshot_url,
            advertiser_profile_url: null,
            image_url: null,
            landing_domain: null,
            creative_hash,
          });
        }
      } catch (e) {
        // ignora bloco com erro
      }
    }
    return results;
  }, { maxRes: maxResults });

  // Enriquece com imagem e landing domain do DOM
  const enriched = await page.evaluate((adsData) => {
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    const externalLinks = allLinks
      .filter(a => a.href && !a.href.includes('facebook.com') && !a.href.includes('instagram.com') && a.href.startsWith('http'))
      .map(a => { try { return new URL(a.href).hostname; } catch { return null; } })
      .filter(Boolean);
    const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"], img[src*="scontent"]'));
    return adsData.map((ad, i) => ({
      ...ad,
      landing_domain: externalLinks[i] || null,
      image_url: imgs[i] ? imgs[i].src : null,
    }));
  }, ads);

  await browser.close();

  // Deduplica por creative_hash
  const seen = new Set();
  return enriched.filter(ad => {
    if (seen.has(ad.creative_hash)) return false;
    seen.add(ad.creative_hash);
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
