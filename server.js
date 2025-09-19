const express = require('express');
const wppconnect = require('@wppconnect-team/wppconnect');
const multer = require('multer');
const csvParser = require('csv-parser');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const cron = require('node-cron');

const app = express();
const PORT = 3000;

// Configurações
let client = null;
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

// Inicializar WhatsApp com configurações corrigidas
async function initWhatsApp() {
  try {
    console.log('🔄 Iniciando conexão com WhatsApp...');
    
    // Criar pasta tokens se não existir
    const tokensPath = path.join(__dirname, 'tokens');
    if (!fs.existsSync(tokensPath)) {
      fs.mkdirSync(tokensPath, { recursive: true });
    }

    client = await wppconnect.create({
      session: 'disparador',
      
      // CONFIGURAÇÕES CRÍTICAS PARA QR CODE
      headless: false,        // IMPORTANTE: false para mostrar QR
      devtools: false,
      useChrome: true,        // Usar Chrome ao invés do Chromium
      debug: false,
      logQR: true,           // IMPORTANTE: true para mostrar QR no terminal
      disableWelcome: true,
      updatesLog: true,
      autoClose: 0,          // IMPORTANTE: 0 para não fechar automaticamente
      
      // Configurações de pasta
      folderNameToken: './tokens',
      createPathFileToken: true,
      tokenStore: 'file',
      
      // Configurações do browser
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-plugins'
      ],
      
      puppeteerOptions: {
        headless: false,     // IMPORTANTE: false aqui também
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ],
        timeout: 60000
      },

      // Callback para capturar QR Code
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        console.log('\n🔥🔥🔥 QR CODE DETECTADO 🔥🔥🔥');
        console.log(`📱 Tentativa ${attempts}/3`);
        console.log('🔗 URL do QR Code:', urlCode);
        console.log('\n📋 ESCANEIE O QR CODE ABAIXO:\n');
        console.log(asciiQR);
        console.log('\n🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n');
        
        // Salvar QR como imagem também
        if (base64Qr) {
          const qrPath = path.join(__dirname, 'qr-code.png');
          const base64Data = base64Qr.replace(/^data:image\/png;base64,/, '');
          try {
            fs.writeFileSync(qrPath, base64Data, 'base64');
            console.log(`💾 QR Code salvo em: ${qrPath}`);
          } catch (err) {
            console.error('❌ Erro ao salvar QR:', err.message);
          }
        }
      },

      statusFind: (statusSession, session) => {
        console.log(`📊 Status da Sessão '${session}': ${statusSession}`);
        
        switch(statusSession) {
          case 'isLogged':
            isConnected = true;
            console.log('✅ WhatsApp conectado com sucesso!');
            break;
          case 'notLogged':
            isConnected = false;
            console.log('❌ WhatsApp desconectado - aguardando QR Code...');
            break;
          case 'qrReadSuccess':
            console.log('📱 QR Code lido com sucesso!');
            break;
          case 'qrReadFail':
            console.log('❌ Falha ao ler QR Code - gerando novo...');
            break;
          case 'browserClose':
            isConnected = false;
            console.log('❌ Browser fechado');
            break;
          default:
            console.log(`ℹ️ Status: ${statusSession}`);
        }
      }
    });

    console.log('✅ Cliente WhatsApp inicializado');
    return client;

  } catch (error) {
    console.error('❌ Erro ao conectar WhatsApp:', error);
    return null;
  }
}

// Processar CSV
function processCSV(filePath) {
  return new Promise((resolve, reject) => {
    const contacts = [];
    
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (data) => {
        // Esperado: nome, numero, mensagem (opcional)
        if (data.numero || data.number) {
          contacts.push({
            nome: data.nome || data.name || 'Contato',
            numero: (data.numero || data.number).replace(/\D/g, ''),
            mensagem: data.mensagem || data.message || null
          });
        }
      })
      .on('end', () => {
        console.log(`📋 ${contacts.length} contatos carregados do CSV`);
        resolve(contacts);
      })
      .on('error', reject);
  });
}

// Enviar mensagem com delay
async function sendMessage(numero, mensagem, nome = 'Contato') {
  try {
    if (!client || !isConnected) {
      throw new Error('WhatsApp não conectado');
    }

    const phoneNumber = numero.includes('@') ? numero : `${numero}@c.us`;
    
    // Personalizar mensagem com nome se necessário
    const finalMessage = mensagem.replace('{nome}', nome).replace('{name}', nome);
    
    await client.sendText(phoneNumber, finalMessage);
    console.log(`✅ Mensagem enviada para ${nome} (${numero})`);
    
    return { success: true, contact: nome, number: numero };
  } catch (error) {
    console.error(`❌ Erro ao enviar para ${nome} (${numero}):`, error.message);
    return { success: false, contact: nome, number: numero, error: error.message };
  }
}

// Processar fila de mensagens
async function processMessageQueue() {
  if (messageQueue.length === 0 || !currentConfig.isRunning) {
    return;
  }

  const message = messageQueue.shift();
  const result = await sendMessage(message.numero, message.mensagem, message.nome);
  
  // Aguardar delay antes da próxima mensagem
  if (messageQueue.length > 0) {
    console.log(`⏳ Aguardando ${currentConfig.delay}ms antes da próxima mensagem...`);
    setTimeout(processMessageQueue, currentConfig.delay);
  } else {
    console.log('🎉 Todos os disparos foram concluídos!');
    currentConfig.isRunning = false;
  }
}

// Agendar disparo
function scheduleDispatch(contacts, message, delay, startTime) {
  currentConfig.delay = delay;
  currentConfig.startTime = startTime;
  
  // Preparar fila de mensagens
  messageQueue = contacts.map(contact => ({
    nome: contact.nome,
    numero: contact.numero,
    mensagem: contact.mensagem || message
  }));

  const [hour, minute] = startTime.split(':');
  
  // Usar cron para agendar no horário de Brasília
  const cronExpression = `${minute} ${hour} * * *`;
  
  cron.schedule(cronExpression, () => {
    console.log(`🚀 Iniciando disparo agendado às ${startTime}`);
    currentConfig.isRunning = true;
    processMessageQueue();
  }, {
    timezone: 'America/Sao_Paulo'
  });

  console.log(`📅 Disparo agendado para ${startTime} (horário de Brasília)`);
  console.log(`📊 ${messageQueue.length} mensagens na fila`);
}

// ROTAS DA API

// Status da conexão
app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    queueLength: messageQueue.length,
    isRunning: currentConfig.isRunning
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

    // Processar CSV
    const contacts = await processCSV(req.file.path);
    
    if (contacts.length === 0) {
      return res.status(400).json({ error: 'Nenhum contato válido encontrado no CSV' });
    }

    // Agendar disparo
    scheduleDispatch(contacts, message, parseInt(delay) * 1000, startTime);
    
    // Limpar arquivo temporário
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      contactsCount: contacts.length,
      message: `Disparo agendado para ${startTime} com ${contacts.length} contatos`
    });

  } catch (error) {
    console.error('Erro no upload:', error);
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

  console.log('🚀 Iniciando disparo imediato');
  currentConfig.isRunning = true;
  processMessageQueue();

  res.json({ success: true, message: 'Disparo iniciado' });
});

// Parar disparo
app.post('/api/stop', (req, res) => {
  currentConfig.isRunning = false;
  res.json({ success: true, message: 'Disparo interrompido' });
});

// Servir página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`🌐 Servidor rodando em http://localhost:${PORT}`);
  await initWhatsApp();
});
