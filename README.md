# octopus-influx-sync

A Node.js service to sync Octopus Energy smart meter data and Agile tariff rates into InfluxDB, designed for running on a Raspberry Pi (Homebridge server).

## Features
- Fetches and stores electricity and gas consumption data from Octopus Energy
- Syncs Agile tariff rates daily
- Optionally syncs Octopus smart-charging dispatches into daily EV totals
- Schedules data syncs using cron
- Deployable via PowerShell or Bash scripts
- Docker support for easy deployment

<img width="3418" height="1090" alt="image" src="https://github.com/user-attachments/assets/3c7b978a-a890-427b-b7ad-c7842467fc8e" />

## Prerequisites
- Node.js and npm installed (v18+ recommended)
- InfluxDB instance accessible
- Octopus Energy API key
- .env file configured (see `.env.example`)
- (Optional) Docker and docker-compose for containerized deployment

## Setup

1. **Clone the repository:**
   ```sh
   git clone https://github.com/merlinmb/octopus-influx-sync.git
   cd octopus-influx-sync
   ```

2. **Install dependencies:**
   ```sh
   npm install
   ```

3. **Configure environment:**
   - Copy `.env.example` to `.env` and fill in your credentials and settings.

4. **Run locally:**
   ```sh
   node index.js
   ```

5. **Deploy to Raspberry Pi:**
   - Use the provided `deploy.ps1` (PowerShell) or `deploy.sh` (Bash) scripts to deploy to your Pi via SSH.

6. **Docker (optional):**
   - Build and run with Docker Compose:
     ```sh
     docker compose up --build -d
     ```

## Usage
- The service will schedule and run data syncs automatically.
- Logs and errors are printed to the console and available via Docker logs if running in a container.

### EV charging data

Set `OCTOPUS_ACCOUNT_NUMBER` alongside the Octopus API key to enable EV dispatch syncing. The service queries Octopus's GraphQL `completedDispatches` data every six hours and refreshes the current and previous two Europe/London calendar-day totals. Rewriting the same day points lets later dispatch corrections replace earlier values. Existing electricity, gas, and tariff syncs remain unchanged.

The `ev_charge_daily` measurement stores `charge_kwh`, `charge_cost_pence`, and `cost_complete`, tagged by `account_number`. Cost uses the Agile tariff rates configured in `index.js`. A dispatch is priced only when its whole interval fits one half-hour rate slot; otherwise `cost_complete` is false because Octopus's dispatch response does not provide per-slot energy for splitting it precisely. Treat the day's cost as exact only when `cost_complete` is true. Octopus retains completed dispatches for only a few days, so prolonged service/API outages can leave a gap that cannot be backfilled from this endpoint.

## Grafana Dashboard

- To use the provided or custom Grafana dashboards with this data, your Grafana user account must have organizational rights (sufficient permissions to create dashboards and data sources).
- When connecting Grafana to InfluxDB, ensure the data source is set to use the **Flux** query language (not InfluxQL) for full compatibility with InfluxDB 2.x and this project's schema.

## Troubleshooting
- Ensure your `.env` file is present and correct on both your development machine and the Pi.
- Check InfluxDB connectivity and credentials.
- For deployment issues, review the output of the deploy scripts.

## License
MIT
