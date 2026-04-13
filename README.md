# Route to Biodiversity

Discover the most observed species along your athletic routes, powered by [iNaturalist](https://www.inaturalist.org) and [Strava](https://www.strava.com). Acknowledges indigenous territories via [Native Land](https://native-land.ca).

## Setup

### Prerequisites

- Python 3.11+
- A [Strava API application](https://www.strava.com/settings/api) (you'll need the Client ID and Client Secret)

### Local development

```bash
cp .env.example .env
# Edit .env with your Strava credentials and a random SESSION_SECRET

pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://localhost:8000.

Set your Strava app's "Authorization Callback Domain" to `localhost` in the Strava API settings.

### Deploy to Railway

```bash
railway login
railway init
railway up

# Set environment variables
railway variables set STRAVA_CLIENT_ID=...
railway variables set STRAVA_CLIENT_SECRET=...
railway variables set BASE_URL=https://<your-app>.up.railway.app
railway variables set SESSION_SECRET=$(openssl rand -hex 32)
```

Update your Strava app's callback domain to match the Railway URL.

## How it works

1. **Connect Strava** or upload a GPX file to define your route
2. The app computes a bounding box around your route
3. Species data is fetched from iNaturalist's observation API
4. Indigenous territories are identified via the Native Land API
5. Results are displayed on an interactive map with a species gallery

## License

MIT
