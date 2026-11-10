'use strict';

const Influx = require('influx');
const axios = require('axios');
const cron = require('node-cron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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

// Gas meters record cubic metres; bills use kWh. ~39.2 MJ per m³, 3.6 MJ per kWh.
const GAS_KWH_PER_M3 = 39.2 / 3.6;

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

  // The car bridge writes odometer points into another InfluxDB database. The
  // dashboard reads them to calculate monthly EV efficiency (mi/kWh). Volvo
  // reports distance in kilometres by default, so values are converted to miles.
  const odometerUnit = String(process.env.VOLVO_ODOMETER_UNIT || 'km').trim().toLowerCase();
  const odometerUnitIsKm = ['km', 'kilometre', 'kilometres', 'kilometer', 'kilometers'].includes(odometerUnit);

  return {
    octopusApiKey: required.OCTOPUS_API_KEY,
    octopusAccountNumber: process.env.OCTOPUS_ACCOUNT_NUMBER || null,
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    gasUnitRatePence: parseFloat(process.env.GAS_UNIT_RATE_PENCE || '6.24'),
    odometer: {
      database: process.env.VOLVO_ODOMETER_DATABASE || 'environmentals',
      measurement: process.env.VOLVO_ODOMETER_MEASUREMENT || 'mcmdhome/volvo/odometer',
      unit: odometerUnitIsKm ? 'km' : 'mi',
      // Multiplier applied to raw odometer values to express them in miles.
      milesFactor: odometerUnitIsKm ? 0.621371 : 1,
    },
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
 *
 * measurement: public_ev_charge
 *   tags:   charge_id, provider, location
 *   fields: energy_kwh (float), cost_pence (float), notes (string)
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
      {
        measurement: 'ev_manual_daily',
        fields: {
          charge_kwh: Influx.FieldType.FLOAT,
          charge_cost_pence: Influx.FieldType.FLOAT,
          notes: Influx.FieldType.STRING,
        },
        tags: ['account_number'],
      },
      {
        measurement: 'public_ev_charge',
        fields: {
          energy_kwh: Influx.FieldType.FLOAT,
          cost_pence: Influx.FieldType.FLOAT,
          notes: Influx.FieldType.STRING,
        },
        tags: ['charge_id', 'provider', 'location'],
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

async function fetchSmartFlexChargingSessions(apiKey, accountNumber, from, to) {
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
  if (!token) throw new Error('Octopus GraphQL did not return an authentication token.');

  const query = `query SmartFlexChargingSessions($accountNumber: String!, $after: DateTime, $before: DateTime) {
    devices(accountNumber: $accountNumber) {
      ... on SmartFlexChargePoint {
        chargingSessions(after: $after, before: $before, first: 100) {
          edges {
            node {
              __typename
              start
              end
              energyAdded { value unit }
              ... on SmartFlexChargingSession { type }
            }
          }
        }
      }
    }
  }`;
  const response = await axios.post(
    'https://api.octopus.energy/v1/graphql/',
    {
      query,
      variables: {
        accountNumber,
        after: from.toISOString(),
        before: to.toISOString(),
      },
    },
    {
      headers: { Authorization: token },
      timeout: 30000,
    }
  );

  if (response.data.errors && response.data.errors.length > 0) {
    throw new Error(response.data.errors.map((error) => error.message).join('; '));
  }

  return (response.data.data?.devices || [])
    .flatMap((device) => device.chargingSessions?.edges?.map((edge) => edge.node) || [])
    .filter((session) => session.__typename === 'SmartFlexChargingSession' && session.type === 'SMART');
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
  const chargeKwh = Number(dispatch.delta);
  const duration = end - start;

  if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0 || !Number.isFinite(chargeKwh)) {
    return null;
  }

  let coveredMs = 0;
  let matchedRate = null;

  for (const rate of rates) {
    const rateStart = new Date(rate.valid_from).getTime();
    const rateEnd = rate.valid_to ? new Date(rate.valid_to).getTime() : Infinity;
    const overlap = Math.max(0, Math.min(end, rateEnd) - Math.max(start, rateStart));
    if (overlap === 0) continue;

    coveredMs += overlap;
    matchedRate = rate;
  }

  if (coveredMs < duration || !matchedRate) return null;
  const rateStart = new Date(matchedRate.valid_from).getTime();
  const rateEnd = matchedRate.valid_to ? new Date(matchedRate.valid_to).getTime() : Infinity;
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

function londonMonthKey(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}`;
}

function shiftMonth(monthKey, amount) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + amount, 1)).toISOString().slice(0, 7);
}

async function queryMeasurement(influx, measurement, fields, from, options = {}) {
  try {
    return await influx.query(
      `SELECT ${fields.join(', ')} FROM ${measurement} WHERE time >= '${from}'`,
      options.database ? { database: options.database } : undefined
    );
  } catch (err) {
    if (/measurement not found|retention policy .* not found|database not found/i.test(err.message)) {
      return [];
    }
    throw err;
  }
}

function escapeInfluxName(name) {
  return `"${String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Calculates miles driven per London calendar month from the car's odometer.
 *
 * The odometer is written as cumulative readings, so a month's distance is the
 * last reading in the month minus the last reading from an earlier month. A
 * month is only reported when it has at least one reading and a baseline no
 * more than 45 days older than the month, which avoids attributing a long gap
 * in the feed to a single month. Values are converted from the configured
 * odometer unit to miles.
 */
async function getMonthlyMiles(influx, odometer, monthKeys) {
  const from = new Date(`${shiftMonth(monthKeys[0], -1)}-01T00:00:00.000Z`).toISOString();
  let rows;
  try {
    rows = await queryMeasurement(
      influx,
      escapeInfluxName(odometer.measurement),
      ['value'],
      from,
      { database: odometer.database }
    );
  } catch (err) {
    // Efficiency is supplementary: a missing or unreadable odometer database
    // must not take the cost dashboard down.
    console.warn('[Dashboard] Odometer query failed:', err.message);
    return new Map();
  }

  const readings = rows
    .map((row) => ({ time: new Date(row.time).getTime(), value: Number(row.value) }))
    .filter((reading) => Number.isFinite(reading.time) && Number.isFinite(reading.value))
    .sort((left, right) => left.time - right.time);

  const readingsByMonth = new Map(monthKeys.map((key) => [key, []]));
  const readingsBefore = [];
  for (const reading of readings) {
    const key = londonMonthKey(new Date(reading.time));
    if (readingsByMonth.has(key)) {
      readingsByMonth.get(key).push(reading);
    } else if (key < monthKeys[0]) {
      readingsBefore.push(reading);
    }
  }

  const maxBaselineAgeMs = 45 * 24 * 60 * 60 * 1000;
  const milesByMonth = new Map();
  let baseline = readingsBefore.length > 0 ? readingsBefore[readingsBefore.length - 1] : null;

  for (const key of monthKeys) {
    const monthReadings = readingsByMonth.get(key);
    const monthStart = new Date(`${key}-01T00:00:00.000Z`).getTime();
    const last = monthReadings[monthReadings.length - 1];
    if (baseline && last && monthStart - baseline.time <= maxBaselineAgeMs) {
      const miles = (last.value - baseline.value) * odometer.milesFactor;
      if (Number.isFinite(miles) && miles >= 0) milesByMonth.set(key, miles);
    }
    if (last) baseline = last;
  }

  return milesByMonth;
}

async function getMonthlyCosts(influx, gasUnitRatePence, config) {
  const currentMonth = londonMonthKey(new Date());
  const monthKeys = Array.from({ length: 12 }, (_, index) => shiftMonth(currentMonth, index - 11));
  const from = new Date(`${monthKeys[0]}-01T00:00:00.000Z`).toISOString();
  const [electricityRows, tariffRows, gasRows, evRows, publicChargeRows, milesByMonth] = await Promise.all([
    queryMeasurement(influx, 'electricity_consumption', ['consumption_kwh'], from),
    queryMeasurement(influx, 'electricity_tariff', ['unit_rate_pence', 'tariff_code'], from),
    queryMeasurement(influx, 'gas_consumption', ['consumption_m3'], from),
    queryMeasurement(influx, 'ev_charge_daily', ['charge_kwh', 'charge_cost_pence', 'cost_complete'], from),
    queryMeasurement(influx, 'public_ev_charge', ['energy_kwh', 'cost_pence'], from),
    config?.odometer ? getMonthlyMiles(influx, config.odometer, monthKeys) : Promise.resolve(new Map()),
  ]);

  const months = new Map(monthKeys.map((month) => [month, {
    month,
    electricityCostGbp: 0,
    electricityKwh: 0,
    electricityUnpricedIntervals: 0,
    gasCostGbp: 0,
    gasM3: 0,
    gasKwh: 0,
    evCostGbp: 0,
    evKwh: 0,
    evDays: 0,
    publicChargeCount: 0,
    evIncompleteDays: 0,
    totalCostGbp: 0,
  }]));
  const ratesByTime = new Map();
  for (const row of tariffRows) {
    const time = new Date(row.time).getTime();
    const tariffCode = String(row.tariff_code || '');
    const current = ratesByTime.get(time);
    const prefersRow = !current ||
      (tariffCode.includes('IOG') && !current.tariffCode.includes('IOG'));
    if (prefersRow) {
      ratesByTime.set(time, { rate: Number(row.unit_rate_pence), tariffCode });
    }
  }

  for (const row of electricityRows) {
    const month = months.get(londonMonthKey(new Date(row.time)));
    if (!month) continue;
    const kwh = Number(row.consumption_kwh);
    if (!Number.isFinite(kwh)) continue;
    month.electricityKwh += kwh;
    const rate = ratesByTime.get(new Date(row.time).getTime())?.rate;
    if (Number.isFinite(rate)) {
      month.electricityCostGbp += kwh * rate / 100;
    } else {
      month.electricityUnpricedIntervals += 1;
    }
  }

  for (const row of gasRows) {
    const month = months.get(londonMonthKey(new Date(row.time)));
    if (!month) continue;
    const m3 = Number(row.consumption_m3);
    if (!Number.isFinite(m3)) continue;
    month.gasM3 += m3;
    month.gasKwh += m3 * GAS_KWH_PER_M3;
    month.gasCostGbp += m3 * GAS_KWH_PER_M3 * gasUnitRatePence / 100;
  }

  for (const row of evRows) {
    const month = months.get(londonMonthKey(new Date(row.time)));
    if (!month) continue;
    month.evDays += 1;
    month.evKwh += Number(row.charge_kwh) || 0;
    if (row.cost_complete === true || row.cost_complete === 'true') {
      month.evCostGbp += (Number(row.charge_cost_pence) || 0) / 100;
    } else {
      month.evIncompleteDays += 1;
    }
  }

  for (const row of publicChargeRows) {
    const month = months.get(londonMonthKey(new Date(row.time)));
    if (!month) continue;
    month.publicChargeCount += 1;
    month.evKwh += Number(row.energy_kwh) || 0;
    month.evCostGbp += (Number(row.cost_pence) || 0) / 100;
  }

  for (const month of months.values()) {
    month.totalCostGbp = month.electricityCostGbp + month.gasCostGbp + month.evCostGbp;
    const miles = milesByMonth.get(month.month);
    month.evMiles = Number.isFinite(miles) ? Math.round(miles * 10) / 10 : null;
    month.evEfficiencyMiPerKwh =
      month.evMiles !== null && month.evKwh > 0
        ? Math.round(month.evMiles / month.evKwh * 100) / 100
        : null;
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: 'Europe/London',
    gasUnitRatePence,
    months: [...months.values()],
  };
}

async function getRecentPublicCharges(influx) {
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await queryMeasurement(
    influx,
    'public_ev_charge',
    ['energy_kwh', 'cost_pence', 'notes', 'charge_id', 'provider', 'location'],
    from
  );

  return rows
    .sort((left, right) => new Date(right.time) - new Date(left.time))
    .slice(0, 50)
    .map((row) => ({
      id: row.charge_id,
      chargedAt: new Date(row.time).toISOString(),
      provider: row.provider,
      location: row.location,
      energyKwh: Number(row.energy_kwh),
      costGbp: Number(row.cost_pence) / 100,
      notes: row.notes || '',
    }));
}

async function getRecentManualEvTotals(influx) {
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await queryMeasurement(
    influx,
    'ev_manual_daily',
    ['charge_kwh', 'charge_cost_pence', 'notes'],
    from
  );

  return rows
    .sort((left, right) => new Date(right.time) - new Date(left.time))
    .slice(0, 50)
    .map((row) => ({
      date: londonDateKey(new Date(row.time)),
      energyKwh: Number(row.charge_kwh),
      costGbp: Number(row.charge_cost_pence) / 100,
      notes: row.notes || '',
    }));
}

function readJsonBody(request, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooLarge = true;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function validatePublicCharge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
  }

  const chargedAt = new Date(input.chargedAt);
  const energyKwh = Number(input.energyKwh);
  const costGbp = Number(input.costGbp);
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const location = typeof input.location === 'string' ? input.location.trim() : '';
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';

  if (!Number.isFinite(chargedAt.getTime()) || chargedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw Object.assign(new Error('Enter a valid charge date and time that is not in the future.'), { statusCode: 400 });
  }
  if (input.energyKwh == null || !Number.isFinite(energyKwh) || energyKwh <= 0 || energyKwh > 300) {
    throw Object.assign(new Error('Energy must be greater than 0 and no more than 300 kWh.'), { statusCode: 400 });
  }
  if (input.costGbp == null || !Number.isFinite(costGbp) || costGbp < 0 || costGbp > 1000) {
    throw Object.assign(new Error('Cost must be between £0 and £1,000.'), { statusCode: 400 });
  }
  if (!provider || provider.length > 80 || location.length > 120 || notes.length > 500) {
    throw Object.assign(new Error('Provider is required; provider, location, or note is too long.'), { statusCode: 400 });
  }

  return { chargedAt, energyKwh, costGbp, provider, location, notes };
}

function validateManualEvTotal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
  }

  const date = typeof input.date === 'string' ? input.date : '';
  const timestamp = new Date(`${date}T00:00:00.000Z`);
  const energyKwh = Number(input.energyKwh);
  const costGbp = Number(input.costGbp);
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString().slice(0, 10) !== date || timestamp.getTime() > Date.now()) {
    throw Object.assign(new Error('Enter a valid past date.'), { statusCode: 400 });
  }
  if (input.energyKwh == null || !Number.isFinite(energyKwh) || energyKwh <= 0 || energyKwh > 300) {
    throw Object.assign(new Error('Energy must be greater than 0 and no more than 300 kWh.'), { statusCode: 400 });
  }
  if (input.costGbp == null || !Number.isFinite(costGbp) || costGbp < 0 || costGbp > 1000) {
    throw Object.assign(new Error('Cost must be between £0 and £1,000.'), { statusCode: 400 });
  }
  if (notes.length > 500) {
    throw Object.assign(new Error('Note must be 500 characters or fewer.'), { statusCode: 400 });
  }

  return { date, timestamp, energyKwh, costGbp, notes };
}

function startDashboardServer(influx, config) {
  const dashboardFile = path.join(__dirname, 'monthly-costs.html');
  const monthlyCostsCacheTtlMs = 24 * 60 * 60 * 1000;
  let monthlyCostsCache;
  let monthlyCostsCacheExpiresAt = 0;
  let monthlyCostsCachePromise;
  let monthlyCostsCacheVersion = 0;

  function invalidateMonthlyCostsCache() {
    monthlyCostsCacheVersion += 1;
    monthlyCostsCache = null;
    monthlyCostsCacheExpiresAt = 0;
    monthlyCostsCachePromise = null;
  }

  function getCachedMonthlyCosts() {
    if (monthlyCostsCache && Date.now() < monthlyCostsCacheExpiresAt) {
      return Promise.resolve(monthlyCostsCache);
    }
    if (!monthlyCostsCachePromise) {
      const requestVersion = monthlyCostsCacheVersion;
      monthlyCostsCachePromise = getMonthlyCosts(influx, config.gasUnitRatePence, config)
        .then((result) => {
          if (requestVersion === monthlyCostsCacheVersion) {
            monthlyCostsCache = result;
            monthlyCostsCacheExpiresAt = Date.now() + monthlyCostsCacheTtlMs;
          }
          return result;
        })
        .finally(() => {
          if (requestVersion === monthlyCostsCacheVersion) monthlyCostsCachePromise = null;
        });
    }
    return monthlyCostsCachePromise;
  }

  async function warmMonthlyCostsCache() {
    invalidateMonthlyCostsCache();
    try {
      await getCachedMonthlyCosts();
    } catch (err) {
      console.warn('[Dashboard] Could not warm monthly cost cache:', err.message);
    }
  }

  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/public-charges') {
      try {
        const charges = await getRecentPublicCharges(influx);
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({ charges }));
      } catch (err) {
        console.error('[Dashboard] Public charge query failed:', err.message);
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Could not load public charges.' }));
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/api/public-charges') {
      try {
        if (!String(request.headers['content-type'] || '').includes('application/json')) {
          throw Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 415 });
        }
        const charge = validatePublicCharge(await readJsonBody(request));
        const id = randomUUID();
        await influx.writePoints([{
          measurement: 'public_ev_charge',
          tags: {
            charge_id: id,
            provider: charge.provider,
            location: charge.location || 'Not specified',
          },
          fields: {
            energy_kwh: charge.energyKwh,
            cost_pence: charge.costGbp * 100,
            notes: charge.notes,
          },
          timestamp: charge.chargedAt,
        }], { precision: 's' });
        invalidateMonthlyCostsCache();

        response.writeHead(201, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({
          charge: {
            id,
            chargedAt: charge.chargedAt.toISOString(),
            provider: charge.provider,
            location: charge.location || 'Not specified',
            energyKwh: charge.energyKwh,
            costGbp: charge.costGbp,
            notes: charge.notes,
          },
        }));
      } catch (err) {
        const statusCode = err.statusCode || 500;
        if (statusCode >= 500) console.error('[Dashboard] Public charge write failed:', err.message);
        response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: statusCode >= 500 ? 'Could not save public charge.' : err.message }));
      }
      return;
    }

    if (request.method === 'GET' && request.url === '/api/ev-home-low-rate') {
      try {
        const totals = await getRecentManualEvTotals(influx);
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({ totals }));
      } catch (err) {
        console.error('[Dashboard] Manual EV total query failed:', err.message);
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Could not load manual EV totals.' }));
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/api/ev-home-low-rate') {
      try {
        if (!String(request.headers['content-type'] || '').includes('application/json')) {
          throw Object.assign(new Error('Content-Type must be application/json.'), { statusCode: 415 });
        }
        const total = validateManualEvTotal(await readJsonBody(request));
        const accountNumber = config.octopusAccountNumber || 'manual';
        const point = {
          tags: { account_number: accountNumber },
          fields: {
            charge_kwh: total.energyKwh,
            charge_cost_pence: total.costGbp * 100,
          },
          timestamp: total.timestamp,
        };

        await influx.writePoints([{
          measurement: 'ev_manual_daily',
          ...point,
          fields: { ...point.fields, notes: total.notes },
        }], { precision: 's' });
        await influx.writePoints([{
          measurement: 'ev_charge_daily',
          ...point,
          fields: { ...point.fields, cost_complete: true },
        }], { precision: 's' });
        invalidateMonthlyCostsCache();

        response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          total: {
            date: total.date,
            energyKwh: total.energyKwh,
            costGbp: total.costGbp,
            notes: total.notes,
          },
        }));
      } catch (err) {
        const statusCode = err.statusCode || 500;
        if (statusCode >= 500) console.error('[Dashboard] Manual EV total write failed:', err.message);
        response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: statusCode >= 500 ? 'Could not save manual EV total.' : err.message }));
      }
      return;
    }

    if (request.method === 'GET' && request.url === '/api/monthly-costs') {
      try {
        const monthlyCosts = await getCachedMonthlyCosts();
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(monthlyCosts));
      } catch (err) {
        console.error('[Dashboard] Monthly cost query failed:', err.message);
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Could not load monthly costs.' }));
      }
      return;
    }

    if (request.method === 'GET' && (request.url === '/' || request.url === '/monthly-costs.html')) {
      try {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(fs.readFileSync(dashboardFile));
      } catch (err) {
        console.error('[Dashboard] Could not serve monthly-costs.html:', err.message);
        response.writeHead(500);
        response.end('Dashboard unavailable.');
      }
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  server.listen(config.dashboardPort, '0.0.0.0', () => {
    console.log(`Monthly costs dashboard listening on port ${config.dashboardPort}`);
  });
  return { warmMonthlyCostsCache, invalidateMonthlyCostsCache };
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

async function getActiveElectricityTariff(apiKey, accountNumber) {
  if (!accountNumber) return null;

  const accountResponse = await axios.get(
    `https://api.octopus.energy/v1/accounts/${accountNumber}/`,
    { auth: { username: apiKey, password: '' }, timeout: 30000 }
  );
  const meter = (accountResponse.data.properties || [])
    .flatMap((property) => property.electricity_meter_points || [])
    .find((point) => point.mpan === ELECTRICITY.mpan);
  const now = Date.now();
  const agreement = meter?.agreements?.find((item) =>
    new Date(item.valid_from).getTime() <= now &&
    (!item.valid_to || new Date(item.valid_to).getTime() > now)
  );

  if (!agreement) throw new Error('No active electricity tariff found for the configured MPAN.');

  const match = agreement.tariff_code.match(/^E-\dR-(.+)-([A-P])$/);
  if (!match) throw new Error(`Could not resolve product code for tariff ${agreement.tariff_code}.`);

  const [, productCode, region] = match;
  const productResponse = await axios.get(
    `https://api.octopus.energy/v1/products/${productCode}/`,
    { timeout: 30000 }
  );
  const product = productResponse.data;
  const fourRateTariff = product.four_rate_ev_electricity_tariffs?.[`_${region}`]?.direct_debit_monthly;

  return {
    tariffCode: agreement.tariff_code,
    productCode,
    validFrom: new Date(agreement.valid_from),
    fourRateTariff: fourRateTariff || null,
  };
}

function londonMinuteOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function rateForTime(rates, timestamp) {
  return rates
    .filter((rate) => new Date(rate.valid_from).getTime() <= timestamp &&
      (!rate.valid_to || new Date(rate.valid_to).getTime() > timestamp))
    .sort((left, right) => new Date(right.valid_from) - new Date(left.valid_from))[0];
}

async function syncFourRateEvTariff(apiKey, influx, tariff, to) {
  const baseUrl = `https://api.octopus.energy/v1/products/${tariff.productCode}/electricity-tariffs/${tariff.tariffCode}/`;
  const from = tariff.validFrom;
  const params = { period_from: from.toISOString(), period_to: to.toISOString() };
  const [dayRates, nightRates] = await Promise.all([
    fetchAllPages(apiKey, `${baseUrl}day-unit-rates/`, params),
    fetchAllPages(apiKey, `${baseUrl}night-unit-rates/`, params),
  ]);
  if (dayRates.length === 0 || nightRates.length === 0) {
    throw new Error(`No day/night rates returned for tariff ${tariff.tariffCode}.`);
  }

  const halfHourMs = 30 * 60 * 1000;
  const firstSlot = Math.floor(from.getTime() / halfHourMs) * halfHourMs;
  const points = [];
  for (let timestamp = firstSlot; timestamp < to.getTime(); timestamp += halfHourMs) {
    const date = new Date(timestamp);
    const minute = londonMinuteOfDay(date);
    const isNightRate = minute >= 23 * 60 + 30 || minute < 5 * 60 + 30;
    const rate = rateForTime(isNightRate ? nightRates : dayRates, timestamp);
    if (!rate) continue;

    points.push({
      measurement: 'electricity_tariff',
      tags: { tariff_code: tariff.tariffCode },
      fields: {
        unit_rate_pence: Number(rate.value_inc_vat),
        unit_rate_ex_vat_pence: Number(rate.value_exc_vat),
      },
      timestamp: date,
    });
  }

  if (points.length === 0) throw new Error(`No half-hourly rates could be built for ${tariff.tariffCode}.`);
  await influx.writePoints(points, { precision: 's' });
  console.log(`[Electricity Tariff] Wrote ${points.length} half-hourly IOG day/night rates for ${tariff.tariffCode}.`);
  return points.length;
}

/** Syncs the account's active tariff, with the original Agile rates as fallback. */
async function syncElectricityTariffRates(apiKey, accountNumber, influx, from, to) {
  const tariff = await getActiveElectricityTariff(apiKey, accountNumber);
  if (tariff?.fourRateTariff) {
    console.log(`[Electricity Tariff] Active IOG tariff ${tariff.tariffCode} from ${tariff.validFrom.toISOString()}`);
    return syncFourRateEvTariff(apiKey, influx, tariff, to);
  }

  const url = tariff
    ? `https://api.octopus.energy/v1/products/${tariff.productCode}/electricity-tariffs/${tariff.tariffCode}/standard-unit-rates/`
    : ELECTRICITY.agileRatesUrl;
  const tariffTag = tariff?.tariffCode || 'AGILE-24-10-01';
  console.log(`[Electricity Tariff] Fetching ${tariffTag}: ${from.toISOString()} → ${to.toISOString()}`);

  const rates = await fetchAllPages(apiKey, url, {
    period_from: from.toISOString(),
    period_to: to.toISOString(),
  });
  if (rates.length === 0) {
    console.log('[Electricity Tariff] No new rates returned.');
    return 0;
  }

  const points = rates.map((rate) => ({
    measurement: 'electricity_tariff',
    tags: { tariff_code: tariffTag },
    fields: {
      unit_rate_pence: parseFloat(rate.value_inc_vat),
      unit_rate_ex_vat_pence: parseFloat(rate.value_exc_vat),
    },
    timestamp: new Date(rate.valid_from),
  }));

  await influx.writePoints(points, { precision: 's' });
  console.log(`[Electricity Tariff] Written ${points.length} rate slots.`);
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
  const from = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const today = londonDateKey(now);
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(today, index - 6));
  const totals = new Map(days.map((day) => [day, {
    chargeKwh: 0,
    chargeCostPence: 0,
    costComplete: true,
  }]));

  console.log(`${label} Refreshing EV sessions since ${from.toISOString()}`);

  const tariff = await getActiveElectricityTariff(apiKey, accountNumber);
  const evRatesUrl = tariff?.fourRateTariff
    ? `https://api.octopus.energy/v1/products/${tariff.productCode}/electricity-tariffs/${tariff.tariffCode}/ev-device-off-peak-unit-rates/`
    : tariff
      ? `https://api.octopus.energy/v1/products/${tariff.productCode}/electricity-tariffs/${tariff.tariffCode}/standard-unit-rates/`
      : ELECTRICITY.agileRatesUrl;
  const ratesFrom = tariff?.validFrom || from;
  const [sessions, rates, manualRows] = await Promise.all([
    fetchSmartFlexChargingSessions(apiKey, accountNumber, from, now),
    fetchAllPages(apiKey, evRatesUrl, {
      period_from: ratesFrom.toISOString(),
      period_to: now.toISOString(),
    }),
    queryMeasurement(influx, 'ev_manual_daily', ['charge_kwh', 'charge_cost_pence'], from.toISOString()),
  ]);
  const manualTotals = new Map(manualRows.map((row) => [londonDateKey(new Date(row.time)), {
    chargeKwh: Number(row.charge_kwh),
    chargeCostPence: Number(row.charge_cost_pence),
  }]));

  const charges = sessions.length > 0
    ? sessions.map((session) => ({
      start: session.start,
      end: session.end,
      date: session.end,
      chargeKwh: session.energyAdded?.unit === 'KILOWATT_HOUR'
        ? Number(session.energyAdded.value)
        : NaN,
    }))
    : (await fetchCompletedDispatches(apiKey, accountNumber)).map((dispatch) => ({
      ...dispatch,
      date: dispatch.start,
      chargeKwh: Number(dispatch.delta),
    }));

  for (const charge of charges) {
    const start = new Date(charge.start);
    const end = new Date(charge.end);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const chargeKwh = charge.chargeKwh;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < from.getTime() ||
      endMs > now.getTime() ||
        !Number.isFinite(chargeKwh) || chargeKwh < 0) {
      continue;
    }

    const total = totals.get(londonDateKey(new Date(charge.date)));
    if (!total) continue;

    total.chargeKwh += chargeKwh;
    const costPence = calculateDispatchCostPence({ start, end, delta: chargeKwh }, rates);
    if (costPence === null) {
      total.costComplete = false;
    } else {
      total.chargeCostPence += costPence;
    }
  }

  for (const day of days) {
    const manual = manualTotals.get(day);
    if (!manual || !Number.isFinite(manual.chargeKwh) || !Number.isFinite(manual.chargeCostPence)) continue;
    const total = totals.get(day);
    total.chargeKwh = manual.chargeKwh;
    total.chargeCostPence = manual.chargeCostPence;
    total.costComplete = true;
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
async function runConsumptionSync(apiKey, influx, onSynced) {
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
    onSynced?.();

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
async function runTariffSync(apiKey, accountNumber, influx, onSynced) {
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

    await syncElectricityTariffRates(apiKey, accountNumber, influx, from, endOfTomorrow);
    onSynced?.();

    console.log('✓ Tariff sync complete.\n');
  } catch (err) {
    console.error('✗ Tariff sync failed:', err.message);
    if (err.response) {
      console.error('  HTTP', err.response.status, err.response.data);
    }
  }
}

async function runEvChargeSync(apiKey, accountNumber, influx, onSynced) {
  try {
    await syncEvChargeDaily(apiKey, accountNumber, influx);
    onSynced?.();
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

  const dashboard = startDashboardServer(influx, config);
  const onSynced = () => dashboard.invalidateMonthlyCostsCache();

  const { octopusApiKey, octopusAccountNumber } = config;

  // ── Initial backfill on startup ──────────────────────────────────────────
  await runConsumptionSync(octopusApiKey, influx, onSynced);
  await runTariffSync(octopusApiKey, octopusAccountNumber, influx, onSynced);
  if (octopusAccountNumber) {
    await runEvChargeSync(octopusApiKey, octopusAccountNumber, influx, onSynced);
  }
  await dashboard.warmMonthlyCostsCache();

  // ── 06:00 daily — consumption sync (data ready ~24h after metering) ───────
  cron.schedule('0 6 * * *', () => runConsumptionSync(octopusApiKey, influx, onSynced), {
    timezone: 'Europe/London',
  });
  console.log('⏰ Scheduled: consumption sync at 06:00 Europe/London');

  // ── 16:30 daily — Agile rate sync (tomorrow's prices published ~16:00) ────
  cron.schedule('30 16 * * *', () => runTariffSync(octopusApiKey, octopusAccountNumber, influx, onSynced), {
    timezone: 'Europe/London',
  });
  console.log('⏰ Scheduled: tariff rate sync at 16:30 Europe/London');

  if (octopusAccountNumber) {
    cron.schedule('15 */6 * * *', () => runEvChargeSync(octopusApiKey, octopusAccountNumber, influx, onSynced), {
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