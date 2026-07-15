/**
 * Node Flux TTS Starter - Backend Server
 *
 * Bridges a browser WebSocket to Deepgram's Flux streaming text-to-speech
 * (v2 speak, `wss://api.deepgram.com/v2/speak`) using the official
 * @deepgram/sdk `client.speak.v2` support.
 *
 * Unlike the raw-proxy Flux (STT) starter, the Deepgram side here goes through
 * the SDK, which manages the WebSocket, auth, and — critically — binary-audio
 * framing (the generated socket would otherwise JSON-parse audio frames).
 *
 * Flow:
 *   browser --(JSON control: Speak/Flush/Close)--> backend --(SDK)--> Deepgram
 *   browser <--(binary audio + JSON control)------ backend <--(SDK)-- Deepgram
 *
 * Routes:
 *   GET  /api/session   - Issue JWT session token
 *   GET  /api/metadata  - Project metadata from deepgram.toml
 *   WS   /api/tts       - Streaming TTS bridge to Deepgram Flux (auth required)
 */

const { WebSocketServer } = require('ws');
const express = require('express');
const { createServer } = require('http');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const toml = require('toml');
const { DeepgramClient } = require('@deepgram/sdk');

// Validate required environment variables
if (!process.env.DEEPGRAM_API_KEY) {
  console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
  console.error('Please copy sample.env to .env and add your API key');
  process.exit(1);
}

// Configuration
const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  // Default Flux TTS voice. Flux models follow `flux-{voice}-{language}`.
  defaultModel: process.env.DEEPGRAM_TTS_MODEL || 'flux-alexis-en',
  defaultEncoding: 'linear16',
  defaultSampleRate: '24000',
  port: process.env.PORT || 8081,
  host: process.env.HOST || '0.0.0.0',
};

// A single SDK client is reused across connections; auth is resolved from the
// API key here, so the browser never sees it.
//
// DEEPGRAM_BASE_URL (e.g. a staging host like wss://api.staging.deepgram.com)
// overrides the default production endpoint. speak.v2 uses `environment.production`
// for the /v2/speak websocket, so we set that plus the REST `base`.
const baseUrl = process.env.DEEPGRAM_BASE_URL;
const deepgram = new DeepgramClient({
  apiKey: CONFIG.deepgramApiKey,
  ...(baseUrl
    ? {
        environment: {
          base: baseUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://"),
          production: baseUrl,
          agent: baseUrl,
        },
      }
    : {}),
});
if (baseUrl) {
  console.log(`Using custom Deepgram base URL: ${baseUrl}`);
}

// ============================================================================
// SESSION AUTH - JWT tokens for production security
// ============================================================================

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const JWT_EXPIRY = '1h';

/**
 * Validates JWT from WebSocket subprotocol: access_token.<jwt>
 * Returns the token string if valid, null if invalid.
 */
function validateWsToken(protocols) {
  if (!protocols) return null;
  const list = Array.isArray(protocols) ? protocols : protocols.split(',').map((s) => s.trim());
  const tokenProto = list.find((p) => p.startsWith('access_token.'));
  if (!tokenProto) return null;
  const token = tokenProto.slice('access_token.'.length);
  try {
    jwt.verify(token, SESSION_SECRET);
    return tokenProto;
  } catch {
    return null;
  }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    // Accept the access_token.* subprotocol so the client sees it echoed back
    for (const proto of protocols) {
      if (proto.startsWith('access_token.')) return proto;
    }
    return false;
  },
});

// Track all active browser connections for graceful shutdown
const activeConnections = new Set();

app.use(cors());

// ============================================================================
// SESSION ROUTES - Auth endpoints (unprotected)
// ============================================================================

/**
 * GET /api/session — Issues a signed JWT for session authentication.
 */
app.get('/api/session', (req, res) => {
  const token = jwt.sign(
    { iat: Math.floor(Date.now() / 1000) },
    SESSION_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  res.json({ token });
});

/**
 * GET /api/metadata — Project metadata from deepgram.toml (standardization compliance).
 */
app.get('/api/metadata', (req, res) => {
  try {
    const tomlPath = path.join(__dirname, 'deepgram.toml');
    const tomlContent = fs.readFileSync(tomlPath, 'utf-8');
    const config = toml.parse(tomlContent);

    if (!config.meta) {
      return res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Missing [meta] section in deepgram.toml',
      });
    }

    res.json(config.meta);
  } catch (error) {
    console.error('Error reading metadata:', error);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to read metadata from deepgram.toml',
    });
  }
});

/**
 * Forward a single Deepgram message to the browser.
 * Binary audio frames go out as binary; parsed control objects as JSON text.
 */
async function forwardToBrowser(clientWs, data) {
  const { WebSocket } = require('ws');
  if (clientWs.readyState !== WebSocket.OPEN) return;

  if (data instanceof ArrayBuffer) {
    clientWs.send(Buffer.from(data), { binary: true });
  } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    // The SDK's Node socket delivers binary as a Blob; convert for `ws`.
    clientWs.send(Buffer.from(await data.arrayBuffer()), { binary: true });
  } else if (Buffer.isBuffer(data)) {
    clientWs.send(data, { binary: true });
  } else if (typeof data === 'string') {
    // Raw string (e.g. a control frame that failed JSON parsing) — pass through.
    clientWs.send(data);
  } else {
    // Parsed control message (Connected / SpeechStarted / Flushed / Warning / Error / ...)
    clientWs.send(JSON.stringify(data));
  }
}

/**
 * WebSocket bridge handler — one Deepgram Flux TTS connection per browser client.
 */
wss.on('connection', async (clientWs, request) => {
  const { WebSocket } = require('ws');
  console.log('Client connected to /api/tts');
  activeConnections.add(clientWs);

  const url = new URL(request.url, `http://${request.headers.host}`);
  const model = url.searchParams.get('model') || CONFIG.defaultModel;
  const encoding = url.searchParams.get('encoding') || CONFIG.defaultEncoding;
  const sample_rate = url.searchParams.get('sample_rate') || CONFIG.defaultSampleRate;

  console.log(`Connecting to Deepgram Flux TTS: model=${model}, encoding=${encoding}, sample_rate=${sample_rate}`);

  // Buffer any browser messages that arrive before the Deepgram socket is open.
  let dgReady = false;
  const pending = [];

  let dgSocket;
  try {
    dgSocket = await deepgram.speak.v2.createConnection({ model, encoding, sample_rate });
  } catch (error) {
    console.error('Failed to create Deepgram connection:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, 'Failed to reach Deepgram');
    }
    activeConnections.delete(clientWs);
    return;
  }

  function dispatchToDeepgram(msg) {
    try {
      switch (msg.type) {
        case 'Speak':
          dgSocket.sendSpeak({ type: 'Speak', text: msg.text });
          break;
        case 'Flush':
          dgSocket.sendFlush({ type: 'Flush' });
          break;
        case 'Close':
          dgSocket.sendClose({ type: 'Close' });
          break;
        default:
          console.warn('Ignoring unknown client message type:', msg.type);
      }
    } catch (error) {
      console.error('Failed to forward message to Deepgram:', error.message);
    }
  }

  // Deepgram -> browser
  dgSocket.on('message', (data) => {
    forwardToBrowser(clientWs, data).catch((err) =>
      console.error('Failed to forward Deepgram message:', err)
    );
  });

  dgSocket.on('error', (error) => {
    console.error('Deepgram socket error:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, 'Deepgram connection error');
    }
  });

  dgSocket.on('close', () => {
    console.log('Deepgram connection closed');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1000, 'Deepgram connection closed');
    }
  });

  // browser -> Deepgram (buffered until the Deepgram socket is open)
  clientWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('Ignoring non-JSON message from client');
      return;
    }
    if (!dgReady) {
      pending.push(msg);
      return;
    }
    dispatchToDeepgram(msg);
  });

  clientWs.on('close', () => {
    console.log('Client disconnected');
    try {
      dgSocket.close();
    } catch {
      // already closed
    }
    activeConnections.delete(clientWs);
  });

  clientWs.on('error', (error) => {
    console.error('Client WebSocket error:', error);
    try {
      dgSocket.close();
    } catch {
      // already closed
    }
  });

  // Open the Deepgram connection and flush anything the browser sent early.
  try {
    dgSocket.connect();
    await dgSocket.waitForOpen();
    console.log('✓ Connected to Deepgram Flux TTS');
    dgReady = true;
    for (const msg of pending) dispatchToDeepgram(msg);
    pending.length = 0;
  } catch (error) {
    console.error('Deepgram connection did not open:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, 'Deepgram connection failed to open');
    }
  }
});

/**
 * Handle WebSocket upgrade for /api/tts. Validates the access_token.<jwt> subprotocol.
 */
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  console.log(`WebSocket upgrade request for: ${pathname}`);

  if (pathname === '/api/tts') {
    const protocols = request.headers['sec-websocket-protocol'];
    const validProto = validateWsToken(protocols);
    if (!validProto) {
      console.log('WebSocket auth failed: invalid or missing token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }

  console.log(`Unknown WebSocket path: ${pathname}`);
  socket.destroy();
});

/**
 * Graceful shutdown handler
 */
function gracefulShutdown(signal) {
  console.log(`\n${signal} signal received: starting graceful shutdown...`);

  wss.close(() => {
    console.log('WebSocket server closed to new connections');
  });

  console.log(`Closing ${activeConnections.size} active connection(s)...`);
  activeConnections.forEach((ws) => {
    try {
      ws.close(1001, 'Server shutting down');
    } catch (error) {
      console.error('Error closing WebSocket:', error);
    }
  });

  server.close(() => {
    console.log('HTTP server closed');
    console.log('Shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('\n' + '='.repeat(70));
  console.log(`🚀 Backend API Server running at http://localhost:${CONFIG.port}`);
  console.log('');
  console.log(`📡 GET  /api/session`);
  console.log(`📡 WS   /api/tts (auth required)`);
  console.log(`📡 GET  /api/metadata`);
  console.log('='.repeat(70) + '\n');
});
