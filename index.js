import express from 'express';
import axios from 'axios';
import cors from 'cors';
import https from 'https';
import schedule from 'node-schedule';
import fs from 'fs';
import path from 'path';
import tough from 'tough-cookie';

// Fixed import for http-cookie-agent
import { HttpCookieAgent, HttpsCookieAgent } from 'http-cookie-agent/http';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Create data directory if it doesn't exist
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Path to store the cookies
const COOKIES_PATH = path.join(DATA_DIR, 'nse_cookies.json');

// Cookie jar for storing cookies
const cookieJar = new tough.CookieJar();

// Create axios instance that doesn't follow redirects by default
const axiosInstance = axios.create({
  timeout: 30000,
  maxRedirects: 0, // Don't follow redirects automatically
  validateStatus: status => status >= 200 && status < 500, // Accept any status code except server errors
  httpsAgent: new HttpsCookieAgent({
    cookies: { jar: cookieJar },
    rejectUnauthorized: false
  }),
  httpAgent: new HttpCookieAgent({
    cookies: { jar: cookieJar }
  })
});

// Store the data in memory
let stockData = {
  NIFTY: null,
  TCS: null,
  RELIANCE: null,
  BAJFINANCE: null
};

// History data array for each stock
let stockHistoryData = {
  NIFTY: [],
  TCS: [],
  RELIANCE: [],
  BAJFINANCE: []
};

// Track last timestamps to avoid duplicate data
let lastTimestamps = {
  NIFTY: null,
  TCS: null,
  RELIANCE: null,
  BAJFINANCE: null
};

// Session management
let sessionExpiry = null;
let currentUserAgent = null;

// Define browser-like user agents to rotate
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0'
];

// Function to get a random user agent
function getRandomUserAgent() {
  const randomIndex = Math.floor(Math.random() * userAgents.length);
  return userAgents[randomIndex];
}

// Helper function to wait
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Save cookies to file
async function saveCookies() {
  try {
    const serializedCookies = cookieJar.serializeSync();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(serializedCookies));
    console.log('Cookies saved to file');
  } catch (error) {
    console.error('Error saving cookies:', error.message);
  }
}

// Load cookies from file
async function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookiesString = fs.readFileSync(COOKIES_PATH, 'utf8');
      const serializedCookies = JSON.parse(cookiesString);
      cookieJar._jar = tough.CookieJar.deserializeSync(serializedCookies)._jar;
      console.log('Cookies loaded from file');
      return true;
    }
  } catch (error) {
    console.error('Error loading cookies:', error.message);
  }
  return false;
}

// Get common headers for all requests
function getCommonHeaders() {
  return {
    'User-Agent': currentUserAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Pragma': 'no-cache'
  };
}

// The main function to establish a valid NSE session
async function establishNSESession() {
  console.log('Establishing new NSE session...');
  
  // Use the same user agent throughout this session
  currentUserAgent = getRandomUserAgent();
  
  // Clear any existing cookies to start fresh
  cookieJar._jar = new tough.CookieJar()._jar;

  try {
    // Step 1: Initial request to main page
    console.log('Step 1: Visiting NSE main page...');
    const homeResponse = await axiosInstance.get('https://www.nseindia.com/', {
      headers: {
        ...getCommonHeaders(),
        'Sec-Fetch-User': '?1'
      }
    });
    
    // Check if we got a redirect
    if (homeResponse.status === 302 || homeResponse.status === 301) {
      console.log(`Got redirect to: ${homeResponse.headers.location}`);
      // Follow the redirect manually if needed
      await delay(1000);
      const redirectResponse = await axiosInstance.get(homeResponse.headers.location, {
        headers: getCommonHeaders()
      });
    }
    
    // Delay between requests
    await delay(2000);
    
    // Step 2: Visit the option chain directly
    console.log('Step 2: Visiting option chain page...');
    const optionChainResponse = await axiosInstance.get('https://www.nseindia.com/option-chain', {
      headers: {
        ...getCommonHeaders(),
        'Referer': 'https://www.nseindia.com/'
      }
    });
    
    // Delay between requests
    await delay(2000);
    
    // Step 3: Make a small API request to validate session
    console.log('Step 3: Testing session with API request...');
    try {
      const testResponse = await axiosInstance.get('https://www.nseindia.com/api/marketStatus', {
        headers: {
          'User-Agent': currentUserAgent,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Referer': 'https://www.nseindia.com/option-chain',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        }
      });
      
      if (testResponse.status === 200) {
        console.log('Session validation successful');
        
        // Save cookies for future use
        await saveCookies();
        
        // Set session expiry
        sessionExpiry = Date.now() + 8 * 60 * 1000; // 8 minutes
        
        return true;
      } else {
        console.log(`Session test returned status ${testResponse.status}`);
        return false;
      }
    } catch (testError) {
      console.error('Session validation failed:', testError.message);
      return false;
    }
    
  } catch (error) {
    console.error('Error establishing NSE session:', error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}, ${error.response.statusText}`);
    }
    return false;
  }
}

// Function to ensure we have valid session
async function ensureValidSession() {
  if (!sessionExpiry || Date.now() >= sessionExpiry) {
    console.log('Session expired or not established, creating new session...');
    return await establishNSESession();
  }
  return true;
}

// Function to fetch data from NSE API with retry logic
async function fetchDataFromNSE(symbol) {
  // Determine the correct endpoint for the symbol
  const getEndpoint = (sym) => {
    if (sym === 'NIFTY') {
      return `https://www.nseindia.com/api/option-chain-indices?symbol=${sym}`;
    } else {
      return `https://www.nseindia.com/api/option-chain-equities?symbol=${sym}`;
    }
  };

  const endpoint = getEndpoint(symbol);
  console.log(`Fetching data for ${symbol} from ${endpoint}`);
  
  const MAX_RETRIES = 3;
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      // Ensure we have a valid session
      const sessionValid = await ensureValidSession();
      if (!sessionValid) {
        throw new Error('Failed to establish valid NSE session');
      }
      
      // Make the request with proper headers
      const response = await axiosInstance.get(endpoint, {
        headers: {
          'User-Agent': currentUserAgent,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://www.nseindia.com/option-chain',
          'Origin': 'https://www.nseindia.com',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        withCredentials: true
      });
      
      // Check if response is valid
      if (response.status !== 200 || !response.data) {
        throw new Error(`Invalid response: Status ${response.status}`);
      }
      
      // Success! Save response data for debugging
      // fs.writeFileSync(path.join(DATA_DIR, `${symbol}_raw_data.json`), JSON.stringify(response.data, null, 2));
      
      // Return the data
      return response.data;
      
    } catch (error) {
      console.error(`Error fetching ${symbol} data (attempt ${retries + 1}):`, error.message);
      if (error.response) {
        console.error(`Status: ${error.response.status}, ${error.response.statusText}`);
      }
      
      retries++;
      
      if (retries < MAX_RETRIES) {
        console.log(`Retry attempt ${retries} for ${symbol}, establishing new session...`);
        // Force a new session on error
        sessionExpiry = null;
        await establishNSESession();
        
        // Add delay before retry
        await delay(2000 * retries);
      } else {
        console.error(`Max retries reached for ${symbol}`);
        return null;
      }
    }
  }
  
  return null;
}

// Function to process the stock data
function processStockData(data, symbol) {
  if (!data || !data.records) {
    console.error(`Invalid data format received for ${symbol}`);
    return null;
  }

  const { timestamp, underlyingValue } = data.records;
  
  if (!timestamp) {
    console.error(`No timestamp in data for ${symbol}`);
    return null;
  }
  
  // Parse strike data
  let strikeData = data.filtered?.data || [];
  
  // Get 10 strike prices below and 10 above the underlying value
  let below = strikeData
    .filter(d => d.strikePrice <= underlyingValue)
    .sort((a, b) => b.strikePrice - a.strikePrice)
    .slice(0, 10);
    
  let above = strikeData
    .filter(d => d.strikePrice > underlyingValue)
    .sort((a, b) => a.strikePrice - b.strikePrice)
    .slice(0, 10);
    
  let finalData = [...below, ...above];

  // Calculate maximum OI and COI values
  let maxPEOI = { strikePrice: null, value: 0 };
  let maxPECOI = { strikePrice: null, value: 0 };
  let maxCEOI = { strikePrice: null, value: 0 };
  let maxCECOI = { strikePrice: null, value: 0 };

  for (let item of finalData) {
    if (item.PE) {
      if (item.PE.openInterest > maxPEOI.value) {
        maxPEOI = { strikePrice: item.strikePrice, value: item.PE.openInterest };
      }
      if (item.PE.changeinOpenInterest > maxPECOI.value) {
        maxPECOI = { strikePrice: item.strikePrice, value: item.PE.changeinOpenInterest };
      }
    }
    if (item.CE) {
      if (item.CE.openInterest > maxCEOI.value) {
        maxCEOI = { strikePrice: item.strikePrice, value: item.CE.openInterest };
      }
      if (item.CE.changeinOpenInterest > maxCECOI.value) {
        maxCECOI = { strikePrice: item.strikePrice, value: item.CE.changeinOpenInterest };
      }
    }
  }

  // Create processed data object
  return {
    timestamp,
    underlyingValue,
    maxPEOI: maxPEOI.strikePrice,
    maxPECOI: maxPECOI.strikePrice, 
    maxCEOI: maxCEOI.strikePrice,
    maxCECOI: maxCECOI.strikePrice,
    symbol: symbol,
    totalPEOI: data.filtered?.CE?.totOI || 0,
    totalCEOI: data.filtered?.PE?.totOI || 0,
    pcRatio: data.filtered?.CE?.totOI && data.filtered?.PE?.totOI ? 
      (data.filtered.PE.totOI / data.filtered.CE.totOI).toFixed(2) : 0
  };
}

// Function to update single stock data
async function updateStockData(symbol) {
  console.log(`Updating data for ${symbol}...`);
  
  try {
    const rawData = await fetchDataFromNSE(symbol);
    
    if (!rawData) {
      console.error(`Failed to fetch ${symbol} data`);
      return false;
    }
    
    // Skip if timestamp is the same as last update
    if (rawData.records && lastTimestamps[symbol] === rawData.records.timestamp) {
      console.log(`Duplicate data detected for ${symbol}. Skipping...`);
      return false;
    }
    
    // Process the data
    const processedData = processStockData(rawData, symbol);
    
    if (processedData) {
      // Update current data
      stockData[symbol] = processedData;
      
      // Add to history (keep last 100 entries)
      stockHistoryData[symbol].push(processedData);
      if (stockHistoryData[symbol].length > 100) {
        stockHistoryData[symbol].shift();
      }
      
      // Update timestamp
      lastTimestamps[symbol] = processedData.timestamp;
      
      // Save processed data
      // fs.writeFileSync(path.join(DATA_DIR, `${symbol}_processed_data.json`), JSON.stringify(processedData, null, 2));
      
      console.log(`Updated ${symbol} data successfully`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`Error updating ${symbol} data:`, error.message);
    return false;
  }
}

// Function to update all stock data
async function updateAllStockData() {
  console.log("Updating all stock data...");
  
  // Define stock symbols
  const stocks = ['NIFTY', 'TCS', 'RELIANCE', 'BAJFINANCE'];
  
  // First ensure we have a valid session
  await ensureValidSession();
  
  // Add delay after establishing session
  await delay(2000);
  
  // Process each stock sequentially
  for (const stock of stocks) {
    await updateStockData(stock);
    // Add delay between stock updates
    await delay(3000);
  }
  
  console.log("All stock data update completed");
}

// Interval updates reference
let updateInterval = null;
let sessionRefreshInterval = null;

// Start interval updates
function startIntervalUpdates() {
  if (!updateInterval) {
    console.log('Starting interval updates every 3 minutes');
    updateInterval = setInterval(updateAllStockData, 3 * 60 * 1000);
  }
  
  if (!sessionRefreshInterval) {
    console.log('Starting session refresh every 7 minutes');
    sessionRefreshInterval = setInterval(establishNSESession, 7 * 60 * 1000);
  }
}

// Stop interval updates
function stopIntervalUpdates() {
  if (updateInterval) {
    console.log('Stopping interval updates');
    clearInterval(updateInterval);
    updateInterval = null;
  }
  
  if (sessionRefreshInterval) {
    console.log('Stopping session refresh');
    clearInterval(sessionRefreshInterval);
    sessionRefreshInterval = null;
  }
}

// Clear all stock data
function clearAllStockData() {
  console.log("Clearing all stock data...");
  
  // Clear current data
  Object.keys(stockData).forEach(symbol => {
    stockData[symbol] = null;
  });
  
  // Clear history data
  Object.keys(stockHistoryData).forEach(symbol => {
    stockHistoryData[symbol] = [];
  });
  
  // Clear timestamps
  Object.keys(lastTimestamps).forEach(symbol => {
    lastTimestamps[symbol] = null;
  });
  
  console.log("All stock data cleared");
}

// Function to start the trading day data collection
async function startTradingDay() {
  console.log("Starting trading day data collection...");
  
  // Clear all existing data
  clearAllStockData();
  
  // Establish a fresh session
  await establishNSESession();
  
  // Initial data update
  await updateAllStockData();
  
  // Start interval updates
  startIntervalUpdates();
  
  console.log("Trading day data collection started");
}

// Function to end the trading day data collection
function endTradingDay() {
  console.log("Ending trading day data collection...");
  
  // Stop interval updates
  stopIntervalUpdates();
  
  console.log("Trading day data collection ended");
}

// Schedule trading day start at 9:15:30 AM every day
const morningSchedule = schedule.scheduleJob('30 15 9 * * 1-5', async function() {
  console.log("Morning schedule triggered at 9:15:30 AM");
  await startTradingDay();
});

// Schedule trading day end at 3:35:00 PM every day
const eveningSchedule = schedule.scheduleJob('0 35 15 * * 1-5', function() {
  console.log("Evening schedule triggered at 3:35:00 PM");
  endTradingDay();
});

// API endpoints
app.get('/api/nifty', (req, res) => {
  if (!stockData.NIFTY) {
    return res.status(404).json({ error: "NIFTY data not available yet" });
  }
  res.json(stockData.NIFTY);
});

app.get('/api/tcs', (req, res) => {
  if (!stockData.TCS) {
    return res.status(404).json({ error: "TCS data not available yet" });
  }
  res.json(stockData.TCS);
});

app.get('/api/reliance', (req, res) => {
  if (!stockData.RELIANCE) {
    return res.status(404).json({ error: "RELIANCE data not available yet" });
  }
  res.json(stockData.RELIANCE);
});

app.get('/api/bajfinance', (req, res) => {
  if (!stockData.BAJFINANCE) {
    return res.status(404).json({ error: "BAJFINANCE data not available yet" });
  }
  res.json(stockData.BAJFINANCE);
});

// Get historical data for a specific stock
app.get('/api/history/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  if (!stockHistoryData[symbol]) {
    return res.status(404).json({ error: `${symbol} history not available` });
  }
  
  res.json(stockHistoryData[symbol]);
});

// Get all current data at once
app.get('/api/all', (req, res) => {
  res.json(stockData);
});

// Force update endpoint
app.post('/api/update', async (req, res) => {
  try {
    await updateAllStockData();
    res.json({ success: true, message: "Manual update completed" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Force session refresh endpoint
app.post('/api/refresh-session', async (req, res) => {
  try {
    const result = await establishNSESession();
    res.json({ success: result, message: result ? "Session refreshed" : "Failed to refresh session" });
  }
  catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual start trading day endpoint
app.get('/api/start-trading', async (req, res) => {
  try {
    await startTradingDay();
    res.json({ success: true, message: "Trading day started manually" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual end trading day endpoint
app.get('/api/end-trading', (req, res) => {
  try {
    endTradingDay();
    res.json({ success: true, message: "Trading day ended manually" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    sessionValid: sessionExpiry !== null && Date.now() < sessionExpiry,
    sessionExpiry: sessionExpiry ? new Date(sessionExpiry).toISOString() : null,
    updatesRunning: updateInterval !== null,
    sessionRefreshRunning: sessionRefreshInterval !== null,
    schedulesActive: {
      morningSchedule: morningSchedule !== null,
      eveningSchedule: eveningSchedule !== null
    },
    dataStatus: {
      NIFTY: stockData.NIFTY ? 'available' : 'unavailable',
      TCS: stockData.TCS ? 'available' : 'unavailable',
      RELIANCE: stockData.RELIANCE ? 'available' : 'unavailable',
      BAJFINANCE: stockData.BAJFINANCE ? 'available' : 'unavailable'
    },
    lastUpdated: {
      NIFTY: lastTimestamps.NIFTY,
      TCS: lastTimestamps.TCS,
      RELIANCE: lastTimestamps.RELIANCE,
      BAJFINANCE: lastTimestamps.BAJFINANCE
    }
  });
});

// Basic landing page
app.get('/', (req, res) => {
  res.json({
    message: "NSE Stock Data API",
    endpoints: {
      individual: "/api/[nifty|tcs|reliance|bajfinance]",
      history: "/api/history/[SYMBOL]",
      all: "/api/all",
      health: "/health",
      // update: "/api/update (POST)",
      // refreshSession: "/api/refresh-session (POST)",
      // startTrading: "/api/start-trading (POST)",
      // endTrading: "/api/end-trading (POST)"
    },
    schedules: {
      tradingStart: "9:15:30 AM (Monday-Friday)",
      tradingEnd: "3:35:00 PM (Monday-Friday)"
    }
  });
});

// Create a dummy mock data endpoint for testing
// app.get('/mock/option-chain', (req, res) => {
//   const symbol = req.query.symbol || 'NIFTY';
  
//   // Create mock data structure similar to NSE response
//   const mockData = {
//     records: {
//       timestamp: new Date().toISOString(),
//       underlyingValue: symbol === 'NIFTY' ? 22580.35 : 
//                       symbol === 'TCS' ? 3540.65 : 
//                       symbol === 'RELIANCE' ? 2890.75 : 1750.40,
//       expiryDates: ["16-May-2025", "30-May-2025", "27-Jun-2025"],
//       data: []
//     },
//     filtered: {
//       data: [],
//       CE: { totOI: 14500000, totVol: 875000 },
//       PE: { totOI: 21750000, totVol: 1125000 }
//     }
//   };
  
//   // Generate mock strike prices
//   const baseStrike = mockData.records.underlyingValue;
//   for(let i = -10; i <= 10; i++) {
//     const strikePrice = Math.round(baseStrike + (i * (baseStrike * 0.01))) / 5 * 5;
    
//     mockData.filtered.data.push({
//       strikePrice: strikePrice,
//       CE: {
//         strikePrice: strikePrice,
//         openInterest: Math.floor(Math.random() * 300000) + 100000,
//         changeinOpenInterest: Math.floor(Math.random() * 50000) - 25000
//       },
//       PE: {
//         strikePrice: strikePrice,
//         openInterest: Math.floor(Math.random() * 300000) + 100000,
//         changeinOpenInterest: Math.floor(Math.random() * 50000) - 25000
//       }
//     });
//   }
  
//   res.json(mockData);
// });

// Start the server and initialize data collection

 // Try to load existing cookies
  await loadCookies();
  
  // Check if current time is within trading hours
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay(); // 0 is Sunday, 1-5 are Monday-Friday
  
  // If it's a weekday and time is between 9:15 AM and 3:35 PM, start data collection
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && 
      ((hour === 9 && minute >= 15) || hour > 9) && 
      ((hour < 15) || (hour === 15 && minute <= 35))) {
    console.log("Current time is within trading hours, starting data collection...");
    await startTradingDay();
  } else {
    console.log("Current time is outside trading hours, no data collection started");
  }

export default app;
