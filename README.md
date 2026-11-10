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

Set `OCTOPUS_ACCOUNT_NUMBER` alongside the Octopus API key to enable EV dispatch syncing. The service exchanges the API key for a short-lived Kraken JWT before querying GraphQL's `completedDispatches` field every six hours, then refreshes the current and previous two Europe/London calendar-day totals. Rewriting the same day points lets later dispatch corrections replace earlier values. Existing electricity, gas, and tariff syncs remain unchanged.

The `ev_charge_daily` measurement stores `charge_kwh`, `charge_cost_pence`, and `cost_complete`, tagged by `account_number`. Cost uses the Agile tariff rates configured in `index.js`. A dispatch is priced only when its whole interval fits one half-hour rate slot; otherwise `cost_complete` is false because Octopus's dispatch response does not provide per-slot energy for splitting it precisely. Treat the day's cost as exact only when `cost_complete` is true. Octopus retains completed dispatches for only a few days, so prolonged service/API outages can leave a gap that cannot be backfilled from this endpoint.

## Grafana Dashboard

- To use the provided or custom Grafana dashboards with this data, your Grafana user account must have organizational rights (sufficient permissions to create dashboards and data sources).
- When connecting Grafana to InfluxDB, ensure the data source is set to use the **Flux** query language (not InfluxQL) for full compatibility with InfluxDB 2.x and this project's schema.

### Monthly cost logbook

Use this Flux query in a Grafana Table panel to get one row per month with electricity, gas, and EV costs in GBP:

```flux
import "timezone"

option location = timezone.location(name: "Europe/London")

electricity = join(
   tables: {
      c: from(bucket: "idb_measurements/autogen")
         |> range(start: -12mo)
         |> filter(fn: (r) => r._measurement == "electricity_consumption" and r._field == "consumption_kwh"),
      t: from(bucket: "idb_measurements/autogen")
         |> range(start: -12mo)
         |> filter(fn: (r) => r._measurement == "electricity_tariff" and r._field == "unit_rate_pence"),
   },
   on: ["_time"],
)
   |> map(fn: (r) => ({_time: r._time, _value: r._value_c * r._value_t / 100.0}))
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "electricity_gbp"}))

gas = from(bucket: "idb_measurements/autogen")
   |> range(start: -12mo)
   |> filter(fn: (r) => r._measurement == "gas_consumption" and r._field == "consumption_m3")
   |> map(fn: (r) => ({_time: r._time, _value: r._value * 39.2 / 3.6 * ${gas_unit_rate_pence} / 100.0}))
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "gas_gbp"}))

evDaily = from(bucket: "idb_measurements/autogen")
   |> range(start: -12mo)
   |> filter(fn: (r) => r._measurement == "ev_charge_daily" and (r._field == "charge_cost_pence" or r._field == "cost_complete"))
   |> pivot(rowKey: ["_time", "account_number"], columnKey: ["_field"], valueColumn: "_value")

ev = evDaily
   |> map(fn: (r) => ({_time: r._time, _value: if r.cost_complete then r.charge_cost_pence / 100.0 else 0.0}))
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "ev_gbp"}))

evIncomplete = evDaily
   |> map(fn: (r) => ({_time: r._time, _value: if r.cost_complete then 0.0 else 1.0}))
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "ev_incomplete_days"}))

union(tables: [electricity, gas, ev, evIncomplete])
   |> group(columns: [])
   |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
   |> sort(columns: ["_time"])
   |> map(fn: (r) => ({
      _time: r._time,
      electricity_gbp: if exists r.electricity_gbp then r.electricity_gbp else 0.0,
      gas_gbp: if exists r.gas_gbp then r.gas_gbp else 0.0,
      ev_gbp: if exists r.ev_gbp then r.ev_gbp else 0.0,
      ev_incomplete_days: if exists r.ev_incomplete_days then r.ev_incomplete_days else 0.0,
      total_gbp: (if exists r.electricity_gbp then r.electricity_gbp else 0.0) +
         (if exists r.gas_gbp then r.gas_gbp else 0.0) +
         (if exists r.ev_gbp then r.ev_gbp else 0.0),
   }))
```

The gas calculation uses the dashboard's `${gas_unit_rate_pence}` variable; if you use this query outside that dashboard, replace it with your gas rate in pence per kWh. `total_gbp` includes only EV days with complete tariff pricing. Check `ev_incomplete_days` before treating a month's total as complete. EV history is available only from when this sync was enabled, and Octopus's dispatch endpoint retains only a few days of source data.

## Troubleshooting
- Ensure your `.env` file is present and correct on both your development machine and the Pi.
- Check InfluxDB connectivity and credentials.
- For deployment issues, review the output of the deploy scripts.

## License
MIT
