# Meta Ads Scraper

Serviço Node.js + Playwright que coleta anúncios da Biblioteca de Anúncios da Meta
e responde no formato JSON esperado pelo workflow n8n.

## Endpoints

### Health check
GET /health
→ Não exige autenticação

### Scraping
POST /webhook/meta-ads
Header: x-api-key: SUA_CHAVE

Body:
{
  "keyword": "suplemento",
  "country": "BR",
  "adCategory": "ALL",
  "maxResults": 30,
  "runId": "opcional"
}

Response:
{
  "runId": "...",
  "keyword": "suplemento",
  "country": "BR",
  "adCategory": "ALL",
  "ads": [
    {
      "advertiser_name": "Marca X",
      "ad_text": "...",
      "status": "ACTIVE",
      "start_date": "...",
      "platforms": ["facebook", "instagram"],
      "media_type": "image",
      "ad_snapshot_url": "...",
      "advertiser_profile_url": "...",
      "image_url": "...",
      "landing_domain": "...",
      "raw_offer_hint": "Compre Agora"
    }
  ]
}

## Deploy no Coolify (sua VPS)

1. Crie um novo Resource → "Docker Compose" no projeto da sua VPS
2. Suba o conteúdo desta pasta como repositório Git (GitHub/GitLab) OU use "Dockerfile" direto
3. Adicione a variável de ambiente:
   SCRAPER_API_KEY=sua-chave-secreta
4. Exponha a porta 3000 com um domínio próprio (ex: scraper.jotav.me)
5. Configure no n8n (nó Config):
   scraperWebhookUrl = https://scraper.jotav.me/webhook/meta-ads
   scraperApiKey     = sua-chave-secreta

## Recursos recomendados na VPS

- RAM: mínimo 1GB dedicado (Playwright + Chromium é pesado)
- CPU: 1 vCPU já resolve para volumes baixos

## Teste local rápido

docker build -t meta-ads-scraper .
docker run -p 3000:3000 -e SCRAPER_API_KEY=teste meta-ads-scraper

curl -X POST http://localhost:3000/webhook/meta-ads \
  -H "Content-Type: application/json" \
  -H "x-api-key: teste" \
  -d '{"keyword": "suplemento", "maxResults": 5}'
