# octopus-influx-sync

A Node.js service to sync Octopus Energy smart meter data and tariff rates into InfluxDB, designed for running on a Raspberry Pi (Homebridge server).

## Features
- Fetches and stores electricity and gas consumption data from Octopus Energy
- Syncs active Octopus tariff rates daily, including Intelligent Octopus Go day/night rates
- Optionally syncs Octopus smart-charging dispatches into daily EV totals
- Provides a website to log public EV charging receipts
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
- The monthly cost dashboard is available at `http://<server-address>:3002/` by default. Change `DASHBOARD_PORT` if that port is already in use. The page has no login, so keep the published port on a trusted network and do not expose it directly to the internet.

### EV charging data

Set `OCTOPUS_ACCOUNT_NUMBER` alongside the Octopus API key to enable EV session syncing. Every six hours, the service queries the account's SmartFlex charge-point `chargingSessions` and uses `energyAdded` for smart sessions, refreshing the latest seven Europe/London calendar days. If no SmartFlex sessions are returned, it falls back to GraphQL `completedDispatches`. Rewriting the same daily points lets later corrections replace earlier values. The service discovers the active electricity agreement; Intelligent Octopus Go day/night home rates and EV off-peak rates are synced separately. Agile remains the tariff fallback when no account number is configured.

The `ev_charge_daily` measurement stores `charge_kwh`, `charge_cost_pence`, and `cost_complete`, tagged by `account_number`. SmartFlex session energy is priced using the EV device rate; legacy dispatches are priced only when their whole interval fits a returned rate. The SmartFlex API's `energyAdded` may differ from the billed EV-low-rate meter usage shown in the Octopus app, so treat its cost as an estimate rather than an exact bill reconciliation. Octopus retains dispatch/session history for a limited period, and an empty dispatch response alone does not prove that no charging occurred. Whole-home smart-meter readings are not counted as vehicle energy.

Use the website's **Home EV low-rate charging** form to enter a daily energy and cost total from the Octopus app. Saving an existing date replaces that day's SmartFlex estimate in `ev_charge_daily`, and the saved value is reapplied after scheduled session refreshes. The separate `ev_manual_daily` measurement retains the app entry and note. Enter the complete daily app total, not only the difference from the automatic estimate. The recent entries can be edited from the website.

The monthly costs website includes a public-charge form. Enter the session date/time, energy, provider and amount paid; location and a receipt note are optional. These entries are stored separately in `public_ev_charge` and their exact receipt amount and energy are included in monthly EV totals. The website has no login, so keep its port on a trusted network.

## Grafana Dashboard

- To use the provided or custom Grafana dashboards with this data, your Grafana user account must have organizational rights (sufficient permissions to create dashboards and data sources).
- When connecting Grafana to InfluxDB, ensure the data source is set to use the **Flux** query language (not InfluxQL) for full compatibility with InfluxDB 2.x and this project's schema.

The importable `grafana-dashboard.json` includes **Last Month — EV Cost** and **This Month So Far — EV Cost** stat panels. Both combine complete home EV session costs with logged public charging receipts; the current-month panel shows a cumulative daily total.

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
   |> filter(fn: (r) => r._measurement == "ev_charge_daily" and (r._field == "charge_cost_pence" or r._field == "charge_kwh" or r._field == "cost_complete"))
   |> pivot(rowKey: ["_time", "account_number"], columnKey: ["_field"], valueColumn: "_value")

homeEvCost = evDaily
   |> map(fn: (r) => ({_time: r._time, _value: if r.cost_complete then r.charge_cost_pence / 100.0 else 0.0}))
   |> keep(columns: ["_time", "_value"])

publicEvCost = from(bucket: "idb_measurements/autogen")
   |> range(start: -12mo)
   |> filter(fn: (r) => r._measurement == "public_ev_charge" and r._field == "cost_pence")
   |> map(fn: (r) => ({_time: r._time, _value: r._value / 100.0}))
   |> keep(columns: ["_time", "_value"])

ev = union(tables: [homeEvCost, publicEvCost])
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "ev_gbp"}))

homeEvKwh = evDaily
   |> map(fn: (r) => ({_time: r._time, _value: if exists r.charge_kwh then float(v: r.charge_kwh) else 0.0}))
   |> keep(columns: ["_time", "_value"])

publicEvKwh = from(bucket: "idb_measurements/autogen")
   |> range(start: -12mo)
   |> filter(fn: (r) => r._measurement == "public_ev_charge" and r._field == "energy_kwh")
   |> keep(columns: ["_time", "_value"])

evKwh = union(tables: [homeEvKwh, publicEvKwh])
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "ev_kwh"}))

publicCharges = from(bucket: "idb_measurements/autogen")
   |> range(start: -12mo)
   |> filter(fn: (r) => r._measurement == "public_ev_charge" and r._field == "cost_pence")
   |> map(fn: (r) => ({_time: r._time, _value: r._value / 100.0}))
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "public_ev_gbp"}))

evIncomplete = evDaily
   |> map(fn: (r) => ({_time: r._time, _value: if r.cost_complete then 0.0 else 1.0}))
   |> group(columns: [])
   |> aggregateWindow(every: 1mo, fn: sum, createEmpty: false, timeSrc: "_start")
   |> map(fn: (r) => ({_time: r._time, _value: r._value, _field: "ev_incomplete_days"}))

union(tables: [electricity, gas, ev, evKwh, publicCharges, evIncomplete])
   |> group(columns: [])
   |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
   |> sort(columns: ["_time"])
   |> map(fn: (r) => ({
      _time: r._time,
      electricity_gbp: if exists r.electricity_gbp then r.electricity_gbp else 0.0,
      gas_gbp: if exists r.gas_gbp then r.gas_gbp else 0.0,
      ev_gbp: if exists r.ev_gbp then r.ev_gbp else 0.0,
      ev_kwh: if exists r.ev_kwh then r.ev_kwh else 0.0,
      public_ev_gbp: if exists r.public_ev_gbp then r.public_ev_gbp else 0.0,
      ev_incomplete_days: if exists r.ev_incomplete_days then r.ev_incomplete_days else 0.0,
      total_gbp: (if exists r.electricity_gbp then r.electricity_gbp else 0.0) +
         (if exists r.gas_gbp then r.gas_gbp else 0.0) +
         (if exists r.ev_gbp then r.ev_gbp else 0.0),
   }))
```

The EV cost and kWh fields combine home sessions with public receipts; `public_ev_gbp` is a breakdown and is not added again to `total_gbp`. The gas calculation uses the dashboard's `${gas_unit_rate_pence}` variable; if you use this query outside that dashboard, replace it with your gas rate in pence per kWh. `total_gbp` includes only EV days with complete tariff pricing. Check `ev_incomplete_days` before treating a month's total as complete. EV history is available only from when this sync was enabled, and Octopus's dispatch endpoint retains only a few days of source data.

The monthly costs webpage uses the same gas conversion and rate, configured by `GAS_UNIT_RATE_PENCE` (default `6.24`). Electricity cost is matched against stored half-hourly tariff points; months with missing rate matches report the affected interval count. EV days with `cost_complete` false are excluded from dispatch cost totals and shown as a data note. Public receipt costs are included at the entered amount.

## Troubleshooting
- Ensure your `.env` file is present and correct on both your development machine and the Pi.
- Check InfluxDB connectivity and credentials.
- For deployment issues, review the output of the deploy scripts.

## License
MIT
