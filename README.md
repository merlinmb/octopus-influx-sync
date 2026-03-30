# octopus-influx-sync

A Node.js service to sync Octopus Energy smart meter data and Agile tariff rates into InfluxDB, designed for running on a Raspberry Pi (Homebridge server).

## Features
- Fetches and stores electricity and gas consumption data from Octopus Energy
- Syncs Agile tariff rates daily
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

## Troubleshooting
- Ensure your `.env` file is present and correct on both your development machine and the Pi.
- Check InfluxDB connectivity and credentials.
- For deployment issues, review the output of the deploy scripts.

## License
MIT
