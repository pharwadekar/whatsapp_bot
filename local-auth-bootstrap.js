require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

console.log('🚀 Starting LocalAuth bootstrap for bot-session...');
console.log('📱 Scan the QR once to refresh local session, then keep this running until you see "ready".');

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'bot-session',
    dataPath: '.wwebjs_auth'
  }),
  puppeteer: {
    args: process.platform === 'win32'
      ? ['--no-sandbox', '--disable-setuid-sandbox']
      : [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--memory-pressure-off'
        ],
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
  }
});

client.on('qr', (qr) => {
  console.log('\n🔐 Scan this QR with your WhatsApp Linked Devices:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ Local authentication successful. Waiting for ready...');
});

client.on('ready', () => {
  console.log('\n✅ LocalAuth session is ready and written to .wwebjs_auth/session-bot-session');
  console.log('➡️ Next step in another terminal: npm run auth:upload');
  console.log('🛑 Then press Ctrl+C here after upload completes.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Local auth failed:', msg);
});

client.on('disconnected', (reason) => {
  console.log('⚠️ LocalAuth client disconnected:', reason);
});

process.on('SIGINT', async () => {
  console.log('\n🧹 Shutting down LocalAuth bootstrap...');
  try {
    await client.destroy();
  } catch (_) {}
  process.exit(0);
});

client.initialize().catch((err) => {
  console.error('❌ Failed to initialize LocalAuth bootstrap:', err);
  process.exit(1);
});
