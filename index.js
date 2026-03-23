require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const OpenAI = require("openai");

const client = new Client({
  authStrategy: new LocalAuth(), // keeps session saved
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== WEB SERVER FOR APPROVAL UI =====
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

const pendingMessages = new Map();

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

app.listen(3000, '0.0.0.0', () => {
  console.log("🌐 Approval UI available on port 3000 (http://localhost:3000)");
});

// ===== CONFIG =====
const GROUP_ID = "39626056171557@lid"; // put your group id here
const COOLDOWN_MS = 15000; // 15 sec global cooldown
const USER_COOLDOWN_MS = 20000; // per-user cooldown

let lastReplyTime = 0;
const userLastReply = new Map();

// ===== QR =====
client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

// ===== READY =====
client.on("ready", () => {
  console.log("✅ Bot is ready!");
});

// ===== CONNECTION STATE & DISCONNECT HANDLING =====
client.on("change_state", (state) => {
  console.log("🔄 Connection state changed to:", state);
});

client.on("disconnected", async (reason) => {
  console.log("❌ Bot was disconnected! Reason:", reason);
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

    // 7. Generate response
    const reply = await generateReply(cleaned, recentMessages);

    // 8. Queue for approval instead of sending directly
    const id = Date.now().toString();
    pendingMessages.set(id, {
      id,
      msg: msg,
      replyText: reply,
      originalText: msg.body,
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

// ===== AI ROUTING & REPLIES =====
async function generateReply(input, recentMessages) {
  let contextText = "--- Chat History (Last 10 messages) ---\n";
  for (const m of recentMessages) {
    const sender = m.fromMe ? "Pranav (Me)" : (m.author || m.from);
    if (m.body.includes("@bot") || m.body.includes("/reply")) continue;
    contextText += `[${sender}]: ${m.body}\n`;
  }
  contextText += "---------------------------------------\n";
  
  const finalInput = input || "Provide a natural follow-up or comment on the conversation above.";
  
  console.log("\n[DEBUG] === CLASSIFYING MESSAGE ROUTE ===");
  const route = await openai.chat.completions.create({
    model: "gpt-4o-mini", // fast & cheap for routing
    messages: [{
      role: "system",
      content: `You are a classifier that decides how to route a user query.
Return ONLY one of the following labels:
- "assistant" -> if the query is about TAMU billing, student org finance, EasyTransfer, or needs external knowledge/files/web search
- "simple" -> if it is casual conversation or general knowledge`
    }, {
      role: "user",
      content: `User message:\n"${finalInput}"`
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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are Pranav replying in a WhatsApp group chat. Read the provided chat history to understand the context and give a genuine, direct answer to the prompt. If your name ('Pranav') is mentioned in the prompt or recent messages, prioritize responding to that specific point over the rest of the general chatter. Your tone should be a balanced mix of professional, lighthearted, and sincere. Avoid overly enthusiastic, cheesy, or typical 'AI' phrases (like using too many emojis, or asking forced follow-up questions). Keep it natural, concise, and conversational. IMPORTANT: Do not include names, sender tags, or brackets at the beginning of your response. Just write the message text.",
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
    
    // Send context + prompt to the assistant thread
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: `${contextText}\n\nUser prompt: ${input}\n\n(Important Instruction: You are Pranav. If your name 'Pranav' is mentioned in the prompt or recent messages, prioritize answering that specific point over responding to the rest of the general chat history.)`
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

// ===== START =====
client.initialize();