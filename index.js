'use strict';

const Influx = require('influx');
const axios = require('axios');
const cron = require('node-cron');

// ─── Meter & Tariff Constants ─────────────────────────────────────────────────

const ELECTRICITY = {
  mpan: '2000007233223',
  serial: '22J0116172',
  agileRatesUrl:
    'https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-H/standard-unit-rates/',
};

const GAS = {
  mprn: '3979252104',
  serial: 'E6S17957722261',
};

// ─── Config from Environment ──────────────────────────────────────────────────

function loadConfig() {
  const required = {
    OCTOPUS_API_KEY: process.env.OCTOPUS_API_KEY,
    INFLUXDB_HOST: process.env.INFLUXDB_HOST,
    INFLUXDB_DATABASE: process.env.INFLUXDB_DATABASE,
    INFLUXDB_USERNAME: process.env.INFLUXDB_USERNAME,
    INFLUXDB_PASSWORD: process.env.INFLUXDB_PASSWORD,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    octopusApiKey: required.OCTOPUS_API_KEY,
    octopusAccountNumber: process.env.OCTOPUS_ACCOUNT_NUMBER || null,
    influx: {
      host: required.INFLUXDB_HOST,
      port: parseInt(process.env.INFLUXDB_PORT || '8086', 10),
      database: required.INFLUXDB_DATABASE,
      username: required.INFLUXDB_USERNAME,
      password: required.INFLUXDB_PASSWORD,
      protocol: process.env.INFLUXDB_PROTOCOL || 'http',
    },
  };
}

// ─── InfluxDB Client Setup ────────────────────────────────────────────────────

/**
 * InfluxDB schema:
 *
 * measurement: electricity_consumption
 *   tags:   mpan, meter_serial
 *   fields: consumption_kwh (float)
 *
 * measurement: gas_consumption
 *   tags:   mprn, meter_serial
 *   fields: consumption_m3 (float)
 *
 * measurement: electricity_tariff
 *   tags:   tariff_code
 *   fields: unit_rate_pence (float), unit_rate_ex_vat_pence (float)
 *
 * measurement: ev_charge_daily
 *   tags:   account_number
 *   fields: charge_kwh (float), charge_cost_pence (float), cost_complete (boolean)
 */
function createInfluxClient(config) {
  return new Influx.InfluxDB({
    host: config.influx.host,
    port: config.influx.port,
    database: config.influx.database,
    username: config.influx.username,
    password: config.influx.password,
    protocol: config.influx.protocol,
    schema: [
      {
        measurement: 'electricity_consumption',
        fields: { consumption_kwh: Influx.FieldType.FLOAT },
        tags: ['mpan', 'meter_serial'],
      },
      {
        measurement: 'gas_consumption',
        fields: { consumption_m3: Influx.FieldType.FLOAT },
        tags: ['mprn', 'meter_serial'],
      },
      {
        measurement: 'electricity_tariff',
        fields: {
          unit_rate_pence: Influx.FieldType.FLOAT,
          unit_rate_ex_vat_pence: Influx.FieldType.FLOAT,
        },
        tags: ['tariff_code'],
      },
      {
        measurement: 'ev_charge_daily',
        fields: {
          charge_kwh: Influx.FieldType.FLOAT,
          charge_cost_pence: Influx.FieldType.FLOAT,
          cost_complete: Influx.FieldType.BOOLEAN,
        },
        tags: ['account_number'],
      },
    ],
  });
}

// ─── Octopus API Helpers ──────────────────────────────────────────────────────

/**
 * Fetches a single page from the Octopus REST API.
 */
async function octopusGet(apiKey, url, params = {}) {
  const response = await axios.get(url, {
    auth: { username: apiKey, password: '' },
    params: { page_size: 25000, order_by: 'period', ...params },
    timeout: 30000,
  });
  return response.data;
}

/**
 * Fetches ALL pages from a paginated Octopus endpoint.
 * Octopus uses cursor-based pagination via the `next` field.
 */
async function fetchAllPages(apiKey, url, params = {}) {
  const results = [];
  let nextUrl = url;
  let pageParams = params;

  while (nextUrl) {
    const data = await octopusGet(apiKey, nextUrl, pageParams);
    results.push(...(data.results || []));
    // `next` is a full URL; subsequent calls need no extra params
    nextUrl = data.next || null;
    pageParams = {};
  }

  return results;
}

/**
 * Octopus retains completed EV dispatches for only a few days. Fetch the
 * current account's available dispatches and refresh daily totals from them.
 */
async function fetchCompletedDispatches(apiKey, accountNumber) {
  const tokenResponse = await axios.post(
    'https://api.octopus.energy/v1/graphql/',
    {
      query: `mutation ObtainKrakenToken($input: ObtainJSONWebTokenInput!) {
        obtainKrakenToken(input: $input) {
          token
        }
      }`,
      variables: { input: { APIKey: apiKey } },
    },
    { timeout: 30000 }
  );

  const tokenErrors = tokenResponse.data.errors || [];
  if (tokenErrors.length > 0) {
    throw new Error(tokenErrors.map((error) => error.message).join('; '));
  }

  const token = tokenResponse.data.data?.obtainKrakenToken?.token;
  if (!token) {
    throw new Error('Octopus GraphQL did not return an authentication token.');
  }

  const query = `query CompletedDispatches($accountNumber: String!) {
    completedDispatches(accountNumber: $accountNumber) {
      start
      end
      delta
    }
  }`;
  const response = await axios.post(
    'https://api.octopus.energy/v1/graphql/',
    { query, variables: { accountNumber } },
    {
      headers: { Authorization: token },
      timeout: 30000,
    }
  );

  if (response.data.errors && response.data.errors.length > 0) {
    throw new Error(response.data.errors.map((error) => error.message).join('; '));
  }

  const dispatches = response.data.data?.completedDispatches;
  if (!Array.isArray(dispatches)) {
    throw new Error('Octopus GraphQL response did not contain completedDispatches.');
  }
  return dispatches;
}

function londonDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function calculateDispatchCostPence(dispatch, rates) {
  const start = new Date(dispatch.start).getTime();
  const end = new Date(dispatch.end).getTime();
  const chargeKwh = Number(dispatch.chargeInKwh);
  const duration = end - start;

  if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0 || !Number.isFinite(chargeKwh)) {
    return null;
  }

  let coveredMs = 0;
  let matchedRate = null;

  for (const rate of rates) {
    const rateStart = new Date(rate.valid_from).getTime();
    const rateEnd = new Date(rate.valid_to).getTime();
    const overlap = Math.max(0, Math.min(end, rateEnd) - Math.max(start, rateStart));
    if (overlap === 0) continue;

    coveredMs += overlap;
    matchedRate = rate;
  }

  if (coveredMs < duration || !matchedRate) return null;
  const rateStart = new Date(matchedRate.valid_from).getTime();
  const rateEnd = new Date(matchedRate.valid_to).getTime();
  if (start < rateStart || end > rateEnd) return null;

  const unitRate = Number(matchedRate.value_inc_vat);
  return Number.isFinite(unitRate) ? chargeKwh * unitRate : null;
}

// ─── InfluxDB Query Helpers ───────────────────────────────────────────────────

/**
 * Returns the timestamp of the most recent point in a measurement,
 * or null if none exists. We overlap by 2 hours to guard against
 * late-arriving data from Octopus.
 */
async function getLastTimestamp(influx, measurement) {
  try {
    const rows = await influx.query(
      `SELECT LAST(*) FROM ${measurement}`
    );
    if (rows.length > 0 && rows[0].time) {
      return new Date(rows[0].time);
    }
  } catch (err) {
    // Measurement may not exist yet on first run — that's fine
    console.warn(`[InfluxDB] Could not query ${measurement}: ${err.message}`);
  }
  return null;
}

/**
 * Calculates the 'from' date for a sync run.
 *
 * Priority order:
 *  1. BACKFILL_DAYS env var — ignores existing data and forces a full lookback.
 *     Set this to trigger a historical backfill, then remove it for normal operation.
 *  2. Last recorded timestamp in InfluxDB — overlaps by 2 hours to catch
 *     any late-arriving points from Octopus.
 *  3. Default 365-day lookback — used only when a measurement is completely empty.
 */
function calcFrom(lastTimestamp, lookbackDays = 365) {
  const forcedDays = process.env.BACKFILL_DAYS ? parseInt(process.env.BACKFILL_DAYS, 10) : null;
  if (forcedDays) {
    const forced = new Date();
    forced.setDate(forced.getDate() - forcedDays);
    console.log(`  (BACKFILL_DAYS=${forcedDays} override active — ignoring last stored timestamp)`);
    return forced;
  }
  if (lastTimestamp) {
    return new Date(lastTimestamp.getTime() - 2 * 60 * 60 * 1000);
  }
  const fallback = new Date();
  fallback.setDate(fallback.getDate() - lookbackDays);
  return fallback;
}

// ─── Sync Functions ───────────────────────────────────────────────────────────

/**
 * Syncs electricity consumption from Octopus into InfluxDB.
 * Each 30-minute interval is written as one point.
 */
async function syncElectricityConsumption(apiKey, influx, from, to) {
  const label = '[Electricity Consumption]';
  console.log(`${label} Fetching ${from.toISOString()} → ${to.toISOString()}`);

  const url = `https://api.octopus.energy/v1/electricity-meter-points/${ELECTRICITY.mpan}/meters/${ELECTRICITY.serial}/consumption/`;
  const intervals = await fetchAllPages(apiKey, url, {
    period_from: from.toISOString(),
    period_to: to.toISOString(),
  });

  if (intervals.length === 0) {
    console.log(`${label} No new intervals returned.`);
    return 0;
  }

  const points = intervals.map((interval) => ({
    measurement: 'electricity_consumption',
    tags: {
      mpan: ELECTRICITY.mpan,
      meter_serial: ELECTRICITY.serial,
    },
    fields: {
      consumption_kwh: parseFloat(interval.consumption),
    },
    // InfluxDB 1.x timestamp in nanoseconds
    timestamp: new Date(interval.interval_start),
  }));

  await influx.writePoints(points, { precision: 's' });
  console.log(`${label} Written ${points.length} points.`);
  return points.length;
}

/**
 * Syncs gas consumption from Octopus into InfluxDB.
 * Octopus returns gas in m³ — conversion to kWh can be done in Grafana
 * (multiply by calorific value ~39.2 and divide by 3.6).
 */
async function syncGasConsumption(apiKey, influx, from, to) {
  const label = '[Gas Consumption]';
  console.log(`${label} Fetching ${from.toISOString()} → ${to.toISOString()}`);

  const url = `https://api.octopus.energy/v1/gas-meter-points/${GAS.mprn}/meters/${GAS.serial}/consumption/`;
  const intervals = await fetchAllPages(apiKey, url, {
    period_from: from.toISOString(),
    period_to: to.toISOString(),
  });

  if (intervals.length === 0) {
    console.log(`${label} No new intervals returned.`);
    return 0;
  }

  const points = intervals.map((interval) => ({
    measurement: 'gas_consumption',
    tags: {
      mprn: GAS.mprn,
      meter_serial: GAS.serial,
    },
    fields: {
      consumption_m3: parseFloat(interval.consumption),
    },
    timestamp: new Date(interval.interval_start),
  }));

  await influx.writePoints(points, { precision: 's' });
  console.log(`${label} Written ${points.length} points.`);
  return points.length;
}

/**
 * Syncs Agile electricity unit rates from Octopus into InfluxDB.
 * Agile prices for the next day are published at ~4 PM daily.
 * Each 30-minute slot gets its own point timestamped at valid_from.
 */
async function syncAgileRates(apiKey, influx, from, to) {
  const label = '[Agile Tariff]';
  console.log(`${label} Fetching ${from.toISOString()} → ${to.toISOString()}`);

  const rates = await fetchAllPages(apiKey, ELECTRICITY.agileRatesUrl, {
    period_from: from.toISOString(),
    period_to: to.toISOString(),
  });

  if (rates.length === 0) {
    console.log(`${label} No new rates returned.`);
    return 0;
  }

  const points = rates.map((rate) => ({
    measurement: 'electricity_tariff',
    tags: {
      tariff_code: 'AGILE-24-10-01',
    },
    fields: {
      unit_rate_pence: parseFloat(rate.value_inc_vat),
      unit_rate_ex_vat_pence: parseFloat(rate.value_exc_vat),
    },
    timestamp: new Date(rate.valid_from),
  }));

  await influx.writePoints(points, { precision: 's' });
  console.log(`${label} Written ${points.length} rate slots.`);
  return points.length;
}

/**
 * Syncs Octopus smart-charging dispatches into daily EV totals. Octopus only
 * retains a short dispatch history, so the latest three London calendar days
 * are re-fetched and rewritten on every run to pick up corrections.
 */
async function syncEvChargeDaily(apiKey, accountNumber, influx) {
  const label = '[EV Charge]';
  const now = new Date();
  const from = new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const today = londonDateKey(now);
  const days = [-2, -1, 0].map((offset) => addCalendarDays(today, offset));
  const totals = new Map(days.map((day) => [day, {
    chargeKwh: 0,
    chargeCostPence: 0,
    costComplete: true,
  }]));

  console.log(`${label} Refreshing dispatches since ${from.toISOString()}`);

  const [dispatches, rates] = await Promise.all([
    fetchCompletedDispatches(apiKey, accountNumber),
    fetchAllPages(apiKey, ELECTRICITY.agileRatesUrl, {
      period_from: from.toISOString(),
      period_to: now.toISOString(),
    }),
  ]);

  for (const dispatch of dispatches) {
    const start = new Date(dispatch.start);
    const startMs = start.getTime();
    const chargeKwh = Number(dispatch.delta);
    if (!Number.isFinite(startMs) || startMs < from.getTime() || startMs > now.getTime() ||
      dispatch.delta == null ||
        !Number.isFinite(chargeKwh) || chargeKwh < 0) {
      continue;
    }

    const total = totals.get(londonDateKey(start));
    if (!total) continue;

    total.chargeKwh += chargeKwh;
    const costPence = calculateDispatchCostPence(dispatch, rates);
    if (costPence === null) {
      total.costComplete = false;
    } else {
      total.chargeCostPence += costPence;
    }
  }

  const points = days.map((day) => {
    const total = totals.get(day);
    return {
      measurement: 'ev_charge_daily',
      tags: { account_number: accountNumber },
      fields: {
        charge_kwh: total.chargeKwh,
        charge_cost_pence: total.chargeCostPence,
        cost_complete: total.costComplete,
      },
      // UTC midnight is a stable point key for each London calendar date.
      timestamp: new Date(`${day}T00:00:00Z`),
    };
  });

  await influx.writePoints(points, { precision: 's' });
  const incompleteDays = days.filter((day) => !totals.get(day).costComplete);
  console.log(`${label} Updated ${points.length} daily totals.`);
  if (incompleteDays.length > 0) {
    console.warn(`${label} Exact cost unavailable for ${incompleteDays.join(', ')}; a dispatch crossed tariff slots or had no matching rate.`);
  }
  return points.length;
}

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────

/**
 * Consumption sync — runs at 06:00 daily (Europe/London).
 *
 * Octopus consumption data is typically delayed 24 hours, so running
 * in the morning reliably captures the previous day's full data.
 * A 2-hour overlap window ensures no half-hour slots are missed.
 */
async function runConsumptionSync(apiKey, influx) {
  console.log('\n════════════════════════════════════');
  console.log('  Consumption Sync — ' + new Date().toISOString());
  console.log('════════════════════════════════════');

  try {
    const [lastElec, lastGas] = await Promise.all([
      getLastTimestamp(influx, 'electricity_consumption'),
      getLastTimestamp(influx, 'gas_consumption'),
    ]);

    const now = new Date();
    const elecFrom = calcFrom(lastElec, 365);
    const gasFrom = calcFrom(lastGas, 365);

    await syncElectricityConsumption(apiKey, influx, elecFrom, now);
    await syncGasConsumption(apiKey, influx, gasFrom, now);

    console.log('✓ Consumption sync complete.\n');
  } catch (err) {
    console.error('✗ Consumption sync failed:', err.message);
    if (err.response) {
      console.error('  HTTP', err.response.status, err.response.data);
    }
  }
}

/**
 * Tariff rate sync — runs at 16:30 daily (Europe/London).
 *
 * Octopus publishes Agile prices for the next day at approximately
 * 4 PM, so 16:30 is the earliest reliable fetch window.
 * Fetches through end of tomorrow to always have tomorrow's rates.
 */
async function runTariffSync(apiKey, influx) {
  console.log('\n════════════════════════════════════');
  console.log('  Tariff Rate Sync — ' + new Date().toISOString());
  console.log('════════════════════════════════════');

  try {
    const lastRate = await getLastTimestamp(influx, 'electricity_tariff');
    const from = calcFrom(lastRate, 365);

    // Fetch through end of tomorrow so we always have next-day rates
    const endOfTomorrow = new Date();
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 2);
    endOfTomorrow.setHours(0, 0, 0, 0);

    await syncAgileRates(apiKey, influx, from, endOfTomorrow);

    console.log('✓ Tariff sync complete.\n');
  } catch (err) {
    console.error('✗ Tariff sync failed:', err.message);
    if (err.response) {
      console.error('  HTTP', err.response.status, err.response.data);
    }
  }
}

async function runEvChargeSync(apiKey, accountNumber, influx) {
  try {
    await syncEvChargeDaily(apiKey, accountNumber, influx);
  } catch (err) {
    console.error('[EV Charge] Sync failed:', err.message);
    if (err.response) {
      console.error('  HTTP', err.response.status, err.response.data);
    }
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║    Octopus → InfluxDB Sync v1.0.0    ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('Starting at', new Date().toISOString());

  // Validate env and build config
  const config = loadConfig();
  console.log(`InfluxDB: ${config.influx.protocol}://${config.influx.host}:${config.influx.port}/${config.influx.database}`);

  // Initialise InfluxDB client
  const influx = createInfluxClient(config);

  // Verify InfluxDB connectivity
  try {
    await influx.getDatabaseNames();
    console.log('✓ InfluxDB connection OK\n');
  } catch (err) {
    console.error('✗ Cannot reach InfluxDB:', err.message);
    process.exit(1);
  }

  const { octopusApiKey, octopusAccountNumber } = config;

  // ── Initial backfill on startup ──────────────────────────────────────────
  await runConsumptionSync(octopusApiKey, influx);
  await runTariffSync(octopusApiKey, influx);
  if (octopusAccountNumber) {
    await runEvChargeSync(octopusApiKey, octopusAccountNumber, influx);
  }

  // ── 06:00 daily — consumption sync (data ready ~24h after metering) ───────
  cron.schedule('0 6 * * *', () => runConsumptionSync(octopusApiKey, influx), {
    timezone: 'Europe/London',
  });
  console.log('⏰ Scheduled: consumption sync at 06:00 Europe/London');

  // ── 16:30 daily — Agile rate sync (tomorrow's prices published ~16:00) ────
  cron.schedule('30 16 * * *', () => runTariffSync(octopusApiKey, influx), {
    timezone: 'Europe/London',
  });
  console.log('⏰ Scheduled: tariff rate sync at 16:30 Europe/London');

  if (octopusAccountNumber) {
    cron.schedule('15 */6 * * *', () => runEvChargeSync(octopusApiKey, octopusAccountNumber, influx), {
      timezone: 'Europe/London',
    });
    console.log('⏰ Scheduled: EV dispatch refresh every 6 hours Europe/London');
  } else {
    console.log('EV dispatch sync disabled: set OCTOPUS_ACCOUNT_NUMBER to enable it.');
  }

  console.log('\nService running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});