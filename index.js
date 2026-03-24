require("dotenv").config();
const fs = require('fs');
const path = require('path');

// --- PATCH WHATSAPP-WEB.JS BUGS AUTOMATICALLY ---
// whatsapp-web.js crashes with an ENOENT error on RemoteAuth because it tries
// to read a 'Default' folder that doesn't always exist. This patches the library automatically!
const remoteAuthPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'authStrategies', 'RemoteAuth.js');
if (fs.existsSync(remoteAuthPath)) {
  let content = fs.readFileSync(remoteAuthPath, 'utf8');
  if (content.includes('const sessionFiles = await fs.promises.readdir(dir);')) {
    content = content.replace(
      'const sessionFiles = await fs.promises.readdir(dir);',
      'const sessionFiles = await fs.promises.readdir(dir).catch(() => []);'
    );
    fs.writeFileSync(remoteAuthPath, content);
    console.log('[DEBUG] Patched RemoteAuth.js to prevent ENOENT crash');
  }
}

const { Client, RemoteAuth } = require("whatsapp-web.js");
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

const pendingMessages = new Map();
let currentQR = "";

// Get the list of pending messages
app.get('/api/pending', (req, res) => {
  const items = Array.from(pendingMessages.values()).map(p => ({
    id: p.id,
    originalText: p.originalText,
    replyText: p.replyText,
    to: p.to
  }));
  res.json(items.reverse()); // newest first
});

// Approve a message
app.post('/api/approve/:id', async (req, res) => {
  const id = req.params.id;
  const pending = pendingMessages.get(id);
  
  if (pending) {
    try {
      // Send the approved/edited text
      const textToReply = req.body.text || pending.replyText;
      await pending.msg.reply(textToReply);
      pendingMessages.delete(id);
      res.json({ success: true });
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
  if(pendingMessages.has(id)) {
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

// ===== CONFIG =====
const GROUP_ID = "39626056171557@lid"; // put your group id here
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
client.on("ready", () => {
  currentQR = "";
  console.log("✅ Bot is ready!");
});

// ===== AUTHENTICATION =====
client.on("authenticated", () => {
  console.log("🔒 Authentication successful! Syncing session payload to Mongo...");
});

// ===== REMOTE AUTH HANDLING =====
client.on("remote_session_saved", () => {
  console.log("☁️ Successfully saved remote session to MongoDB!");
});

// ===== CONNECTION STATE & DISCONNECT HANDLING =====
client.on("change_state", (state) => {
  console.log("🔄 Connection state changed to:", state);
});

client.on("disconnected", async (reason) => {
  console.log("❌ Bot was disconnected! Reason:", reason);
  currentQR = "";
  
  // Auto-heal: If you logout from your phone, or if the session corrupts,
  // delete the remote session data in MongoDB!
  if (store) {
    store.delete({ session: 'RemoteAuth' }).then(() => {
      console.log("🗑️ Cleared old/corrupted auth session data from MongoDB.");
    }).catch(() => {});
  }

  console.log("⚠️ Attempting to restart the client in 5 seconds...");
  setTimeout(async () => {
    try {
      await client.destroy();
      client.initialize();
    } catch (err) {
      console.error("Error restarting client:", err);
    }
  }, 5000);
});

// ===== AUTH FAILURE (Corrupted Data) =====
client.on("auth_failure", (msg) => {
  console.error("❌ Authentication failure (corrupted login data)!", msg);
  currentQR = "";
  if (store) {
    store.delete({ session: 'RemoteAuth' }).then(() => {
      console.log("🗑️ Cleared corrupted auth session data from MongoDB. Restarting will generate a new QR.");
    }).catch(() => {});
  }
});

// ===== MESSAGE HANDLER =====
client.on("message_create", async (msg) => {
  try {
    console.log(`[DEBUG] Received message from: ${msg.from} | body: "${msg.body}" | fromMe: ${msg.fromMe}`);

    // Allow personal chats OR messages sent by you to a personal chat OR specific group
    const isPersonal = msg.from.includes("@c.us") || msg.to.includes("@c.us");
    const isGroup = msg.from === GROUP_ID || msg.to === GROUP_ID;

    if (!isPersonal && !isGroup) {
      console.log(`[DEBUG] Ignoring - not a personal chat or the allowed group`);
      return;
    }

    const text = msg.body.trim();

    // 3. ONLY respond if explicitly triggered
    const isCommand =
      text.startsWith("/reply") ||
      text.toLowerCase().includes("@bot") ||
      text.toLowerCase().includes("pranav");

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

    // 6. Clean input (remove trigger words except "pranav")
    let cleaned = text
      .replace("/reply", "")
      .replace(/@bot/gi, "")
      .trim();

    console.log("[DEBUG] Fetching recent messages for context...");
    const chat = await msg.getChat();
    const recentMessages = await chat.fetchMessages({ limit: 10 });

    let contextText = "--- Chat History (Last 10 messages) ---\n";
    for (const m of recentMessages) {
      const sender = m.fromMe ? "Pranav (Me)" : (m.author || m.from);
      if (m.body.includes("@bot") || m.body.includes("/reply")) continue;
      contextText += `[${sender}]: ${m.body}\n`;
    }
    contextText += "---------------------------------------\n";

    // 7. Generate response
    const reply = await generateReply(cleaned, contextText);

    // 8. Queue for approval instead of sending directly
    const id = Date.now().toString();
    pendingMessages.set(id, {
      id,
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

  console.log("\n[DEBUG] === CLASSIFYING MESSAGE ROUTE ===");
  console.log("[System Prompt]:\n" + classifierSystemPrompt);
  console.log("[User Prompt]:\n" + classifierUserPrompt);

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

  console.log("\n[DEBUG] === SIMPLE MODEL CALL ===");
  console.log("[System Prompt]:\n" + systemPrompt);
  console.log("[User Prompt/Context]:\n" + fullContext);
  console.log("=================================\n");

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
    
    console.log("\n[DEBUG] === ASSISTANT API CALL ===");
    console.log("[User Prompt/Context sent to Assistant]:\n" + assistantUserPrompt);
    console.log("==================================\n");

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
      backupSyncIntervalMs: 300000
    }),
    puppeteer: {
      args: process.platform === 'win32' ? 
        ['--no-sandbox', '--disable-setuid-sandbox'] : // Lean args for Windows local testing
        [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage', 
          '--disable-accelerated-2d-canvas', 
          '--no-first-run', 
          '--no-zygote', 
          '--single-process', 
          '--disable-gpu',
          '--memory-pressure-off' 
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
  client.initialize().catch(err => {
    console.error("❌ Puppeteer Initialization Error:", err);
  });
}).catch(err => {
  console.error("❌ MongoDB connection error:", err);
});