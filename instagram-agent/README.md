# Instagram Posting Agent for CoupleSexPosition.com

Automated Instagram agent that scrapes content from your website and posts it with engaging captions.

## Setup

### 1. Install Dependencies
```bash
cd instagram-agent
npm install
```

### 2. Get Instagram API Credentials

**Step A: Create Meta Developer App**
1. Go to https://developers.facebook.com/
2. Create a new app → Select "Business" type
3. Add "Instagram Graph API" product

**Step B: Convert to Instagram Business/Creator Account**
1. Open Instagram app → Settings → Account → Switch to Professional Account
2. Choose "Creator" or "Business"
3. Connect to a Facebook Page

**Step C: Get Access Token**
1. In Meta Developer Dashboard → Tools → Graph API Explorer
2. Select your app
3. Generate access token with these permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
4. Extend token to long-lived (60 days)

**Step D: Get Your Instagram User ID**
```
GET https://graph.facebook.com/v19.0/me/accounts?access_token=YOUR_TOKEN
```
Then:
```
GET https://graph.facebook.com/v19.0/{PAGE_ID}?fields=instagram_business_account&access_token=YOUR_TOKEN
```

### 3. Configure Environment
```bash
cp .env.example .env
# Edit .env with your credentials
```

### 4. Scrape Website
```bash
node src/index.js scrape
```

### 5. Post Your First Image
```bash
node src/index.js post
```

### 6. Start Scheduler (Auto-post at 10am & 6pm)
```bash
node src/index.js start
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the scheduler |
| `node src/index.js post` | Post one position now |
| `node src/index.js scrape` | Scrape website content |
| `node src/index.js stats` | View account insights |

## How It Works

1. **Scraper** visits your website and extracts position images + descriptions
2. **Caption Generator** creates engaging posts with emojis, CTAs, and hashtags
3. **Publisher** posts to Instagram via Graph API
4. **Scheduler** runs daily at 10am and 6pm (configurable)

## Limits

- Instagram allows max 25 posts/day via API (default: 2/day)
- Posts must be JPEG format
- Images must be on public URLs
- Containers expire after 24h if not published
