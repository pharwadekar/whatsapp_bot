require("dotenv").config();
const fs = require('fs');
const path = require('path');

// --- PATCH WHATSAPP-WEB.JS BUGS & MEMORY LEAKS AUTOMATICALLY ---
// whatsapp-web.js crashes with an ENOENT error on RemoteAuth because it tries
// to read a 'Default' folder that doesn't always exist.
// Additionally, unzipper uses too much memory extracting large sessions.
const remoteAuthPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'authStrategies', 'RemoteAuth.js');
if (fs.existsSync(remoteAuthPath)) {
  let content = fs.readFileSync(remoteAuthPath, 'utf8');
  let patched = false;
  
  if (content.includes('const sessionFiles = await fs.promises.readdir(dir);')) {
    content = content.replace(
      'const sessionFiles = await fs.promises.readdir(dir);',
      'const sessionFiles = await fs.promises.readdir(dir).catch(() => []);'
    );
    patched = true;
  }
  
  if (content.includes('concurrency: 10')) {
    content = content.replace('concurrency: 10', 'concurrency: 1');
    patched = true;
  }
  
  if (patched) {
    fs.writeFileSync(remoteAuthPath, content);
    console.log('[DEBUG] Patched RemoteAuth.js for memory and ENOENT stability');
  }
}

const { Client, RemoteAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const OpenAI = require("openai");
const mongoose = require("mongoose");
const { CustomMongoStore } = require("./CustomMongoStore");

let client;
let store;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== WEB SERVER FOR APPROVAL UI =====
const express = require('express');
const app = express();
app.use(express.json());

// SECURITY: Lock down the entire web server with a username and password
app.use((req, res, next) => {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  
  // Checks for the ADMIN_PASSWORD environment variable
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedPassword) {
    console.error("⚠️ SECURITY WARNING: ADMIN_PASSWORD is not set in your .env file!");
    return res.status(500).send("Server configuration error.");
  }

  if (login === 'admin' && password === expectedPassword) {
    return next();
  }

  // If wrong password, show standard browser login popup
  res.set('WWW-Authenticate', 'Basic realm="Secure Area"');
  res.status(401).send('Authentication required.');
});

app.use(express.static('public'));

const PDFDocument = require('pdfkit');

const GROUP_ID = "117991492559076@lid";
const pendingMessages = new Map();
const autoRetryTimers = new Map();
let currentQR = "";
let waClientReady = false;
let initInProgress = false;
const AUTO_RETRY_MAX_ATTEMPTS = 6;
const AUTO_RETRY_BASE_DELAY_MS = 5000;

function isTransientSendError(err) {
  const msg = err?.message || '';
  return (
    msg.includes('Attempted to use detached Frame') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('Protocol error')
  );
}

function isTransientInitError(err) {
  const msg = (err?.message || '') + (err?.code || '');
  return (
    msg.includes('Execution context was destroyed') ||
    msg.includes('Attempted to use detached Frame') ||
    msg.includes('Target closed') ||
    msg.includes('Protocol error') ||
    msg.includes('already running') ||
    msg.includes('ENOENT') ||
    msg.includes('EBUSY') ||
    msg.includes('LOCKED') ||
    msg.includes('EACCES') ||
    msg.includes('file lock')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessageWithRetry(chatId, content, options = {}, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!client || !waClientReady) {
        throw new Error('WhatsApp client is reconnecting.');
      }
      return await client.sendMessage(chatId, content, options);
    } catch (err) {
      lastErr = err;
      const canRetry = isTransientSendError(err) || (err?.message || '').includes('reconnecting');
      if (!canRetry || attempt === maxRetries) {
        throw err;
      }
      console.warn(`[WARN] sendMessage retry ${attempt}/${maxRetries} after transient failure:`, err?.message || err);
      await sleep(1200 * attempt);
    }
  }
  throw lastErr;
}

async function initializeClientWithRetry(source = 'startup', maxAttempts = 6) {
  if (!client) return;
  if (initInProgress) {
    console.log(`[INFO] initializeClientWithRetry skipped (${source}) because init is already in progress.`);
    return;
  }

  initInProgress = true;
  waClientReady = false;
  let lastErr;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[INFO] Initializing WhatsApp client (${source}) attempt ${attempt}/${maxAttempts}...`);
        await client.initialize();
        return;
      } catch (err) {
        lastErr = err;
        const transient = isTransientInitError(err);
        console.error(`[WARN] Client initialize failed (attempt ${attempt}/${maxAttempts}):`, err?.message || err);

        if (!transient || attempt === maxAttempts) {
          throw err;
        }

        // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s
        const delayMs = Math.pow(2, attempt) * 1000;
        console.log(`[INFO] Retrying in ${delayMs}ms...`);
        await sleep(delayMs);
      }
    }
  } finally {
    initInProgress = false;
  }

  throw lastErr;
}

function clearAutoRetryTimer(id) {
  const timer = autoRetryTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    autoRetryTimers.delete(id);
  }
}

function getNextRetryDelayMs(attemptNumber) {
  return Math.min(AUTO_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attemptNumber - 1)), 60000);
}

async function sendPendingItem(pending, textToReply) {
  if (pending.mediaPath) {
    if (!client || !waClientReady) {
      throw new Error('WhatsApp client is reconnecting.');
    }

    if (!fs.existsSync(pending.mediaPath)) {
      throw new Error('PDF file not found on disk. Please regenerate PDF.');
    }

    const fileName = path.basename(pending.mediaPath);
    const pdfBase64 = fs.readFileSync(pending.mediaPath, { encoding: 'base64' });
    const media = new MessageMedia('application/pdf', pdfBase64, fileName);

    const mediaMessage = await sendMessageWithRetry(pending.targetGroupId, media, {
      sendMediaAsDocument: true
    });

    const textMessage = await sendMessageWithRetry(pending.targetGroupId, textToReply);

    console.log('[DEBUG] PDF queued approval sent successfully', {
      targetGroupId: pending.targetGroupId,
      mediaMessageId: mediaMessage?.id?._serialized,
      mediaType: mediaMessage?.type,
      mediaHasMedia: mediaMessage?.hasMedia,
      textMessageId: textMessage?.id?._serialized,
      textBody: textMessage?.body
    });

    setTimeout(() => {
      if (fs.existsSync(pending.mediaPath)) {
        fs.unlink(pending.mediaPath, () => {});
      }
    }, 15000);
    return;
  }

  await pending.msg.reply(textToReply);
}

async function processApprovedSend(id) {
  const pending = pendingMessages.get(id);
  if (!pending) return { ok: false, code: 404, error: 'Not found' };

  if ((pending.kind === 'pdf' || pending.mediaPath) && !pending.mediaPath) {
    pending.status = 'failed';
    pending.lastError = 'PDF queue item missing file path. Please regenerate PDF.';
    return { ok: false, code: 500, error: pending.lastError };
  }

  if (pending.status === 'sending') {
    return { ok: false, code: 202, error: 'Send already in progress.' };
  }

  pending.status = 'sending';
  pending.lastError = null;
  pending.nextRetryAt = null;
  pending.sendAttempts = (pending.sendAttempts || 0) + 1;

  try {
    const textToReply = pending.approvedText || pending.replyText;
    await sendPendingItem(pending, textToReply);
    clearAutoRetryTimer(id);
    pendingMessages.delete(id);
    return { ok: true, code: 200 };
  } catch (err) {
    const isTransient = isTransientSendError(err) || (err?.message || '').includes('reconnecting');
    pending.lastError = err?.message || 'Failed to send';

    if (!isTransient) {
      pending.status = 'failed';
      return { ok: false, code: 500, error: pending.lastError };
    }

    if ((pending.sendAttempts || 0) >= (pending.maxAttempts || AUTO_RETRY_MAX_ATTEMPTS)) {
      pending.status = 'failed';
      return { ok: false, code: 500, error: `Auto-retry exhausted: ${pending.lastError}` };
    }

    pending.status = 'retrying';
    const delayMs = getNextRetryDelayMs(pending.sendAttempts || 1);
    pending.nextRetryAt = Date.now() + delayMs;

    clearAutoRetryTimer(id);
    const timer = setTimeout(async () => {
      autoRetryTimers.delete(id);
      const latest = pendingMessages.get(id);
      if (!latest) return;
      if (latest.status === 'retrying' || latest.status === 'sending') {
        await processApprovedSend(id);
      }
    }, delayMs);
    autoRetryTimers.set(id, timer);

    return { ok: false, code: 202, error: `Queued for auto-retry: ${pending.lastError}` };
  }
}

function stripMonthPrefix(topic = "") {
  return topic.replace(/^\[[^\]]+\]\s*/i, '').trim();
}


// Get topics lists
app.get('/api/topics', (req, res) => {
  try {
    const topicsPath = path.join(__dirname, 'topics.json');
    const topics = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
    res.json(topics);
  } catch(e) {
    res.json([]);
  }
});

// Generate PDF for a topic
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const topic = req.body.topic;
    if(!topic) return res.status(400).json({ error: 'No topic provided' });
    const cleanTopic = stripMonthPrefix(topic);

    console.log('[DEBUG] Generating PDF for topic:', cleanTopic);
    
    // 1. Generate text using AI
    const systemPrompt = "You are an advisor for international students at Texas A&M. Write a comprehensive 1-page guide on the given topic. Use sections, bullet points, and be very informative but clear. Do not use markdown (like asterisks for bold) as plain text will be compiled directly to PDF, use plain text structure.";
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Please write a guide about: ${cleanTopic}` }
      ],
      max_tokens: 800,
    });
    
    const guideText = response.choices[0].message.content.trim();
    
    // 2. Generate PDF using PDFKit
    const doc = new PDFDocument({ margin: 50 });
    const outputDir = path.join(__dirname, 'generated-pdfs');
    fs.mkdirSync(outputDir, { recursive: true });
    const fileName = `guide-${Date.now()}.pdf`;
    const filePath = path.join(outputDir, fileName);
    
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);
    
    doc.fontSize(20).text(cleanTopic, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(guideText, { align: 'left', lineGap: 4 });
    doc.end();
    
    // Wait for the file to be written
    await new Promise((resolve) => writeStream.on('finish', resolve));

    // 3. Queue the message
    const id = Date.now().toString();
    pendingMessages.set(id, {
      id,
      kind: 'pdf',
      status: 'pending',
      sendAttempts: 0,
      maxAttempts: AUTO_RETRY_MAX_ATTEMPTS,
      approvedText: null,
      lastError: null,
      nextRetryAt: null,
      msg: null,
      replyText: `Hello everyone! Here is a guide on: ${cleanTopic}`,
      originalText: `Daily PDF Generation: ${cleanTopic}`,
      contextText: '',
      to: 'Main Group',
      mediaPath: filePath,
      targetGroupId: GROUP_ID
    });
    
    res.json({
      success: true,
      message: 'PDF generated and queued for approval!',
      id,
      previewUrl: `/api/pdf-preview/${id}`
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// Get the list of pending messages
app.get('/api/pending', (req, res) => {
  const items = Array.from(pendingMessages.values()).map(p => ({
    id: p.id,
    kind: p.kind || 'text',
    status: p.status || 'pending',
    sendAttempts: p.sendAttempts || 0,
    maxAttempts: p.maxAttempts || AUTO_RETRY_MAX_ATTEMPTS,
    lastError: p.lastError || null,
    nextRetryInSeconds: p.nextRetryAt ? Math.max(0, Math.ceil((p.nextRetryAt - Date.now()) / 1000)) : null,
    originalText: p.originalText,
    replyText: p.replyText,
    to: p.to,
    previewUrl: p.mediaPath ? `/api/pdf-preview/${p.id}` : null
  }));
  res.json(items.reverse()); // newest first
});

// Preview a queued PDF before approving/sending
app.get('/api/pdf-preview/:id', (req, res) => {
  const id = req.params.id;
  const pending = pendingMessages.get(id);

  if (!pending || !pending.mediaPath) {
    return res.status(404).send('Preview not found');
  }

  const resolved = path.resolve(pending.mediaPath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).send('File not found');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(resolved);
});

// Approve a message
app.post('/api/approve/:id', async (req, res) => {
  const id = req.params.id;
  const pending = pendingMessages.get(id);
  
  if (pending) {
    try {
      pending.approvedText = req.body.text || pending.replyText;
      const result = await processApprovedSend(id);

      if (result.ok) {
        return res.json({ success: true, sent: true });
      }

      if (result.code === 202) {
        return res.status(202).json({
          success: true,
          sent: false,
          retrying: true,
          message: result.error
        });
      }

      return res.status(result.code || 500).json({ error: result.error || 'Failed to send' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to send' });
    }
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Reject a message
app.post('/api/reject/:id', (req, res) => {
  const id = req.params.id;
  const pending = pendingMessages.get(id);
  if(pending) {
    clearAutoRetryTimer(id);
    if (pending.mediaPath) {
      fs.unlink(pending.mediaPath, () => {});
    }
    pendingMessages.delete(id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Regenerate a message
app.post('/api/regenerate/:id', async (req, res) => {
  const id = req.params.id;
  const pending = pendingMessages.get(id);
  
  if (pending) {
    try {
      const customPrompt = req.body.prompt;
      // route the new prompt through the same logic as the original context
      const newReply = await generateReply(customPrompt, pending.contextText);
      pending.replyText = newReply;
      res.json({ success: true, replyText: newReply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to regenerate' });
    }
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Chat GPT helper for the UI Side-Panel
app.post('/api/chat', async (req, res) => {
  try {
    const customPrompt = req.body.prompt;
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an assistant helping draft a quick WhatsApp message to other students. The output should be very short, casual but professional, and sound like a natural text message. Do not include quotes around the text." },
        { role: "user", content: customPrompt }
      ]
    });
    res.json({ reply: response.choices[0].message.content });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// QR Code UI for easy scanning
app.get('/qr', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (currentQR) {
    res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="15">
        </head>
        <body style="font-family: sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; background:#f0f0f0;">
          <div style="text-align: center; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
            <h2>📱 Scan to Connect WhatsApp</h2>
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQR)}" alt="QR Code" />
            <p style="color: #666; margin-top: 20px;">Open WhatsApp > Linked Devices > Link a Device</p>
            <p style="color: #999; font-size: 12px; margin-top: 10px;">(This page auto-refreshes every 15s to keep the QR fresh)</p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="3">
        </head>
        <body style="font-family: sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; background:#f0f0f0;">
          <div style="text-align: center;">
            <h2 style='text-align: center; font-family: sans-serif;'>⏳ Bot is connecting or loading...</h2>
            <p style='color: #666; font-family: sans-serif;'>Please wait. This page will auto-refresh automatically until the QR code is ready.</p>
          </div>
        </body>
      </html>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Approval UI available on port ${PORT}, if local on http://localhost:${PORT}`);
});

// ===== PREVENT HF SPACES FROM SLEEPING =====
// HF Spaces free tier sleeps after 48 hours of inactivity.
const url = `https://pranavharwadekar-whatsapp-advisor.hf.space/api/pending`;
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pendingMessages.entries()) {
    if (p.status === 'failed' || p.status === 'sent') {
      pendingMessages.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ===== CONFIG =====

const COOLDOWN_MS = 15000; // 15 sec global cooldown
const USER_COOLDOWN_MS = 20000; // per-user cooldown

let lastReplyTime = 0;
const userLastReply = new Map();

function setupClient() {
// ===== QR =====
client.on("qr", (qr) => {
  currentQR = qr;
  qrcode.generate(qr, { small: true });
  console.log("📱 QR Code generated! Go to /qr on your web UI to scan it easily.");
});

// ===== READY =====
client.on("ready", async () => {
  currentQR = "";
  waClientReady = true;
  console.log("✅ Bot is ready!");

  try {
    const pages = await client.pupBrowser.pages();
    const page = pages[0];

    // Clear browser cache
    const clientCDP = await page.target().createCDPSession();
    await clientCDP.send('Network.clearBrowserCache');
    await clientCDP.send('Network.clearBrowserCookies');

    console.log("🧹 Cleared Chromium cache (reduces session size)");
  } catch (e) {
    console.log("⚠️ Cache clear failed:", e.message);
  }
});

// ===== AUTHENTICATION =====
client.on("authenticated", () => {
  console.log("🔒 Authentication successful! Syncing session payload to Mongo...");
});

// ===== REMOTE AUTH HANDLING =====
client.on("remote_session_saved", () => {
  console.log("☁️ Successfully saved remote session to MongoDB!");
});

client.on("loading_screen", (percent, message) => {
  console.log(`⌛ Loading... ${percent}% - ${message}`);
});

// ===== CONNECTION STATE & DISCONNECT HANDLING =====
client.on("change_state", (state) => {
  console.log("🔄 Connection state changed to:", state);
});

client.on("disconnected", async (reason) => {
  console.log("❌ Bot was disconnected! Reason:", reason);
  currentQR = "";
  waClientReady = false;

  // IMPORTANT: do NOT auto-delete remote auth on normal disconnects.
  // Transient disconnects are common and deleting session forces QR re-link.
  console.log("ℹ️ Keeping MongoDB session data intact on disconnect.");

  console.log("⚠️ Attempting to restart the client in 5 seconds...");
  setTimeout(async () => {
    try {
      await client.destroy();
      await initializeClientWithRetry('disconnected-restart');
    } catch (err) {
      console.error("Error restarting client:", err);
    }
  }, 5000);
});

// ===== AUTH FAILURE (Corrupted Data) =====
client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failure (corrupted login data)!", msg);
  currentQR = "";
  waClientReady = false;

  // Optional manual cleanup only when explicitly requested via env var.
  if (process.env.CLEAR_SESSION_ON_AUTH_FAILURE === 'true' && store) {
    store.delete({ session: 'RemoteAuth-bot-session' }).then(() => {
      console.log("🗑️ Cleared remote auth session from MongoDB due to CLEAR_SESSION_ON_AUTH_FAILURE=true");
    }).catch((err) => {
      console.warn("[WARN] Failed clearing remote auth session:", err?.message || err);
    });
  } else {
    console.log("ℹ️ Session retained. Set CLEAR_SESSION_ON_AUTH_FAILURE=true only if you want to force fresh QR.");
  }
});

// ===== MESSAGE HANDLER =====
client.on("message_create", async (msg) => {
  try {
    console.log(`[DEBUG] Received message from: ${msg.from} | body: "${msg.body}" | fromMe: ${msg.fromMe}`);

    // Never react to the bot's own outgoing messages (prevents self-looping)
    if (msg.fromMe) {
      return;
    }

    // Allow personal chats OR messages sent by you to a personal chat OR specific group
    const isPersonal = msg.from.includes("@c.us") || msg.to.includes("@c.us");
    const isGroup = msg.from === GROUP_ID || msg.to === GROUP_ID;

    if (!isPersonal && !isGroup) {
      console.log(`[DEBUG] Ignoring - not a personal chat or the allowed group`);
      return;
    }

    const text = (msg.body || '').trim();

    // Ignore non-text/media-only events
    if (!text) {
      return;
    }

    // 3. ONLY respond if explicitly triggered OR if it's a question
    // This regex checks for a "?" or common question words even if they forget the "?"
    const isQuestion = text.includes("?") || /^(what|who|where|when|why|how|is|are|can|could|do|does|will|would)\b/i.test(text);
    
    const isCommand =
      text.toLowerCase().includes("pranav") ||
      isQuestion;

    if (!isCommand) return;

    const now = Date.now();

    // 4. Global cooldown (prevents spam)
    if (now - lastReplyTime < COOLDOWN_MS) {
      console.log("⏳ Global cooldown active");
      return;
    }

    // 5. Per-user cooldown
    const user = msg.author || msg.from;
    if (
      userLastReply.has(user) &&
      now - userLastReply.get(user) < USER_COOLDOWN_MS
    ) {
      console.log("⏳ User cooldown active");
      return;
    }

    // 6. Clean input
    let cleaned = text.trim();

    console.log("[DEBUG] Fetching recent messages for context...");
    const chat = await msg.getChat();
    const recentMessages = await chat.fetchMessages({ limit: 10 });

    let contextText = "--- Chat History (Last 10 messages) ---\n";
    for (const m of recentMessages) {
      const sender = m.fromMe ? "Pranav (Me)" : (m.author || m.from);
      contextText += `[${sender}]: ${m.body}\n`;
    }
    contextText += "---------------------------------------\n";

    // 7. Generate response
    const reply = await generateReply(cleaned, contextText);

    // 8. Queue for approval instead of sending directly
    const id = Date.now().toString();
    pendingMessages.set(id, {
      id,
      kind: 'text',
      status: 'pending',
      sendAttempts: 0,
      maxAttempts: AUTO_RETRY_MAX_ATTEMPTS,
      approvedText: null,
      lastError: null,
      nextRetryAt: null,
      msg: msg,
      replyText: reply,
      originalText: msg.body,
      contextText: contextText,
      to: msg.fromMe ? "Myself" : (chat.name || msg.from)
    });
    console.log(`[DEBUG] Message queued for approval (ID: ${id}). Go to UI to approve.`);

    // 9. Update cooldowns
    lastReplyTime = now;
    userLastReply.set(user, now);
  } catch (err) {
    console.error("Error:", err);
  }
});
}

// ===== AI ROUTING & REPLIES =====
async function generateReply(input, contextText) {
  const finalInput = input || "Provide a natural follow-up or comment on the conversation above.";
  
  const classifierSystemPrompt = `You are a classifier that decides how to route a user query.
Return ONLY one of the following labels:
- "assistant" -> if the query is about TAMU billing, student org finance, EasyTransfer, or needs external knowledge/files/web search
- "simple" -> if it is casual conversation or general knowledge`;
  const classifierUserPrompt = `User message:\n"${finalInput}"`;

  const isVerbose = process.env.VERBOSE_LOGGING === 'true';

  if (isVerbose) {
    console.log("\n[DEBUG] === CLASSIFYING MESSAGE ROUTE ===");
    console.log("[System Prompt]:\n" + classifierSystemPrompt);
    console.log("[User Prompt]:\n" + classifierUserPrompt);
  }

  const route = await openai.chat.completions.create({
    model: "gpt-4o-mini", // fast & cheap for routing
    messages: [{
      role: "system",
      content: classifierSystemPrompt
    }, {
      role: "user",
      content: classifierUserPrompt
    }],
    temperature: 0,
  });

  const decision = route.choices[0].message.content.trim().toLowerCase();
  console.log(`[DEBUG] Final decision: ${decision}\n`);

  if (decision.includes("assistant")) {
    return callAssistant(finalInput, contextText);
  } else {
    return callSimpleModel(finalInput, contextText);
  }
}

async function callSimpleModel(input, contextText) {
  console.log("[DEBUG] Routing to -> Simple Model");
  const fullContext = contextText + `\nYour prompt: ${input}`;
  
  const systemPrompt = "You are Pranav replying in a WhatsApp group chat with other students. Keep your response very short, casual, but professional (like a quick text). Do not write long paragraphs or over-explain. Read the provided chat history to understand the context. If the question has already been completely answered by someone else in the history, just acknowledge it briefly or add a small new piece of relevant information instead of repeating the same answer. Give a genuine, direct answer to the prompt. If your name ('Pranav') is mentioned, prioritize responding to that specific point. Avoid overly enthusiastic, cheesy, or typical 'AI' phrases. Keep it natural and concise. IMPORTANT: Do not include names, sender tags, or brackets at the beginning of your response. Just write the message text.";

  const isVerbose = process.env.VERBOSE_LOGGING === 'true';

  if (isVerbose) {
    console.log("\n[DEBUG] === SIMPLE MODEL CALL ===");
    console.log("[System Prompt]:\n" + systemPrompt);
    console.log("[User Prompt/Context]:\n" + fullContext);
    console.log("=================================\n");
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: fullContext,
      },
    ],
    max_tokens: 150,
  });

  let rawReply = response.choices[0].message.content;
  rawReply = rawReply.replace(/^\[.*?\]:\s*/gm, "");
  return rawReply.trim();
}

async function callAssistant(input, contextText) {
  console.log("[DEBUG] Routing to -> Assistant API (Files/Search)");
  if (!process.env.ASSISTANT_ID || process.env.ASSISTANT_ID.includes("your_assistant_id")) {
    return "❌ Error: Assistant ID is missing. Please add it to your .env file.";
  }

  try {
    const thread = await openai.beta.threads.create();
    
    const assistantUserPrompt = `${contextText}\n\nUser prompt: ${input}\n\n(Important Instructions: You are Pranav replying to other students in a WhatsApp chat. Keep your response very short, casual, and professional like a quick text message. No long paragraphs. If the question has already been completely answered by someone else in the history, just acknowledge it briefly or add a small new piece of relevant information instead of repeating the same answer. If your name 'Pranav' is mentioned in the prompt or recent messages, prioritize answering that specific point.)`;
    
    const isVerbose = process.env.VERBOSE_LOGGING === 'true';

    if (isVerbose) {
      console.log("\n[DEBUG] === ASSISTANT API CALL ===");
      console.log("[User Prompt/Context sent to Assistant]:\n" + assistantUserPrompt);
      console.log("==================================\n");
    }

    // Send context + prompt to the assistant thread
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: assistantUserPrompt
    });

    // Create a run and poll until it finishes (handles files and web search automatically!)
    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    if (run.status === 'completed') {
      const messages = await openai.beta.threads.messages.list(run.thread_id);
      // Assistant responses are usually the first item returned
      let rawReply = messages.data[0].content[0].text.value;
      
      // Clean off any markdown source citations the Assistant might add like 【4:1†source】
      rawReply = rawReply.replace(/【.*?】/g, ''); 
      rawReply = rawReply.replace(/^\[.*?\]:\s*/gm, "");
      
      return rawReply.trim();
    } else {
      return `❌ Assistant run failed: ${run.status}`;
    }
  } catch (error) {
    console.error("Assistant Error:", error);
    return "❌ Sorry, I hit an error connecting to my knowledge base.";
  }
}

// ===== DB CONNECTION & START =====
if (!process.env.MONGODB_URI) {
  console.error("❌ MONGODB_URI is strictly required in .env");
  process.exit(1);
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

mongoose.connect(process.env.MONGODB_URI, { 
  family: 4 // Force IPv4 to prevent Docker DNS bugs with MongoDB Atlas
}).then(() => {
  console.log("✅ Connected to MongoDB!");
  store = new CustomMongoStore({ mongoose: mongoose });
  client = new Client({
    authStrategy: new RemoteAuth({        
      clientId: 'bot-session',      
      store: store,
      backupSyncIntervalMs: 1800000 // Only zip/backup every 30 minutes to save memory
    }),
    authTimeoutMs: 120000,
    puppeteer: {
      timeout: 120000, // Increase allowed launch time to 2 minutes
      args: process.platform === 'win32' ? 
      ['--no-sandbox', '--disable-setuid-sandbox'] :
      [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '',
        '',
        '--disable-sync',
        '',
        '--mute-audio',
        '--no-default-browser-check',
        '--disable-features=TranslateUI'
      ], // Heavy compression args for Render
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    }
  });
  
// Pre-create the Default folder to prevent RemoteAuth ENOENT crashes
  const fs = require('fs');
  const path = require('path');
  const sessionPath = path.join(process.cwd(), '.wwebjs_auth', 'session-bot-session', 'Default');
  fs.mkdirSync(sessionPath, { recursive: true });

  setupClient();
  initializeClientWithRetry('initial-startup').catch(err => {
    console.error("❌ Puppeteer Initialization Error:", err);
  });
}).catch(err => {
  console.error("❌ MongoDB connection error:", err);
});
