# Installation and Deployment

## Prerequisites

- Python 3.11+
- A [Strava API application](https://www.strava.com/settings/api) (Client ID and Client Secret)

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `STRAVA_CLIENT_ID` | Yes | Strava API app ID |
| `STRAVA_CLIENT_SECRET` | Yes | Strava API secret |
| `BASE_URL` | Yes | App URL for OAuth redirects (e.g. `https://bioroute.pedrolab.org`) |
| `SESSION_SECRET` | Yes | Session cookie signing key |
| `NATIVE_LAND_API_KEY` | No | Native Land Digital API key |
| `EBIRD_API_KEY` | No | eBird / Cornell Lab API key |
| `MINDAT_API_KEY` | No | Mindat mineral database API key |
| `XENOCANTO_API_KEY` | No | Xeno-Canto bird sound API key |
| `GOOGLE_API_KEY` | No | Google API key |
| `GEE_SERVICE_ACCOUNT` | No | Google Earth Engine service account email |
| `GEE_KEY_FILE` | No | Path to GEE service account key file |
| `GEE_KEY_JSON` | No | Inline GEE key JSON (alternative to key file, used on Railway) |
| `GEE_PROJECT` | No | Google Cloud project ID for Earth Engine |

## Local development

```bash
cp .env.example .env
# Edit .env with your credentials

pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000

Set your Strava app's "Authorization Callback Domain" to `localhost` in the [Strava API settings](https://www.strava.com/settings/api).

## Deploy to Railway

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

Railway auto-deploys on push to `master` using the included `Dockerfile`.

```bash
git push origin master
```
