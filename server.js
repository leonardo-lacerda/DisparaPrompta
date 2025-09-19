const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { DisconnectReason, useMultiFileAuthState, makeWASocket } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const multer = require('multer');
const csvParser = require('csv-parser');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const cron = require('node-cron');
const P = require('pino');

// Configuração do app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Logger
const logger = P({ level: 'info' });

// Configurações globais
let sock = null;
let isConnected = false;
let messageQueue = [];
let currentConfig = {
  delay: 5000,
  startTime: null,
  isRunning: false
};

const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Função para inicializar WhatsApp com Baileys
async function initWhatsApp() {
  try {
    logger.info('🔄 Iniciando WhatsApp (Railway + Baileys)...');

    // Criar diretório de auth se não existir
    const authDir = 'auth_info_baileys';
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // NÃO imprimir no terminal
      logger: P({ level: 'silent' }), // Reduzir logs
      browser: ['Disparador Railway', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    // Event listener para conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr !== undefined) {
        logger.info('📱 QR Code gerado para interface web');
        
        try {
          // Gerar QR Code como Data URL
          const qrCodeDataURL = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#FFFFFF'
            }
          });

          // Enviar QR Code via WebSocket para todos os clientes conectados
          io.emit('qr-code', {
            qr: qrCodeDataURL,
            message: 'Escaneie o QR Code com seu WhatsApp'
          });

          logger.info('✅ QR Code enviado para interface web');

        } catch (error) {
          logger.error('❌ Erro ao gerar QR Code:', error);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        logger.info(`❌ Conexão fechada: ${lastDisconnect.error}`);
        
        if (shouldReconnect) {
          logger.info('🔄 Reconectando em 5 segundos...');
          setTimeout(initWhatsApp, 5000);
        } else {
          logger.info('🚪 Deslogado - necessário novo QR Code');
          io.emit('disconnected', { message: 'Deslogado do WhatsApp' });
        }
        
        isConnected = false;
        io.emit('connection-status', { connected: false });

      } else if (connection === 'open') {
        logger.info('✅ WhatsApp conectado com sucesso!');
        isConnected = true;
        
        // Notificar todos os clientes sobre a conexão
        io.emit('connected', { 
          message: 'WhatsApp conectado com sucesso!',
          user: sock.user
        });
        io.emit('connection-status', { connected: true });
      }
    });

    // Salvar credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Event listener para mensagens (opcional - para logs)
    sock.ev.on('messages.upsert', (m) => {
      // Log básico de mensagens recebidas (opcional)
      if (m.messages && m.messages[0]) {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
          logger.info(`📨 Nova mensagem recebida de: ${msg.key.remoteJid}`);
        }
      }
    });

    return sock;

  } catch (error) {
    logger.error('❌ Erro ao inicializar WhatsApp:', error);
    
    // Notificar erro via WebSocket
    io.emit('connection-error', {
      message: 'Erro ao conectar WhatsApp',
      error: error.message
    });
    
    return null;
  }
}

// Função para processar CSV
function processCSV(filePath) {
  return new Promise((resolve, reject) => {
    const contacts = [];
    
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (data) => {
        if (data.numero || data.number) {
          contacts.push({
            nome: data.nome || data.name || 'Contato',
            numero: (data.numero || data.number).replace(/\D/g, ''),
            mensagem: data.mensagem || data.message || null
          });
        }
      })
      .on('end', () => {
        logger.info(`📋 ${contacts.length} contatos carregados do CSV`);
        resolve(contacts);
      })
      .on('error', reject);
  });
}

// Função para enviar mensagem
async function sendMessage(numero, mensagem, nome = 'Contato') {
  try {
    if (!sock || !isConnected) {
      throw new Error('WhatsApp não conectado');
    }

    const phoneNumber = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    const finalMessage = mensagem.replace(/{nome}/g, nome).replace(/{name}/g, nome);

    await sock.sendMessage(phoneNumber, { text: finalMessage });
    
    logger.info(`✅ Mensagem enviada para ${nome} (${numero})`);
    
    // Notificar via WebSocket
    io.emit('message-sent', {
      success: true,
      contact: nome,
      number: numero,
      message: 'Mensagem enviada com sucesso'
    });

    return { success: true, contact: nome, number: numero };

  } catch (error) {
    logger.error(`❌ Erro ao enviar para ${nome} (${numero}):`, error.message);
    
    // Notificar erro via WebSocket
    io.emit('message-error', {
      success: false,
      contact: nome,
      number: numero,
      error: error.message
    });

    return { success: false, contact: nome, number: numero, error: error.message };
  }
}

// Função para processar fila de mensagens
async function processMessageQueue() {
  if (messageQueue.length === 0 || !currentConfig.isRunning) {
    return;
  }

  const message = messageQueue.shift();
  const result = await sendMessage(message.numero, message.mensagem, message.nome);

  // Atualizar progresso via WebSocket
  io.emit('queue-progress', {
    remaining: messageQueue.length,
    total: messageQueue.length + 1,
    current: message,
    result: result
  });

  if (messageQueue.length > 0) {
    logger.info(`⏳ Aguardando ${currentConfig.delay}ms antes da próxima mensagem...`);
    setTimeout(processMessageQueue, currentConfig.delay);
  } else {
    logger.info('🎉 Todos os disparos foram concluídos!');
    currentConfig.isRunning = false;
    
    io.emit('queue-finished', {
      message: 'Todos os disparos foram concluídos!'
    });
  }
}

// Função para agendar disparo
function scheduleDispatch(contacts, message, delay, startTime) {
  currentConfig.delay = delay;
  currentConfig.startTime = startTime;

  messageQueue = contacts.map(contact => ({
    nome: contact.nome,
    numero: contact.numero,
    mensagem: contact.mensagem || message
  }));

  const [hour, minute] = startTime.split(':');
  const cronExpression = `${minute} ${hour} * * *`;

  cron.schedule(cronExpression, () => {
    logger.info(`🚀 Iniciando disparo agendado às ${startTime}`);
    currentConfig.isRunning = true;
    
    io.emit('schedule-started', {
      message: `Disparo iniciado às ${startTime}`,
      queueLength: messageQueue.length
    });
    
    processMessageQueue();
  }, {
    timezone: 'America/Sao_Paulo'
  });

  logger.info(`📅 Disparo agendado para ${startTime} (Brasília) com ${messageQueue.length} mensagens`);
}

// ROTAS DA API

// Status da conexão
app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    queueLength: messageQueue.length,
    isRunning: currentConfig.isRunning,
    user: sock?.user || null
  });
});

// Upload e processamento do CSV
app.post('/api/upload', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo CSV não enviado' });
    }

    const { message, delay, startTime } = req.body;

    if (!message || !delay || !startTime) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios não fornecidos' });
    }

    const contacts = await processCSV(req.file.path);

    if (contacts.length === 0) {
      return res.status(400).json({ error: 'Nenhum contato válido encontrado no CSV' });
    }

    scheduleDispatch(contacts, message, parseInt(delay) * 1000, startTime);

    // Limpar arquivo temporário
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      contactsCount: contacts.length,
      message: `Disparo agendado para ${startTime} com ${contacts.length} contatos`
    });

  } catch (error) {
    logger.error('❌ Erro no upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// Iniciar disparo imediato
app.post('/api/start-now', (req, res) => {
  if (messageQueue.length === 0) {
    return res.status(400).json({ error: 'Nenhuma mensagem na fila' });
  }

  if (currentConfig.isRunning) {
    return res.status(400).json({ error: 'Disparo já está em execução' });
  }

  logger.info('🚀 Iniciando disparo imediato');
  currentConfig.isRunning = true;
  processMessageQueue();

  res.json({ success: true, message: 'Disparo iniciado' });
});

// Parar disparo
app.post('/api/stop', (req, res) => {
  currentConfig.isRunning = false;
  messageQueue = []; // Limpar fila
  
  io.emit('queue-stopped', { message: 'Disparo interrompido' });
  
  res.json({ success: true, message: 'Disparo interrompido' });
});

// Reconectar WhatsApp
app.post('/api/reconnect', async (req, res) => {
  logger.info('🔄 Forçando reconexão...');
  
  if (sock) {
    try {
      await sock.logout();
    } catch (error) {
      logger.error('Erro ao deslogar:', error);
    }
  }
  
  setTimeout(initWhatsApp, 2000);
  res.json({ success: true, message: 'Reconexão iniciada' });
});

// Servir página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket eventos
io.on('connection', (socket) => {
  logger.info('🔌 Cliente conectado via WebSocket');

  // Enviar status atual para novo cliente
  socket.emit('connection-status', { connected: isConnected });
  
  if (messageQueue.length > 0) {
    socket.emit('queue-status', {
      queueLength: messageQueue.length,
      isRunning: currentConfig.isRunning
    });
  }

  socket.on('disconnect', () => {
    logger.info('🔌 Cliente desconectado do WebSocket');
  });

  // Permitir que cliente solicite reconexão
  socket.on('request-reconnect', () => {
    logger.info('🔄 Reconexão solicitada via WebSocket');
    if (sock) {
      sock.logout().catch(() => {});
    }
    setTimeout(initWhatsApp, 2000);
  });
});

// Iniciar servidor
server.listen(PORT, async () => {
  logger.info(`🌐 Servidor rodando na porta ${PORT}`);
  logger.info('🚀 Sistema otimizado para Railway');
  logger.info('📱 QR Code será exibido na interface web');
  logger.info('🔗 WebSockets ativo para atualizações em tempo real');

  // Inicializar WhatsApp
  await initWhatsApp();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('🛑 Recebido SIGTERM, fechando servidor...');
  server.close(() => {
    logger.info('✅ Servidor fechado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('🛑 Recebido SIGINT, fechando servidor...');
  server.close(() => {
    logger.info('✅ Servidor fechado');
    process.exit(0);
  });
});
